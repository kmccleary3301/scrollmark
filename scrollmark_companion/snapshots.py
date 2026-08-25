"""Verified canonical snapshot publication, restore, and rotation.

Snapshots are immutable filesystem artifacts. The active SQLite database is
never treated as replaced until the selected candidate has passed byte,
logical, SQLite, archive, namespace, checkpoint, and journal-chain checks.
"""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import shutil
import sqlite3
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Set, Tuple

from .contract_runtime import ZERO_HASH, batch_hash, canonical_bytes, chain_hash, record_hash, sha256_hex
from .errors import CompanionError
from .snapshot_crypto import (
    MacOSKeychainSnapshotKeyStore,
    SnapshotKeyStore,
    aes256_gcm_decrypt,
    aes256_gcm_encrypt,
    decode_recovery_key,
    write_recovery_key,
)
from .store import PROTOCOL, SCHEMA_REVISION, CanonicalArchiveStore

SNAPSHOT_FORMAT = "twe.snapshot.v1"
MANIFEST_VERSION = 1
VERIFIER_VERSION = "scrollmark-snapshot-verifier-1"
IMAGE_PLAINTEXT = "canonical.sqlite"
IMAGE_ENCRYPTED = "canonical.sqlite.enc"
MARKER = "VERIFIED"
AUDIT_FILE = ".restore-audit.jsonl"
CANONICAL_TABLES = (
    "companion_meta",
    "namespaces",
    "archive_state",
    "clients",
    "checkpoints",
    "batches",
    "journal",
    "state_records",
    "operation_audit",
)
JSON_COLUMNS = {"binding_json", "receipt_json", "mutation_json", "details_json"}


class SnapshotError(CompanionError):
    pass


def _snapshot_error(code: str, message: str, *, observed: Optional[Dict[str, Any]] = None) -> SnapshotError:
    return SnapshotError(code, message, retryable=False, observed=observed)


def _now_ms() -> int:
    return int(time.time() * 1000)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while True:
            chunk = source.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _fsync_file(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _write_bytes(path: Path, value: bytes, mode: int = 0o600) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        view = memoryview(value)
        while view:
            written = os.write(descriptor, view)
            view = view[written:]
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _write_json(path: Path, value: Mapping[str, Any]) -> None:
    _write_bytes(path, canonical_bytes(value) + b"\n")


def _read_manifest(path: Path) -> Dict[str, Any]:
    try:
        raw = path.read_bytes()
        if len(raw) > 4 * 1024 * 1024:
            raise ValueError("manifest exceeds the verification limit")
        value = json.loads(raw.decode("utf-8"))
    except Exception as error:
        raise _snapshot_error("snapshot_corrupt", "snapshot manifest is unreadable") from error
    if not isinstance(value, dict):
        raise _snapshot_error("snapshot_corrupt", "snapshot manifest is not an object")
    return value


def _manifest_payload(manifest: Mapping[str, Any]) -> Dict[str, Any]:
    return {
        key: value
        for key, value in manifest.items()
        if key not in {"manifest_payload_hash", "verified_at_ms", "verification"}
    }


def _safe_json(value: Any) -> Any:
    if isinstance(value, bytes):
        return {"bytes_sha256": hashlib.sha256(value).hexdigest(), "bytes_length": len(value)}
    return value


def _logical_table(connection: sqlite3.Connection, table: str) -> Dict[str, Any]:
    columns = connection.execute("PRAGMA table_info(%s)" % table).fetchall()
    if not columns:
        raise _snapshot_error("snapshot_incompatible", "snapshot canonical table is missing", observed={"table": table})
    names = [str(column[1]) for column in columns]
    primary = [str(column[1]) for column in sorted(columns, key=lambda item: int(item[5])) if int(column[5])]
    order = primary or names
    quoted_order = ", ".join('"%s"' % name.replace('"', '""') for name in order)
    rows = connection.execute('SELECT * FROM "%s" ORDER BY %s' % (table, quoted_order))
    schema_row = connection.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)
    ).fetchone()
    schema_sql = str(schema_row[0] or "") if schema_row else ""
    digest = hashlib.sha256()
    byte_count = 0
    framing = canonical_bytes({"table": table, "schema_sql": schema_sql}) + b"\n"
    digest.update(framing)
    byte_count += len(framing)
    row_count = 0
    for row in rows:
        row_count += 1
        material: Dict[str, Any] = {}
        for name in names:
            value = row[name]
            if name in JSON_COLUMNS and isinstance(value, str):
                try:
                    value = json.loads(value)
                except json.JSONDecodeError as error:
                    raise _snapshot_error(
                        "snapshot_corrupt",
                        "snapshot canonical JSON column is invalid",
                        observed={"table": table, "column": name},
                    ) from error
            material[name] = _safe_json(value)
        encoded = canonical_bytes(material) + b"\n"
        digest.update(encoded)
        byte_count += len(encoded)
    return {
        "table": table,
        "schema_id": hashlib.sha256(schema_sql.encode("utf-8")).hexdigest(),
        "row_count": row_count,
        "canonical_bytes": byte_count,
        "sha256": digest.hexdigest(),
    }


def _integrity_checks(connection: sqlite3.Connection) -> None:
    integrity = [str(row[0]) for row in connection.execute("PRAGMA integrity_check").fetchall()]
    if integrity != ["ok"]:
        raise _snapshot_error("snapshot_corrupt", "snapshot SQLite integrity check failed")
    foreign = connection.execute("PRAGMA foreign_key_check").fetchall()
    if foreign:
        raise _snapshot_error("snapshot_corrupt", "snapshot SQLite foreign-key check failed")


def _verify_journal(connection: sqlite3.Connection, namespace_id: str) -> Dict[str, Any]:
    state = connection.execute(
        "SELECT next_archive_seq, chain_hash, retained_from FROM archive_state WHERE namespace_id = ?",
        (namespace_id,),
    ).fetchone()
    if state is None:
        raise _snapshot_error("snapshot_corrupt", "snapshot namespace archive state is missing")
    prior = ZERO_HASH
    expected_sequence = 1
    batches = connection.execute(
        """
        SELECT batch_id, batch_hash, archive_from, archive_to, prior_chain_hash,
               chain_hash, mutation_count
        FROM batches WHERE namespace_id = ? ORDER BY archive_from
        """,
        (namespace_id,),
    )
    for row in batches:
        if int(row["archive_from"]) != expected_sequence:
            raise _snapshot_error("snapshot_corrupt", "snapshot archive sequence is not contiguous")
        if row["prior_chain_hash"] != prior:
            raise _snapshot_error("snapshot_corrupt", "snapshot journal prior chain hash is invalid")
        expected = chain_hash(
            namespace_id,
            row["prior_chain_hash"],
            row["batch_hash"],
            int(row["archive_from"]),
            int(row["archive_to"]),
            SCHEMA_REVISION,
        )
        if expected != row["chain_hash"]:
            raise _snapshot_error("snapshot_corrupt", "snapshot journal chain hash is invalid")
        expected_count = int(row["archive_to"]) - int(row["archive_from"]) + 1
        if expected_count != int(row["mutation_count"]):
            raise _snapshot_error("snapshot_corrupt", "snapshot receipt range count is invalid")
        prior = row["chain_hash"]
        expected_sequence = int(row["archive_to"]) + 1
    journal = connection.execute(
        "SELECT archive_seq, mutation_json, record_hash FROM journal WHERE namespace_id = ? ORDER BY archive_seq",
        (namespace_id,),
    )
    journal_count = 0
    for sequence, row in enumerate(journal, 1):
        journal_count = sequence
        if int(row["archive_seq"]) != sequence:
            raise _snapshot_error("snapshot_corrupt", "snapshot journal row sequence is invalid")
        try:
            mutation = json.loads(row["mutation_json"])
        except json.JSONDecodeError as error:
            raise _snapshot_error("snapshot_corrupt", "snapshot journal mutation is invalid") from error
        if record_hash(namespace_id, mutation) != row["record_hash"]:
            raise _snapshot_error("snapshot_corrupt", "snapshot journal record hash is invalid")
    if journal_count != int(state["next_archive_seq"]):
        raise _snapshot_error("snapshot_corrupt", "snapshot journal row count differs from archive head")
    if int(state["next_archive_seq"]) != expected_sequence - 1 or state["chain_hash"] != prior:
        raise _snapshot_error("snapshot_corrupt", "snapshot archive head does not match journal chain")
    checkpoint = connection.execute(
        "SELECT archive_seq, chain_hash, schema_revision FROM checkpoints WHERE namespace_id = ? ORDER BY archive_seq DESC LIMIT 1",
        (namespace_id,),
    ).fetchone()
    if checkpoint is None:
        raise _snapshot_error("snapshot_corrupt", "snapshot checkpoint is missing")
    if int(checkpoint["archive_seq"]) != int(state["next_archive_seq"]) or checkpoint["chain_hash"] != state["chain_hash"]:
        raise _snapshot_error("snapshot_corrupt", "snapshot checkpoint differs from archive head")
    return {
        "journal_first_seq": 1 if journal_count else 0,
        "journal_last_seq": int(state["next_archive_seq"]),
        "checkpoint_seq": int(checkpoint["archive_seq"]),
        "checkpoint_chain_hash": checkpoint["chain_hash"],
        "retained_from": int(state["retained_from"]),
    }


def _connection(path: Path, *, readonly: bool) -> sqlite3.Connection:
    if readonly:
        connection = sqlite3.connect("file:%s?mode=ro" % path.resolve().as_posix(), uri=True)
    else:
        connection = sqlite3.connect(str(path), isolation_level=None)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def _snapshot_aad(snapshot_id: str) -> bytes:
    return (SNAPSHOT_FORMAT + ":" + snapshot_id).encode("utf-8")


def _summary(manifest: Mapping[str, Any]) -> Dict[str, Any]:
    return {
        "format": manifest["format"],
        "snapshot_id": manifest["snapshot_id"],
        "archive_id": manifest["archive_id"],
        "created_at_ms": manifest["created_at_ms"],
        "verified_at_ms": manifest["verified_at_ms"],
        "namespaces": manifest["namespaces"],
        "image": manifest["image"],
        "encryption": manifest["encryption"],
        "verification": manifest["verification"],
        "manifest_payload_hash": manifest["manifest_payload_hash"],
    }


class SnapshotManager:
    def __init__(
        self,
        store: CanonicalArchiveStore,
        root: Path,
        *,
        key_store: Optional[SnapshotKeyStore] = None,
        clock=_now_ms,
    ) -> None:
        if str(store.db_path) == ":memory:":
            raise ValueError("snapshots require a filesystem-backed canonical database")
        self.store = store
        self.root = Path(root).expanduser().resolve()
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.root, 0o700)
        self.key_store = key_store
        self.clock = clock

    def _instance_id_locked(self) -> str:
        row = self.store._connection.execute(
            "SELECT value FROM companion_meta WHERE key = 'companion_instance_id'"
        ).fetchone()
        if row:
            return str(row[0])
        instance_id = "instance-" + secrets.token_hex(16)
        self.store._connection.execute(
            "INSERT INTO companion_meta(key, value) VALUES('companion_instance_id', ?)",
            (instance_id,),
        )
        return instance_id

    def _snapshot_namespaces(self, connection: sqlite3.Connection) -> List[Dict[str, Any]]:
        result: List[Dict[str, Any]] = []
        rows = connection.execute(
            "SELECT namespace_id, state, binding_json FROM namespaces ORDER BY namespace_id"
        ).fetchall()
        for row in rows:
            proof = _verify_journal(connection, str(row["namespace_id"]))
            binding = str(row["binding_json"] or "")
            result.append(
                {
                    "namespace_id": row["namespace_id"],
                    "identity_fingerprint": hashlib.sha256(binding.encode("utf-8")).hexdigest()[:24],
                    "schema_revision": SCHEMA_REVISION,
                    "state": row["state"],
                    **proof,
                }
            )
        return result

    def _sanitize_backup(self, path: Path) -> None:
        connection = _connection(path, readonly=False)
        try:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute("DELETE FROM stream_pages")
            connection.execute("DELETE FROM streams")
            connection.execute("COMMIT")
            connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            connection.execute("PRAGMA journal_mode=DELETE")
            _integrity_checks(connection)
        finally:
            connection.close()
        for suffix in ("-wal", "-shm"):
            sidecar = Path(str(path) + suffix)
            if sidecar.exists():
                sidecar.unlink()

    def create(
        self,
        *,
        encrypted: bool = False,
        recovery_key_path: Optional[Path] = None,
    ) -> Dict[str, Any]:
        snapshot_id = "snapshot-" + str(self.clock()) + "-" + secrets.token_hex(8)
        temporary = self.root / ("." + snapshot_id + ".tmp-" + secrets.token_hex(6))
        final = self.root / snapshot_id
        if final.exists():
            raise _snapshot_error("validation_failed", "snapshot identity already exists")
        temporary.mkdir(mode=0o700)
        plaintext = temporary / IMAGE_PLAINTEXT
        key: Optional[bytes] = None
        try:
            with self.store._lock:
                self.store._hit_failpoint("snapshot_before_backup")
                self.store._connection.execute("PRAGMA wal_checkpoint(FULL)")
                destination = sqlite3.connect(str(plaintext))
                try:
                    self.store._connection.backup(destination)
                finally:
                    destination.close()
                instance_id = self._instance_id_locked()
                self.store._hit_failpoint("snapshot_after_backup")
            self._sanitize_backup(plaintext)
            _fsync_file(plaintext)
            self.store._hit_failpoint("snapshot_after_image_fsync")

            image_path = plaintext
            encryption: Dict[str, Any] = {"mode": "plaintext", "algorithm": None, "key_id": None}
            if encrypted:
                if self.key_store is None:
                    raise _snapshot_error("snapshot_key_unavailable", "snapshot encryption key store is unavailable")
                key = secrets.token_bytes(32)
                key_id = "snapshot-key-" + secrets.token_hex(16)
                self.key_store.put(key_id, key)
                if recovery_key_path is not None:
                    write_recovery_key(Path(recovery_key_path).expanduser(), key)
                encrypted_path = temporary / IMAGE_ENCRYPTED
                _write_bytes(
                    encrypted_path,
                    aes256_gcm_encrypt(key, plaintext.read_bytes(), _snapshot_aad(snapshot_id)),
                )
                plaintext.unlink()
                image_path = encrypted_path
                encryption = {
                    "mode": "aes-256-gcm",
                    "algorithm": "AES-256-GCM",
                    "key_id": key_id,
                    "aad": SNAPSHOT_FORMAT + ":" + snapshot_id,
                    "key_storage": "macos-keychain" if isinstance(self.key_store, MacOSKeychainSnapshotKeyStore) else "external-provider",
                }
                self.store._hit_failpoint("snapshot_after_encryption_cleanup")

            verification_image = self._materialize_image(
                image_path,
                snapshot_id=snapshot_id,
                encryption=encryption,
                key_override=key,
            )
            try:
                connection = _connection(verification_image, readonly=True)
                try:
                    _integrity_checks(connection)
                    archive_row = connection.execute(
                        "SELECT value FROM companion_meta WHERE key = 'archive_id'"
                    ).fetchone()
                    if archive_row is None:
                        raise _snapshot_error("snapshot_corrupt", "snapshot archive identity is missing")
                    namespaces = self._snapshot_namespaces(connection)
                    tables = [_logical_table(connection, table) for table in CANONICAL_TABLES]
                finally:
                    connection.close()
            finally:
                if verification_image != image_path:
                    verification_image.unlink(missing_ok=True)

            created_at = self.clock()
            manifest: Dict[str, Any] = {
                "format": SNAPSHOT_FORMAT,
                "manifest_version": MANIFEST_VERSION,
                "protocol_version": dict(PROTOCOL),
                "schema_revision": SCHEMA_REVISION,
                "archive_id": self.store.archive_id,
                "snapshot_id": snapshot_id,
                "created_at_ms": created_at,
                "source_companion_instance_id": instance_id,
                "namespaces": namespaces,
                "tables": tables,
                "image": {
                    "path": image_path.name,
                    "bytes": image_path.stat().st_size,
                    "sha256": _sha256_file(image_path),
                    "mode": encryption["mode"],
                },
                "media": {
                    "mode": "references_only",
                    "reference_count": sum(
                        table["row_count"] for table in tables if table["table"] == "state_records"
                    ),
                    "mirrored_blob_count": 0,
                    "missing_count": 0,
                    "manifest_hash": None,
                },
                "encryption": encryption,
                "verified_at_ms": self.clock(),
                "verification": {
                    "state": "verified",
                    "verifier_version": VERIFIER_VERSION,
                    "checks": [
                        "image-sha256",
                        "sqlite-integrity",
                        "sqlite-foreign-keys",
                        "logical-table-hashes",
                        "archive-namespace-binding",
                        "journal-chain",
                        "checkpoint-head",
                    ],
                    "failures": [],
                },
            }
            manifest["manifest_payload_hash"] = sha256_hex(_manifest_payload(manifest))
            _write_json(temporary / "manifest.json", manifest)
            self.store._hit_failpoint("snapshot_before_manifest_verification")
            self.verify(temporary, require_marker=False, key_override=key)
            self.store._hit_failpoint("snapshot_after_manifest_verification")
            _write_bytes(temporary / MARKER, (manifest["manifest_payload_hash"] + "\n").encode("ascii"))
            self.store._hit_failpoint("snapshot_after_marker")
            _fsync_directory(temporary)
            os.replace(temporary, final)
            _fsync_directory(self.root)
            self.store._hit_failpoint("snapshot_after_rename")
            return _summary(manifest)
        except Exception:
            if temporary.exists():
                shutil.rmtree(temporary, ignore_errors=True)
            raise

    def _resolve_key(
        self,
        encryption: Mapping[str, Any],
        *,
        key_override: Optional[bytes],
        recovery_key: Optional[str],
    ) -> bytes:
        if key_override is not None:
            return key_override
        if recovery_key is not None:
            return decode_recovery_key(recovery_key)
        key_id = encryption.get("key_id")
        if not isinstance(key_id, str) or not key_id or self.key_store is None:
            raise _snapshot_error("snapshot_key_unavailable", "snapshot decryption key is unavailable")
        try:
            return self.key_store.get(key_id)
        except Exception as error:
            raise _snapshot_error("snapshot_key_unavailable", "snapshot decryption key is unavailable") from error

    def _materialize_image(
        self,
        image_path: Path,
        *,
        snapshot_id: str,
        encryption: Mapping[str, Any],
        key_override: Optional[bytes] = None,
        recovery_key: Optional[str] = None,
    ) -> Path:
        if encryption.get("mode") == "plaintext":
            return image_path
        if encryption.get("mode") != "aes-256-gcm" or encryption.get("algorithm") != "AES-256-GCM":
            raise _snapshot_error("snapshot_incompatible", "snapshot encryption mode is unsupported")
        key = self._resolve_key(encryption, key_override=key_override, recovery_key=recovery_key)
        try:
            plaintext = aes256_gcm_decrypt(key, image_path.read_bytes(), _snapshot_aad(snapshot_id))
        except SnapshotError:
            raise
        except Exception as error:
            raise _snapshot_error("snapshot_corrupt", "encrypted snapshot authentication failed") from error
        descriptor, name = tempfile.mkstemp(prefix="scrollmark-snapshot-", suffix=".sqlite", dir=str(self.root))
        os.close(descriptor)
        materialized = Path(name)
        os.chmod(materialized, 0o600)
        materialized.write_bytes(plaintext)
        _fsync_file(materialized)
        return materialized

    def verify(
        self,
        snapshot: Path,
        *,
        expected_archive_id: Optional[str] = None,
        expected_namespace_ids: Optional[Iterable[str]] = None,
        require_marker: bool = True,
        recovery_key: Optional[str] = None,
        key_override: Optional[bytes] = None,
    ) -> Dict[str, Any]:
        directory = Path(snapshot).expanduser().resolve()
        try:
            directory.relative_to(self.root)
        except ValueError as error:
            raise _snapshot_error("validation_failed", "snapshot is outside the configured root") from error
        if not directory.is_dir() or directory.is_symlink():
            raise _snapshot_error("snapshot_corrupt", "snapshot directory is missing or unsafe")
        manifest = _read_manifest(directory / "manifest.json")
        if manifest.get("format") != SNAPSHOT_FORMAT or manifest.get("manifest_version") != MANIFEST_VERSION:
            raise _snapshot_error("snapshot_incompatible", "snapshot format is unsupported")
        if manifest.get("protocol_version") != PROTOCOL or manifest.get("schema_revision") != SCHEMA_REVISION:
            raise _snapshot_error("snapshot_incompatible", "snapshot protocol or schema is unsupported")
        snapshot_id = manifest.get("snapshot_id")
        if not isinstance(snapshot_id, str) or snapshot_id != directory.name.lstrip(".").split(".tmp-", 1)[0]:
            raise _snapshot_error("snapshot_corrupt", "snapshot identity is not bound to its directory")
        payload_hash = sha256_hex(_manifest_payload(manifest))
        if manifest.get("manifest_payload_hash") != payload_hash:
            raise _snapshot_error("snapshot_corrupt", "snapshot manifest payload hash is invalid")
        verification = manifest.get("verification")
        if not isinstance(verification, dict) or verification.get("state") != "verified":
            raise _snapshot_error("snapshot_corrupt", "snapshot is not marked verified")
        if require_marker:
            try:
                marker = (directory / MARKER).read_text(encoding="ascii").strip()
            except Exception as error:
                raise _snapshot_error("snapshot_corrupt", "snapshot verified marker is missing") from error
            if marker != payload_hash:
                raise _snapshot_error("snapshot_corrupt", "snapshot verified marker is invalid")
        image = manifest.get("image")
        encryption = manifest.get("encryption")
        if not isinstance(image, dict) or not isinstance(encryption, dict):
            raise _snapshot_error("snapshot_corrupt", "snapshot image metadata is missing")
        image_name = image.get("path")
        if image_name not in {IMAGE_PLAINTEXT, IMAGE_ENCRYPTED}:
            raise _snapshot_error("snapshot_corrupt", "snapshot image path is unsafe")
        image_path = directory / image_name
        if not image_path.is_file() or image_path.is_symlink():
            raise _snapshot_error("snapshot_corrupt", "snapshot image is missing or unsafe")
        if image_path.stat().st_size != image.get("bytes") or _sha256_file(image_path) != image.get("sha256"):
            raise _snapshot_error("snapshot_corrupt", "snapshot image length or hash is invalid")
        materialized = self._materialize_image(
            image_path,
            snapshot_id=snapshot_id,
            encryption=encryption,
            key_override=key_override,
            recovery_key=recovery_key,
        )
        try:
            connection = _connection(materialized, readonly=True)
            try:
                _integrity_checks(connection)
                archive_row = connection.execute(
                    "SELECT value FROM companion_meta WHERE key = 'archive_id'"
                ).fetchone()
                archive_id = str(archive_row[0]) if archive_row else ""
                if archive_id != manifest.get("archive_id"):
                    raise _snapshot_error("snapshot_corrupt", "snapshot archive binding differs from its image")
                if expected_archive_id is not None and archive_id != expected_archive_id:
                    raise _snapshot_error("archive_binding_mismatch", "snapshot belongs to another archive")
                actual_namespaces = self._snapshot_namespaces(connection)
                declared_namespaces = manifest.get("namespaces")
                if actual_namespaces != declared_namespaces:
                    raise _snapshot_error("snapshot_corrupt", "snapshot namespace/checkpoint manifest differs from image")
                actual_ids = {item["namespace_id"] for item in actual_namespaces}
                if expected_namespace_ids is not None and actual_ids != set(expected_namespace_ids):
                    raise _snapshot_error("namespace_not_active", "snapshot namespace set differs from the active archive")
                declared_tables = manifest.get("tables")
                actual_tables = [_logical_table(connection, table) for table in CANONICAL_TABLES]
                if actual_tables != declared_tables:
                    raise _snapshot_error("snapshot_corrupt", "snapshot logical table proof is invalid")
            finally:
                connection.close()
        finally:
            if materialized != image_path:
                materialized.unlink(missing_ok=True)
        return manifest

    def list_verified(self) -> List[Dict[str, Any]]:
        snapshots: List[Dict[str, Any]] = []
        for directory in sorted(self.root.iterdir()):
            if not directory.is_dir() or directory.name.startswith("."):
                continue
            try:
                snapshots.append(_summary(self.verify(directory)))
            except CompanionError:
                continue
        snapshots.sort(key=lambda item: int(item["created_at_ms"]), reverse=True)
        return snapshots

    def _copy_future_history(self, target: sqlite3.Connection) -> None:
        current = self.store._connection
        target_namespaces = {
            str(row[0]) for row in target.execute("SELECT namespace_id FROM namespaces").fetchall()
        }
        current_namespaces = {
            str(row[0]) for row in current.execute("SELECT namespace_id FROM namespaces").fetchall()
        }
        if target_namespaces != current_namespaces:
            raise _snapshot_error("namespace_not_active", "snapshot namespace set differs from the active archive")
        for namespace_id in sorted(target_namespaces):
            target_head = int(
                target.execute(
                    "SELECT next_archive_seq FROM archive_state WHERE namespace_id = ?", (namespace_id,)
                ).fetchone()[0]
            )
            current_archive = current.execute(
                "SELECT * FROM archive_state WHERE namespace_id = ?", (namespace_id,)
            ).fetchone()
            current_head = int(current_archive["next_archive_seq"])
            if current_head < target_head:
                raise _snapshot_error("snapshot_incompatible", "snapshot is newer than the active archive")
            if current_head > target_head:
                for table, predicate, parameters in (
                    ("checkpoints", "namespace_id = ? AND archive_seq > ?", (namespace_id, target_head)),
                    ("batches", "namespace_id = ? AND archive_from > ?", (namespace_id, target_head)),
                    ("journal", "namespace_id = ? AND archive_seq > ?", (namespace_id, target_head)),
                ):
                    columns = [str(row[1]) for row in current.execute("PRAGMA table_info(%s)" % table)]
                    rows = current.execute(
                        "SELECT %s FROM %s WHERE %s ORDER BY rowid" % (", ".join(columns), table, predicate),
                        parameters,
                    )
                    placeholders = ", ".join("?" for _ in columns)
                    target.executemany(
                        "INSERT OR IGNORE INTO %s(%s) VALUES(%s)"
                        % (table, ", ".join(columns), placeholders),
                        (tuple(row[column] for column in columns) for row in rows),
                    )
            client_columns = [str(row[1]) for row in current.execute("PRAGMA table_info(clients)")]
            clients = current.execute(
                "SELECT %s FROM clients WHERE namespace_id = ?" % ", ".join(client_columns),
                (namespace_id,),
            )
            target.executemany(
                "INSERT OR REPLACE INTO clients(%s) VALUES(%s)"
                % (", ".join(client_columns), ", ".join("?" for _ in client_columns)),
                (tuple(row[column] for column in client_columns) for row in clients),
            )
            target.execute(
                """
                UPDATE archive_state
                SET next_archive_seq = ?, chain_hash = ?, retained_from = ?, updated_at_ms = ?
                WHERE namespace_id = ?
                """,
                (
                    current_head,
                    current_archive["chain_hash"],
                    current_archive["retained_from"],
                    self.clock(),
                    namespace_id,
                ),
            )

    def _restore_mutations(
        self,
        snapshot_id: str,
        namespace_id: str,
        snapshot_rows: Iterable[sqlite3.Row],
        current_only_rows: Iterable[sqlite3.Row],
    ) -> Iterable[Dict[str, Any]]:
        for row in snapshot_rows:
            state_key = str(row["state_key"])
            mutation = dict(json.loads(row["mutation_json"]))
            mutation.pop("record_hash", None)
            mutation["mutation_id"] = "restore-" + secrets.token_hex(16)
            mutation["observed_at_ms"] = self.clock()
            mutation["provenance"] = {
                "source": "snapshot-restore-v1",
                "source_event_id": snapshot_id + ":" + state_key,
                "extractor_rev": "snapshot-restore-v1",
            }
            yield mutation
        for row in current_only_rows:
            state_key = str(row["state_key"])
            source = json.loads(row["mutation_json"])
            kind = source.get("kind")
            if kind == "entity_upsert":
                target_kind = source["target"]["kind"]
                target_id = source["target"]["id"]
                relationship_kind = None
            elif kind == "relationship_upsert":
                target_kind = "relationship"
                target_id = state_key.split(":", 1)[1]
                relationship_kind = source.get("relationship_kind")
            elif kind == "enrichment_upsert":
                target_kind = "enrichment"
                target_id = state_key.split(":", 1)[1]
                relationship_kind = None
            else:
                target_kind = source.get("target_kind", "relationship")
                target_id = source.get("target_id", state_key.split(":", 1)[-1])
                relationship_kind = source.get("relationship_kind")
            mutation: Dict[str, Any] = {
                "mutation_id": "restore-" + secrets.token_hex(16),
                "kind": "tombstone",
                "schema_revision": SCHEMA_REVISION,
                "target_kind": target_kind,
                "target_id": target_id,
                "deletion_id": "restore-delete-" + secrets.token_hex(12),
                "provenance": {
                    "source": "snapshot-restore-v1",
                    "source_event_id": snapshot_id + ":delete:" + state_key,
                    "extractor_rev": "snapshot-restore-v1",
                },
                "observed_at_ms": self.clock(),
            }
            if relationship_kind:
                mutation["relationship_kind"] = relationship_kind
            yield mutation

    def _append_restore_batches(self, snapshot_id: str, retained: Path) -> Dict[str, Any]:
        checkpoints: Dict[str, Any] = {}
        batch_limit = self.store.max_mutations_per_batch
        if not retained.is_file():
            raise _snapshot_error("restore_failed", "retained pre-restore archive is missing")
        retained_connection = _connection(retained, readonly=False)
        try:
            namespaces = [
                str(row[0])
                for row in self.store._connection.execute(
                    "SELECT namespace_id FROM namespaces ORDER BY namespace_id"
                ).fetchall()
            ]
            for namespace_id in namespaces:
                def snapshot_rows() -> Iterable[sqlite3.Row]:
                    last_key = ""
                    while True:
                        rows = self.store._connection.execute(
                            """
                            SELECT state_key, mutation_json
                            FROM state_records
                            WHERE namespace_id = ? AND state_key > ?
                            ORDER BY state_key
                            LIMIT ?
                            """,
                            (namespace_id, last_key, batch_limit),
                        ).fetchall()
                        if not rows:
                            break
                        for row in rows:
                            yield row
                        last_key = str(rows[-1]["state_key"])

                def current_only_rows() -> Iterable[sqlite3.Row]:
                    last_key = ""
                    while True:
                        if not retained.is_file():
                            raise _snapshot_error("restore_failed", "retained pre-restore archive disappeared")
                        rows = retained_connection.execute(
                            """
                            SELECT state_key, mutation_json
                            FROM state_records
                            WHERE namespace_id = ? AND state_key > ?
                            ORDER BY state_key
                            LIMIT ?
                            """,
                            (namespace_id, last_key, batch_limit),
                        ).fetchall()
                        if not rows:
                            break
                        placeholders = ", ".join("?" for _ in rows)
                        active_keys = {
                            str(row[0])
                            for row in self.store._connection.execute(
                                """
                                SELECT state_key FROM state_records
                                WHERE namespace_id = ? AND state_key IN (%s)
                                """ % placeholders,
                                (namespace_id, *(str(row["state_key"]) for row in rows)),
                            ).fetchall()
                        }
                        for row in rows:
                            if str(row["state_key"]) not in active_keys:
                                yield row
                        last_key = str(rows[-1]["state_key"])

                client_id = "restore-agent"
                client_epoch = "restore-" + secrets.token_hex(12)
                self.store.admit_client(namespace_id, client_id, client_epoch)
                sequence = 1
                checkpoint = self.store.checkpoint(namespace_id)

                def commit_batch(batch_mutations: List[Dict[str, Any]]) -> None:
                    nonlocal sequence, checkpoint
                    for index, mutation in enumerate(batch_mutations):
                        mutation["client_seq"] = sequence + index
                        material = dict(mutation)
                        material.pop("record_hash", None)
                        mutation["record_hash"] = record_hash(namespace_id, material)
                    batch_id = "restore-batch-" + secrets.token_hex(12)
                    batch = {
                        "batch_id": batch_id,
                        "mutation_count": len(batch_mutations),
                        "mutations": batch_mutations,
                        "batch_hash": batch_hash(namespace_id, {"mutations": batch_mutations}),
                    }
                    receipt = self.store.commit(
                        {
                            "protocol": dict(PROTOCOL),
                            "request_id": "restore-request-" + secrets.token_hex(12),
                            "archive_id": self.store.archive_id,
                            "namespace_id": namespace_id,
                            "client_id": client_id,
                            "client_epoch": client_epoch,
                            "sent_at_ms": self.clock(),
                            "client_sequence": {
                                "from": sequence,
                                "to": sequence + len(batch_mutations) - 1,
                            },
                            "batch": batch,
                            "known_checkpoint": checkpoint,
                        }
                    )
                    sequence += len(batch_mutations)
                    checkpoint = receipt["checkpoint"]

                pending: List[Dict[str, Any]] = []
                mutations = self._restore_mutations(
                    snapshot_id,
                    namespace_id,
                    snapshot_rows(),
                    current_only_rows(),
                )
                for mutation in mutations:
                    pending.append(mutation)
                    if len(pending) == batch_limit:
                        commit_batch(pending)
                        pending = []
                if pending:
                    commit_batch(pending)
                checkpoints[namespace_id] = checkpoint
        finally:
            retained_connection.close()
        return checkpoints

    def _audit(self, operation: str, snapshot_id: str, state: str, details: Mapping[str, Any]) -> None:
        audit_id = "audit-" + secrets.token_hex(16)
        safe_details = dict(details)
        with self.store._lock:
            self.store._connection.execute(
                """
                INSERT INTO operation_audit(
                    audit_id, operation, archive_id, snapshot_id, state, details_json, created_at_ms
                ) VALUES(?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    audit_id,
                    operation,
                    self.store.archive_id,
                    snapshot_id,
                    state,
                    json.dumps(safe_details, sort_keys=True, separators=(",", ":")),
                    self.clock(),
                ),
            )
        record = {
            "audit_id": audit_id,
            "operation": operation,
            "archive_id": self.store.archive_id,
            "snapshot_id": snapshot_id,
            "state": state,
            "details": safe_details,
            "created_at_ms": self.clock(),
        }
        descriptor = os.open(self.root / AUDIT_FILE, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            os.write(descriptor, canonical_bytes(record) + b"\n")
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def restore(
        self,
        snapshot: Path,
        *,
        expected_namespace_ids: Iterable[str],
        recovery_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        manifest = self.verify(
            snapshot,
            expected_archive_id=self.store.archive_id,
            expected_namespace_ids=expected_namespace_ids,
            recovery_key=recovery_key,
        )
        snapshot_id = str(manifest["snapshot_id"])
        directory = Path(snapshot).expanduser().resolve()
        image = manifest["image"]
        materialized = self._materialize_image(
            directory / image["path"],
            snapshot_id=snapshot_id,
            encryption=manifest["encryption"],
            recovery_key=recovery_key,
        )
        staging = self.store.db_path.with_name(
            self.store.db_path.name + ".restore-staging-" + secrets.token_hex(8)
        )
        retained_root = self.store.db_path.parent / ".scrollmark-retained"
        retained_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        retained = retained_root / (
            self.store.db_path.name + ".pre-restore-" + str(self.clock()) + "-" + secrets.token_hex(6)
        )
        failed = retained_root / (
            self.store.db_path.name + ".failed-restore-" + str(self.clock()) + "-" + secrets.token_hex(6)
        )
        shutil.copy2(materialized, staging)
        os.chmod(staging, 0o600)
        _fsync_file(staging)
        if materialized != directory / image["path"]:
            materialized.unlink(missing_ok=True)
        switched = False
        expected_archive_id = self.store.archive_id
        try:
            with self.store._lock:
                self.store._hit_failpoint("restore_before_staging_validation")
                target = _connection(staging, readonly=False)
                try:
                    target.execute("BEGIN IMMEDIATE")
                    self._copy_future_history(target)
                    target.execute("COMMIT")
                    _integrity_checks(target)
                except Exception:
                    if target.in_transaction:
                        target.execute("ROLLBACK")
                    raise
                finally:
                    target.close()
                self.store._hit_failpoint("restore_after_staging_validation")
                self.store._connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                self.store._connection.close()
                for suffix in ("-wal", "-shm"):
                    Path(str(self.store.db_path) + suffix).unlink(missing_ok=True)
                os.replace(self.store.db_path, retained)
                os.replace(staging, self.store.db_path)
                _fsync_directory(self.store.db_path.parent)
                switched = True
                self.store._reopen_connection_locked(expected_archive_id)
                self.store._hit_failpoint("restore_after_active_switch")
            checkpoints = self._append_restore_batches(snapshot_id, retained)
            self.store._hit_failpoint("restore_post_switch_health")
            health = self.store.health()
            if not health["ready"] or set(health["active_namespace_ids"]) != set(expected_namespace_ids):
                raise _snapshot_error("restore_failed", "restored archive failed post-switch health")
            self._audit(
                "snapshot_restore",
                snapshot_id,
                "restored",
                {
                    "retained_previous": retained.name,
                    "checkpoints": checkpoints,
                    "rewind": True,
                },
            )
            return {
                "snapshot_id": snapshot_id,
                "archive_id": self.store.archive_id,
                "state": "restored",
                "checkpoints": checkpoints,
                "retained_previous": retained.name,
            }
        except Exception as error:
            if switched:
                with self.store._lock:
                    try:
                        self.store._connection.close()
                    except Exception:
                        pass
                    if self.store.db_path.exists():
                        os.replace(self.store.db_path, failed)
                    os.replace(retained, self.store.db_path)
                    self.store._reopen_connection_locked(expected_archive_id)
                    _fsync_directory(self.store.db_path.parent)
                try:
                    self._audit(
                        "snapshot_restore",
                        snapshot_id,
                        "restore_failed",
                        {"failed_candidate": failed.name, "reason": type(error).__name__},
                    )
                except Exception:
                    pass
            staging.unlink(missing_ok=True)
            if isinstance(error, CompanionError):
                raise
            raise _snapshot_error("restore_failed", "snapshot restore failed and active archive was retained") from error

    def rotate(
        self,
        *,
        hourly: int = 24,
        daily: int = 30,
        monthly: int = 12,
        dry_run: bool = False,
    ) -> Dict[str, Any]:
        verified = self.list_verified()
        if len(verified) <= 1:
            return {"retained": [item["snapshot_id"] for item in verified], "pruned": [], "dry_run": dry_run}
        retained: Set[str] = {verified[0]["snapshot_id"]}
        buckets: Dict[str, Set[str]] = {"hourly": set(), "daily": set(), "monthly": set()}
        limits = {"hourly": max(0, hourly), "daily": max(0, daily), "monthly": max(0, monthly)}
        for item in verified:
            timestamp = int(item["created_at_ms"]) / 1000
            instant = time.gmtime(timestamp)
            keys = {
                "hourly": time.strftime("%Y-%m-%dT%H", instant),
                "daily": time.strftime("%Y-%m-%d", instant),
                "monthly": time.strftime("%Y-%m", instant),
            }
            for classification, key in keys.items():
                if len(buckets[classification]) < limits[classification] and key not in buckets[classification]:
                    buckets[classification].add(key)
                    retained.add(item["snapshot_id"])
        restored = self.store._connection.execute(
            "SELECT snapshot_id FROM operation_audit WHERE operation = 'snapshot_restore' AND state = 'restored'"
        ).fetchall()
        retained.update(str(row[0]) for row in restored if row[0])
        prune = [item for item in verified if item["snapshot_id"] not in retained]
        for item in prune:
            directory = self.root / item["snapshot_id"]
            if directory.is_symlink() or not os.access(directory, os.W_OK | os.X_OK):
                raise _snapshot_error("snapshot_rotation_failed", "snapshot rotation permission preflight failed")
        pruned: List[str] = []
        if not dry_run:
            for item in prune:
                shutil.rmtree(self.root / item["snapshot_id"])
                pruned.append(item["snapshot_id"])
            _fsync_directory(self.root)
        return {
            "retained": sorted(retained),
            "pruned": [item["snapshot_id"] for item in prune] if dry_run else pruned,
            "dry_run": dry_run,
        }


__all__ = ["SnapshotError", "SnapshotManager"]
