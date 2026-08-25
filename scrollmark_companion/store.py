"""Canonical Scrollmark archive store.

This module is the storage-side seam for T3.  Browser projections, raw
recorder events, and bundle imports are deliberately absent.  The public
methods expose semantic archive operations; SQLite tables never cross that
boundary.
"""
from __future__ import annotations

import hashlib
import json
import secrets
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Set, Tuple, Union

from .contract_runtime import (
    HASH_ALGORITHM,
    ID_RE,
    ZERO_HASH,
    batch_hash,
    canonical_bytes,
    canonicalize,
    chain_hash,
    record_hash,
    sha256_hex,
    validate_reconciliation_request,
    validate_receipt,
    validate_request,
)
from .errors import CommitUnknownError, CompanionError, FailpointError

PROTOCOL = {"major": 1, "minor": 0}
SCHEMA_REVISION = 1
CAPABILITY_REVISION = "cap-v1"
COMPANION_VERSION = "0.1.0"
ENTITY_KINDS = {"tweet", "user", "folder", "media_reference"}
PRIVATE_KEYS = {
    "dm",
    "direct_message",
    "direct_messages",
    "conversation_id",
    "recipient_ids",
    "private_message",
    "private_messages",
}

REQUEST_FIELDS = {
    "protocol",
    "request_id",
    "archive_id",
    "namespace_id",
    "client_id",
    "client_epoch",
    "sent_at_ms",
    "client_sequence",
    "batch",
    "known_checkpoint",
}
RECONCILIATION_FIELDS = {
    "protocol",
    "request_id",
    "archive_id",
    "namespace_id",
    "client_id",
    "client_epoch",
    "sent_at_ms",
    "mode",
    "after_checkpoint",
    "known_checkpoint",
    "page_hint",
}
BATCH_FIELDS = {"batch_id", "mutation_count", "mutations", "batch_hash"}
CHECKPOINT_FIELDS = {"namespace_id", "archive_seq", "chain_hash", "schema_revision"}
PROTOCOL_FIELDS = {"major", "minor", "extensions"}
ENDPOINT_FIELDS = {"namespace_id", "kind", "id"}
MUTATION_COMMON = {
    "mutation_id",
    "client_seq",
    "kind",
    "schema_revision",
    "record_hash",
    "provenance",
    "observed_at_ms",
}
MUTATION_FIELDS = {
    "entity_upsert": MUTATION_COMMON | {"target", "payload"},
    "relationship_upsert": MUTATION_COMMON
    | {"relationship_kind", "subject", "object", "qualifier", "payload"},
    "enrichment_upsert": MUTATION_COMMON | {"target", "enrichment_kind", "payload"},
    "tombstone": MUTATION_COMMON | {"target_kind", "target_id", "relationship_kind", "deletion_id"},
}


def _now_ms() -> int:
    return int(time.time() * 1000)


def _json_text(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _json_value(value: str) -> Any:
    return json.loads(value)


def _copy(value: Any) -> Any:
    return json.loads(json.dumps(value, ensure_ascii=False))


def _id(value: str, prefix: str) -> None:
    if not isinstance(value, str) or ID_RE.fullmatch(value) is None:
        raise ValueError("invalid %s" % prefix)


def _protocol_error_from_validation(
    errors: Sequence[Mapping[str, str]],
    *,
    request_id: Optional[str],
    archive_id: Optional[str] = None,
    namespace_id: Optional[str] = None,
) -> CompanionError:
    error_codes = {error.get("code") for error in errors}
    if error_codes & {"protocol_version_unsupported", "schema_revision_unsupported"}:
        code = "protocol_version_unsupported"
        message = "the requested protocol or schema revision is unsupported"
    elif error_codes & {"batch_hash_mismatch", "record_hash_mismatch"}:
        code = "batch_hash_mismatch"
        message = "the canonical batch or record hash does not match its content"
    else:
        code = "validation_failed"
        message = "the request does not satisfy the canonical contract"
    return CompanionError(
        code,
        message,
        request_id=request_id,
        archive_id=archive_id,
        namespace_id=namespace_id,
        observed={"errors": [dict(error) for error in errors[:8]]},
    )


class CanonicalArchiveStore:
    """Namespace-scoped canonical state with atomic receipt-producing commits."""

    def __init__(
        self,
        db_path: Union[str, Path],
        *,
        archive_id: Optional[str] = None,
        max_mutations_per_batch: int = 512,
        max_request_bytes: int = 8 * 1024 * 1024,
        max_page_items: int = 256,
        max_page_bytes: int = 2 * 1024 * 1024,
        max_stream_lifetime_ms: int = 10 * 60 * 1000,
        max_stream_pages: int = 4096,
        clock: Callable[[], int] = _now_ms,
        failpoints: Optional[Iterable[str]] = None,
    ) -> None:
        self.db_path = Path(db_path)
        if str(db_path) != ":memory:":
            self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.max_mutations_per_batch = max(1, int(max_mutations_per_batch))
        self.max_request_bytes = max(1024, int(max_request_bytes))
        self.max_page_items = max(1, int(max_page_items))
        self.max_page_bytes = max(1024, int(max_page_bytes))
        self.max_stream_lifetime_ms = max(1000, int(max_stream_lifetime_ms))
        self.max_stream_pages = max(1, int(max_stream_pages))
        self._clock = clock
        self._lock = threading.RLock()
        self._failpoints: Set[str] = set(failpoints or ())
        self._connection = self._open_connection()
        self._create_schema()
        self.archive_id = self._load_or_create_archive_id(archive_id)

    def _open_connection(self) -> sqlite3.Connection:
        connection = sqlite3.connect(
            ":memory:" if str(self.db_path) == ":memory:" else str(self.db_path),
            check_same_thread=False,
            isolation_level=None,
        )
        connection.row_factory = sqlite3.Row
        self._connection = connection
        self._configure_connection()
        return connection

    def _reopen_connection_locked(self, expected_archive_id: str) -> None:
        self._connection = self._open_connection()
        self._create_schema()
        self.archive_id = self._load_or_create_archive_id(expected_archive_id)

    def _configure_connection(self) -> None:
        with self._lock:
            self._connection.execute("PRAGMA foreign_keys = ON")
            self._connection.execute("PRAGMA busy_timeout = 5000")
            if str(self.db_path) != ":memory:":
                self._connection.execute("PRAGMA journal_mode = WAL")
            else:
                self._connection.execute("PRAGMA journal_mode = MEMORY")
            self._connection.execute("PRAGMA synchronous = FULL")

    def _create_schema(self) -> None:
        with self._lock:
            self._connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS companion_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS namespaces (
                    namespace_id TEXT PRIMARY KEY,
                    state TEXT NOT NULL,
                    binding_json TEXT,
                    created_at_ms INTEGER NOT NULL,
                    updated_at_ms INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS archive_state (
                    namespace_id TEXT PRIMARY KEY REFERENCES namespaces(namespace_id),
                    next_archive_seq INTEGER NOT NULL,
                    chain_hash TEXT NOT NULL,
                    retained_from INTEGER NOT NULL DEFAULT 1,
                    updated_at_ms INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS clients (
                    namespace_id TEXT NOT NULL REFERENCES namespaces(namespace_id),
                    client_id TEXT NOT NULL,
                    client_epoch TEXT NOT NULL,
                    active INTEGER NOT NULL DEFAULT 1,
                    last_client_seq INTEGER NOT NULL DEFAULT 0,
                    last_batch_id TEXT,
                    last_batch_hash TEXT,
                    updated_at_ms INTEGER NOT NULL,
                    PRIMARY KEY(namespace_id, client_id, client_epoch)
                );
                CREATE TABLE IF NOT EXISTS checkpoints (
                    namespace_id TEXT NOT NULL REFERENCES namespaces(namespace_id),
                    archive_seq INTEGER NOT NULL,
                    chain_hash TEXT NOT NULL,
                    schema_revision INTEGER NOT NULL,
                    created_at_ms INTEGER NOT NULL,
                    PRIMARY KEY(namespace_id, archive_seq)
                );
                CREATE TABLE IF NOT EXISTS batches (
                    namespace_id TEXT NOT NULL REFERENCES namespaces(namespace_id),
                    batch_id TEXT NOT NULL,
                    batch_hash TEXT NOT NULL,
                    client_id TEXT NOT NULL,
                    client_epoch TEXT NOT NULL,
                    client_from INTEGER NOT NULL,
                    client_to INTEGER NOT NULL,
                    archive_from INTEGER NOT NULL,
                    archive_to INTEGER NOT NULL,
                    prior_chain_hash TEXT NOT NULL,
                    chain_hash TEXT NOT NULL,
                    mutation_count INTEGER NOT NULL,
                    receipt_json TEXT NOT NULL,
                    created_at_ms INTEGER NOT NULL,
                    PRIMARY KEY(namespace_id, batch_id)
                );
                CREATE TABLE IF NOT EXISTS journal (
                    namespace_id TEXT NOT NULL REFERENCES namespaces(namespace_id),
                    archive_seq INTEGER NOT NULL,
                    batch_id TEXT NOT NULL,
                    mutation_id TEXT NOT NULL,
                    client_seq INTEGER NOT NULL,
                    mutation_json TEXT NOT NULL,
                    record_hash TEXT NOT NULL,
                    batch_hash TEXT NOT NULL,
                    chain_hash TEXT NOT NULL,
                    PRIMARY KEY(namespace_id, archive_seq),
                    UNIQUE(namespace_id, mutation_id)
                );
                CREATE INDEX IF NOT EXISTS idx_journal_namespace_seq
                    ON journal(namespace_id, archive_seq);
                CREATE TABLE IF NOT EXISTS state_records (
                    namespace_id TEXT NOT NULL REFERENCES namespaces(namespace_id),
                    state_key TEXT NOT NULL,
                    mutation_kind TEXT NOT NULL,
                    mutation_json TEXT NOT NULL,
                    archive_seq INTEGER NOT NULL,
                    record_hash TEXT NOT NULL,
                    PRIMARY KEY(namespace_id, state_key)
                );
                CREATE INDEX IF NOT EXISTS idx_state_namespace_seq
                    ON state_records(namespace_id, archive_seq);
                CREATE TABLE IF NOT EXISTS operation_audit (
                    audit_id TEXT PRIMARY KEY,
                    operation TEXT NOT NULL,
                    archive_id TEXT NOT NULL,
                    snapshot_id TEXT,
                    state TEXT NOT NULL,
                    details_json TEXT NOT NULL,
                    created_at_ms INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS streams (
                    stream_id TEXT PRIMARY KEY,
                    namespace_id TEXT NOT NULL REFERENCES namespaces(namespace_id),
                    mode TEXT NOT NULL,
                    source_checkpoint_json TEXT NOT NULL,
                    target_checkpoint_json TEXT NOT NULL,
                    manifest_hash TEXT NOT NULL,
                    item_count INTEGER NOT NULL,
                    page_count INTEGER NOT NULL,
                    expires_at_ms INTEGER NOT NULL,
                    activated INTEGER NOT NULL DEFAULT 0,
                    created_at_ms INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS stream_pages (
                    stream_id TEXT NOT NULL REFERENCES streams(stream_id),
                    page_index INTEGER NOT NULL,
                    cursor TEXT,
                    page_json TEXT NOT NULL,
                    PRIMARY KEY(stream_id, page_index),
                    UNIQUE(stream_id, cursor)
                );
                """
            )

    def _load_or_create_archive_id(self, requested: Optional[str]) -> str:
        with self._lock:
            row = self._connection.execute(
                "SELECT value FROM companion_meta WHERE key = 'archive_id'"
            ).fetchone()
            if row is not None:
                existing = str(row[0])
                if requested is not None and requested != existing:
                    raise ValueError("archive_id does not match the existing archive")
                return existing
            value = requested or ("archive-" + uuid.uuid4().hex)
            _id(value, "archive_id")
            self._connection.execute(
                "INSERT INTO companion_meta(key, value) VALUES('archive_id', ?)",
                (value,),
            )
            return value

    def close(self) -> None:
        with self._lock:
            self._connection.close()

    def set_failpoint(self, name: str, enabled: bool = True) -> None:
        with self._lock:
            if enabled:
                self._failpoints.add(name)
            else:
                self._failpoints.discard(name)

    def _hit_failpoint(self, name: str) -> None:
        if name in self._failpoints:
            raise FailpointError(name)

    def _begin(self) -> None:
        self._connection.execute("BEGIN IMMEDIATE")

    def _rollback_if_open(self) -> None:
        try:
            if self._connection.in_transaction:
                self._connection.execute("ROLLBACK")
        except sqlite3.Error:
            pass

    def _namespace(self, namespace_id: str) -> sqlite3.Row:
        row = self._connection.execute(
            "SELECT * FROM namespaces WHERE namespace_id = ?", (namespace_id,)
        ).fetchone()
        if row is None or row["state"] != "active":
            raise CompanionError(
                "namespace_not_active",
                "the requested namespace is not active",
                archive_id=self.archive_id,
                namespace_id=namespace_id,
            )
        return row

    def _client(self, namespace_id: str, client_id: str, client_epoch: str) -> sqlite3.Row:
        row = self._connection.execute(
            """
            SELECT * FROM clients
            WHERE namespace_id = ? AND client_id = ? AND client_epoch = ?
            """,
            (namespace_id, client_id, client_epoch),
        ).fetchone()
        if row is None or not row["active"]:
            raise CompanionError(
                "client_epoch_unknown",
                "the client epoch is not admitted; explicit pairing is required",
                archive_id=self.archive_id,
                namespace_id=namespace_id,
            )
        return row

    def admit_namespace(
        self,
        namespace_id: str,
        *,
        binding: Optional[Mapping[str, Any]] = None,
        state: str = "active",
    ) -> None:
        """Create an identity-admitted namespace for the future T4 pairing seam."""
        _id(namespace_id, "namespace_id")
        if state not in {"active", "quarantined", "retired"}:
            raise ValueError("invalid namespace state")
        now = self._clock()
        with self._lock:
            self._begin()
            committed = False
            try:
                existing = self._connection.execute(
                    "SELECT state FROM namespaces WHERE namespace_id = ?", (namespace_id,)
                ).fetchone()
                if existing is not None:
                    if existing["state"] != state:
                        raise ValueError("namespace state changes require the identity state machine")
                    self._connection.execute("COMMIT")
                    committed = True
                    return
                self._connection.execute(
                    """
                    INSERT INTO namespaces(namespace_id, state, binding_json, created_at_ms, updated_at_ms)
                    VALUES(?, ?, ?, ?, ?)
                    """,
                    (namespace_id, state, _json_text(binding) if binding is not None else None, now, now),
                )
                self._connection.execute(
                    """
                    INSERT INTO archive_state(namespace_id, next_archive_seq, chain_hash, retained_from, updated_at_ms)
                    VALUES(?, 0, ?, 1, ?)
                    """,
                    (namespace_id, ZERO_HASH, now),
                )
                self._connection.execute(
                    """
                    INSERT INTO checkpoints(namespace_id, archive_seq, chain_hash, schema_revision, created_at_ms)
                    VALUES(?, 0, ?, ?, ?)
                    """,
                    (namespace_id, ZERO_HASH, SCHEMA_REVISION, now),
                )
                self._connection.execute("COMMIT")
                committed = True
            except Exception:
                if not committed:
                    self._rollback_if_open()
                raise

    def admit_client(self, namespace_id: str, client_id: str, client_epoch: str) -> None:
        """Admit one immutable client sequence stream (owned by future T4 pairing)."""
        _id(namespace_id, "namespace_id")
        _id(client_id, "client_id")
        _id(client_epoch, "client_epoch")
        now = self._clock()
        with self._lock:
            self._namespace(namespace_id)
            self._connection.execute(
                """
                INSERT OR IGNORE INTO clients(
                    namespace_id, client_id, client_epoch, active, last_client_seq,
                    last_batch_id, last_batch_hash, updated_at_ms
                ) VALUES(?, ?, ?, 1, 0, NULL, NULL, ?)
                """,
                (namespace_id, client_id, client_epoch, now),
            )

    def _archive_state(self, namespace_id: str) -> sqlite3.Row:
        row = self._connection.execute(
            "SELECT * FROM archive_state WHERE namespace_id = ?", (namespace_id,)
        ).fetchone()
        if row is None:
            raise CompanionError(
                "namespace_not_active",
                "the requested namespace has no archive state",
                archive_id=self.archive_id,
                namespace_id=namespace_id,
            )
        return row

    def _checkpoint_at(self, namespace_id: str, archive_seq: int) -> Optional[Dict[str, Any]]:
        if archive_seq == 0:
            return {
                "namespace_id": namespace_id,
                "archive_seq": 0,
                "chain_hash": ZERO_HASH,
                "schema_revision": SCHEMA_REVISION,
            }
        row = self._connection.execute(
            """
            SELECT archive_seq, chain_hash, schema_revision
            FROM checkpoints WHERE namespace_id = ? AND archive_seq = ?
            """,
            (namespace_id, archive_seq),
        ).fetchone()
        if row is None:
            return None
        return {
            "namespace_id": namespace_id,
            "archive_seq": int(row["archive_seq"]),
            "chain_hash": row["chain_hash"],
            "schema_revision": int(row["schema_revision"]),
        }

    def _current_checkpoint(self, namespace_id: str) -> Dict[str, Any]:
        state = self._archive_state(namespace_id)
        return {
            "namespace_id": namespace_id,
            "archive_seq": int(state["next_archive_seq"]),
            "chain_hash": state["chain_hash"],
            "schema_revision": SCHEMA_REVISION,
        }

    def _validate_checkpoint_locked(
        self,
        checkpoint: Mapping[str, Any],
        namespace_id: str,
        *,
        allow_expired: bool = False,
    ) -> Dict[str, Any]:
        current = self._current_checkpoint(namespace_id)
        state = self._archive_state(namespace_id)
        seq = int(checkpoint["archive_seq"])
        if seq > current["archive_seq"]:
            raise CompanionError(
                "checkpoint_mismatch",
                "the checkpoint is ahead of the authoritative archive",
                archive_id=self.archive_id,
                namespace_id=namespace_id,
                expected={"checkpoint": current},
                observed={"checkpoint": dict(checkpoint)},
            )
        if seq < int(state["retained_from"]) - 1 and not allow_expired:
            raise CompanionError(
                "checkpoint_expired",
                "the requested checkpoint predates retained journal history",
                archive_id=self.archive_id,
                namespace_id=namespace_id,
                expected={"retained_from": int(state["retained_from"])},
                observed={"checkpoint": dict(checkpoint)},
            )
        authoritative = self._checkpoint_at(namespace_id, seq)
        if authoritative is None:
            raise CompanionError(
                "checkpoint_mismatch",
                "the checkpoint does not identify a committed archive boundary",
                archive_id=self.archive_id,
                namespace_id=namespace_id,
                expected={"checkpoint": current},
                observed={"checkpoint": dict(checkpoint)},
            )
        if dict(checkpoint) != authoritative:
            raise CompanionError(
                "checkpoint_mismatch",
                "the checkpoint chain hash differs from the authoritative chain",
                archive_id=self.archive_id,
                namespace_id=namespace_id,
                expected={"checkpoint": authoritative},
                observed={"checkpoint": dict(checkpoint)},
            )
        return authoritative

    def _validate_shape(self, value: Mapping[str, Any], *, reconciliation: bool) -> None:
        allowed_top = RECONCILIATION_FIELDS if reconciliation else REQUEST_FIELDS
        unknown = set(value) - allowed_top
        if unknown:
            raise CompanionError(
                "validation_failed",
                "unknown required request fields are not admitted",
                observed={"unknown_fields": sorted(unknown)},
            )
        protocol = value.get("protocol")
        if isinstance(protocol, dict):
            unknown_protocol = set(protocol) - PROTOCOL_FIELDS
            if unknown_protocol:
                raise CompanionError(
                    "validation_failed",
                    "unknown required protocol fields are not admitted",
                    observed={"unknown_fields": sorted(unknown_protocol)},
                )
            if "extensions" in protocol and not isinstance(protocol["extensions"], dict):
                raise CompanionError(
                    "validation_failed",
                    "protocol extensions must be an object",
                )
        if reconciliation:
            for field in ("after_checkpoint", "known_checkpoint"):
                checkpoint = value.get(field)
                if isinstance(checkpoint, dict):
                    unknown_checkpoint = set(checkpoint) - CHECKPOINT_FIELDS
                    if unknown_checkpoint:
                        raise CompanionError(
                            "validation_failed",
                            "unknown checkpoint fields are not admitted",
                            observed={"unknown_fields": sorted(unknown_checkpoint)},
                        )
            return
        sequence = value.get("client_sequence")
        if isinstance(sequence, dict):
            unknown_sequence = set(sequence) - {"from", "to"}
            if unknown_sequence:
                raise CompanionError(
                    "validation_failed",
                    "unknown required sequence fields are not admitted",
                    observed={"unknown_fields": sorted(unknown_sequence)},
                )
        batch = value.get("batch")
        if isinstance(batch, dict):
            unknown_batch = set(batch) - BATCH_FIELDS
            if unknown_batch:
                raise CompanionError(
                    "validation_failed",
                    "unknown required batch fields are not admitted",
                    observed={"unknown_fields": sorted(unknown_batch)},
                )
            for index, mutation in enumerate(batch.get("mutations", [])):
                if not isinstance(mutation, dict):
                    continue
                kind = mutation.get("kind")
                allowed_mutation = MUTATION_FIELDS.get(kind)
                if allowed_mutation is None:
                    continue
                unknown_mutation = set(mutation) - allowed_mutation
                if unknown_mutation:
                    raise CompanionError(
                        "validation_failed",
                        "unknown required mutation fields are not admitted",
                        observed={"index": index, "unknown_fields": sorted(unknown_mutation)},
                    )
                for endpoint_name in ("target", "subject", "object"):
                    endpoint = mutation.get(endpoint_name)
                    if isinstance(endpoint, dict):
                        unknown_endpoint = set(endpoint) - ENDPOINT_FIELDS
                        if unknown_endpoint:
                            raise CompanionError(
                                "validation_failed",
                                "unknown required endpoint fields are not admitted",
                                observed={"index": index, "unknown_fields": sorted(unknown_endpoint)},
                            )
                if kind == "tombstone" and "relationship_kind" in mutation:
                    relationship_kind = mutation["relationship_kind"]
                    if not isinstance(relationship_kind, str) or not 1 <= len(relationship_kind) <= 128:
                        raise CompanionError(
                            "validation_failed",
                            "tombstone relationship_kind must be a bounded string",
                            observed={"index": index},
                        )
                provenance = mutation.get("provenance")
                if isinstance(provenance, dict) and "source" in provenance:
                    source = provenance["source"]
                    if not isinstance(source, str) or not 1 <= len(source) <= 128:
                        raise CompanionError(
                            "validation_failed",
                            "provenance source must be a bounded string",
                            observed={"index": index},
                        )

    def _validate_request(self, request: Mapping[str, Any], *, reconciliation: bool) -> None:
        if not isinstance(request, dict):
            raise CompanionError("validation_failed", "request body must be a JSON object")
        self._validate_shape(request, reconciliation=reconciliation)
        errors = (
            validate_reconciliation_request(request)
            if reconciliation
            else validate_request(request)
        )
        if errors:
            raise _protocol_error_from_validation(
                errors,
                request_id=request.get("request_id") if isinstance(request.get("request_id"), str) else None,
                archive_id=request.get("archive_id") if isinstance(request.get("archive_id"), str) else None,
                namespace_id=request.get("namespace_id") if isinstance(request.get("namespace_id"), str) else None,
            )

    def _private_lane_reason(self, mutation: Mapping[str, Any]) -> Optional[str]:
        provenance = mutation.get("provenance")
        if isinstance(provenance, dict):
            source = provenance.get("source")
            if isinstance(source, str) and source.strip().lower() in {
                "dm",
                "direct_message",
                "direct_messages",
                "private",
            }:
                return "private provenance source is disabled"

        def walk(value: Any) -> bool:
            if isinstance(value, dict):
                for key, child in value.items():
                    normalized = str(key).strip().lower().replace("-", "_")
                    if normalized in PRIVATE_KEYS:
                        return True
                    if walk(child):
                        return True
            elif isinstance(value, list):
                return any(walk(item) for item in value)
            return False

        if walk(mutation.get("payload")) or walk(mutation.get("provenance")):
            return "private-lane fields are disabled"
        return None

    def _state_key(self, mutation: Mapping[str, Any]) -> str:
        kind = mutation["kind"]
        if kind == "entity_upsert":
            target = mutation["target"]
            return "entity:" + target["kind"] + ":" + target["id"]
        if kind == "relationship_upsert":
            material = {
                "relationship_kind": mutation["relationship_kind"],
                "subject": mutation["subject"],
                "object": mutation["object"],
                "qualifier": mutation["qualifier"],
            }
            return "relationship:" + sha256_hex(material)
        if kind == "enrichment_upsert":
            target = mutation["target"]
            return "enrichment:" + target["kind"] + ":" + target["id"] + ":" + mutation["enrichment_kind"]
        target_kind = mutation["target_kind"]
        target_id = mutation["target_id"]
        if target_kind in ENTITY_KINDS:
            return "entity:" + target_kind + ":" + target_id
        if target_kind == "relationship":
            return "relationship:" + target_id
        if target_kind == "enrichment":
            return "enrichment:" + target_id
        return "tombstone:" + target_kind + ":" + target_id

    def _tombstone_conflict(self, namespace_id: str, mutation: Mapping[str, Any]) -> bool:
        if mutation["kind"] == "tombstone":
            return False
        key = self._state_key(mutation)
        row = self._connection.execute(
            "SELECT mutation_kind FROM state_records WHERE namespace_id = ? AND state_key = ?",
            (namespace_id, key),
        ).fetchone()
        if row is not None and row["mutation_kind"] == "tombstone":
            return True
        if mutation["kind"] == "entity_upsert":
            return False
        # Relationship/enrichment tombstones may identify their target by an
        # opaque hash rather than the structured state key.
        target_kind = "relationship" if mutation["kind"] == "relationship_upsert" else "enrichment"
        target_id = key.split(":", 1)[1] if ":" in key else key
        row = self._connection.execute(
            """
            SELECT mutation_json FROM state_records
            WHERE namespace_id = ? AND mutation_kind = 'tombstone'
            """,
            (namespace_id,),
        ).fetchall()
        for candidate in row:
            tombstone = _json_value(candidate["mutation_json"])
            if tombstone.get("target_kind") == target_kind and tombstone.get("target_id") == target_id:
                return True
        return False

    def _mutation_ids(self, mutations: Sequence[Mapping[str, Any]]) -> Set[str]:
        return {str(mutation["mutation_id"]) for mutation in mutations}

    def _check_private_lane(self, mutations: Sequence[Mapping[str, Any]]) -> None:
        for mutation in mutations:
            reason = self._private_lane_reason(mutation)
            if reason:
                raise CompanionError("validation_failed", "private or direct-message mutations are disabled", observed={"reason": reason})

    def commit(self, request: Mapping[str, Any]) -> Dict[str, Any]:
        """Validate and atomically admit one immutable archive-delta batch."""
        self._validate_request(request, reconciliation=False)
        request_id = request["request_id"]
        namespace_id = request["namespace_id"]
        batch = request["batch"]
        mutations = batch["mutations"]
        if len(mutations) > self.max_mutations_per_batch:
            raise CompanionError(
                "limit_exceeded",
                "the batch exceeds the advertised mutation limit",
                archive_id=self.archive_id,
                namespace_id=namespace_id,
                expected={"max_mutations_per_batch": self.max_mutations_per_batch},
                observed={"mutation_count": len(mutations)},
            )
        if len(canonical_bytes(request)) > self.max_request_bytes:
            raise CompanionError(
                "limit_exceeded",
                "the request exceeds the advertised byte limit",
                archive_id=self.archive_id,
                namespace_id=namespace_id,
                expected={"max_request_bytes": self.max_request_bytes},
            )
        if len(self._mutation_ids(mutations)) != len(mutations):
            raise CompanionError(
                "validation_failed",
                "mutation identities must be unique within a batch",
                archive_id=self.archive_id,
                namespace_id=namespace_id,
            )
        self._check_private_lane(mutations)

        with self._lock:
            if request["archive_id"] != self.archive_id:
                raise CompanionError(
                    "archive_binding_mismatch",
                    "the request archive binding does not match this companion",
                    request_id=request_id,
                    archive_id=self.archive_id,
                    namespace_id=namespace_id,
                )
            self._namespace(namespace_id)
            client = self._client(namespace_id, request["client_id"], request["client_epoch"])
            state = self._archive_state(namespace_id)
            if request.get("known_checkpoint") is not None:
                self._validate_checkpoint_locked(request["known_checkpoint"], namespace_id)

            existing = self._connection.execute(
                "SELECT * FROM batches WHERE namespace_id = ? AND batch_id = ?",
                (namespace_id, batch["batch_id"]),
            ).fetchone()
            if existing is not None:
                immutable_matches = (
                    existing["batch_hash"] == batch["batch_hash"]
                    and existing["client_id"] == request["client_id"]
                    and existing["client_epoch"] == request["client_epoch"]
                    and existing["client_from"] == request["client_sequence"]["from"]
                    and existing["client_to"] == request["client_sequence"]["to"]
                    and existing["mutation_count"] == len(mutations)
                )
                if not immutable_matches:
                    raise CompanionError(
                        "mutation_hash_conflict",
                        "the batch identity is already committed with different canonical content",
                        request_id=request_id,
                        archive_id=self.archive_id,
                        namespace_id=namespace_id,
                    )
                receipt = _json_value(existing["receipt_json"])
                receipt["request_id"] = request_id
                receipt["result"] = "duplicate"
                receipt_errors = validate_receipt(receipt)
                if receipt_errors:
                    raise CompanionError(
                        "companion_unavailable",
                        "the stored receipt failed integrity validation",
                        retryable=True,
                        request_id=request_id,
                        archive_id=self.archive_id,
                        namespace_id=namespace_id,
                    )
                return receipt

            for mutation in mutations:
                row = self._connection.execute(
                    """
                    SELECT batch_id, record_hash FROM journal
                    WHERE namespace_id = ? AND mutation_id = ?
                    """,
                    (namespace_id, mutation["mutation_id"]),
                ).fetchone()
                if row is not None:
                    raise CompanionError(
                        "mutation_hash_conflict",
                        "a mutation identity cannot be reused in another batch",
                        request_id=request_id,
                        archive_id=self.archive_id,
                        namespace_id=namespace_id,
                        expected={"batch_id": row["batch_id"], "record_hash": row["record_hash"]},
                        observed={"batch_id": batch["batch_id"], "record_hash": mutation["record_hash"]},
                    )

            expected_client_from = int(client["last_client_seq"]) + 1
            if request["client_sequence"]["from"] != expected_client_from:
                raise CompanionError(
                    "client_sequence_gap",
                    "the next client sequence is not contiguous",
                    request_id=request_id,
                    archive_id=self.archive_id,
                    namespace_id=namespace_id,
                    expected={
                        "client_sequence": {
                            "from": expected_client_from,
                            "to": expected_client_from + len(mutations) - 1,
                        },
                        "last_batch_id": client["last_batch_id"],
                    },
                    observed={"client_sequence": request["client_sequence"], "batch_id": batch["batch_id"]},
                )

            self._begin()
            committed = False
            try:
                # Recheck the lease after BEGIN IMMEDIATE; this protects the
                # sequence invariant if a future adapter calls this method from
                # another process against the same database.
                client_locked = self._connection.execute(
                    """
                    SELECT * FROM clients
                    WHERE namespace_id = ? AND client_id = ? AND client_epoch = ?
                    """,
                    (namespace_id, request["client_id"], request["client_epoch"]),
                ).fetchone()
                if client_locked is None or not client_locked["active"]:
                    raise CompanionError(
                        "client_epoch_unknown",
                        "the client epoch is not admitted",
                        request_id=request_id,
                        archive_id=self.archive_id,
                        namespace_id=namespace_id,
                    )
                expected_locked = int(client_locked["last_client_seq"]) + 1
                if request["client_sequence"]["from"] != expected_locked:
                    raise CompanionError(
                        "client_sequence_gap",
                        "the next client sequence is not contiguous",
                        request_id=request_id,
                        archive_id=self.archive_id,
                        namespace_id=namespace_id,
                        expected={"from": expected_locked},
                        observed={"from": request["client_sequence"]["from"]},
                    )
                self._hit_failpoint("client_sequence_allocation")

                for mutation in mutations:
                    if self._tombstone_conflict(namespace_id, mutation):
                        raise CompanionError(
                            "validation_failed",
                            "a canonical tombstone prevents resurrection of the target",
                            request_id=request_id,
                            archive_id=self.archive_id,
                            namespace_id=namespace_id,
                            observed={"mutation_id": mutation["mutation_id"]},
                        )

                locked_state = self._connection.execute(
                    "SELECT * FROM archive_state WHERE namespace_id = ?", (namespace_id,)
                ).fetchone()
                archive_from = int(locked_state["next_archive_seq"]) + 1
                archive_to = archive_from + len(mutations) - 1
                prior_chain_hash = locked_state["chain_hash"]
                committed_chain_hash = chain_hash(
                    namespace_id,
                    prior_chain_hash,
                    batch["batch_hash"],
                    archive_from,
                    archive_to,
                    SCHEMA_REVISION,
                )
                now = self._clock()
                for offset, mutation in enumerate(mutations):
                    archive_seq = archive_from + offset
                    self._connection.execute(
                        """
                        INSERT INTO journal(
                            namespace_id, archive_seq, batch_id, mutation_id, client_seq,
                            mutation_json, record_hash, batch_hash, chain_hash
                        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            namespace_id,
                            archive_seq,
                            batch["batch_id"],
                            mutation["mutation_id"],
                            mutation["client_seq"],
                            _json_text(mutation),
                            mutation["record_hash"],
                            batch["batch_hash"],
                            committed_chain_hash,
                        ),
                    )
                    state_key = self._state_key(mutation)
                    self._connection.execute(
                        "DELETE FROM state_records WHERE namespace_id = ? AND state_key = ?",
                        (namespace_id, state_key),
                    )
                    self._connection.execute(
                        """
                        INSERT INTO state_records(
                            namespace_id, state_key, mutation_kind, mutation_json,
                            archive_seq, record_hash
                        ) VALUES(?, ?, ?, ?, ?, ?)
                        """,
                        (
                            namespace_id,
                            state_key,
                            mutation["kind"],
                            _json_text(mutation),
                            archive_seq,
                            mutation["record_hash"],
                        ),
                    )

                checkpoint = {
                    "namespace_id": namespace_id,
                    "archive_seq": archive_to,
                    "chain_hash": committed_chain_hash,
                    "schema_revision": SCHEMA_REVISION,
                }
                receipt = {
                    "protocol": dict(PROTOCOL),
                    "request_id": request_id,
                    "archive_id": self.archive_id,
                    "namespace_id": namespace_id,
                    "client_id": request["client_id"],
                    "client_epoch": request["client_epoch"],
                    "batch_id": batch["batch_id"],
                    "result": "committed",
                    "client_sequence": dict(request["client_sequence"]),
                    "archive_sequence": {"from": archive_from, "to": archive_to},
                    "mutation_count": len(mutations),
                    "batch_hash": batch["batch_hash"],
                    "prior_chain_hash": prior_chain_hash,
                    "chain_hash": committed_chain_hash,
                    "checkpoint": checkpoint,
                    "capability_revision": CAPABILITY_REVISION,
                }
                receipt_errors = validate_receipt(receipt)
                if receipt_errors:
                    raise CompanionError(
                        "companion_unavailable",
                        "the generated receipt failed contract validation",
                        retryable=True,
                        request_id=request_id,
                        archive_id=self.archive_id,
                        namespace_id=namespace_id,
                        observed={"errors": receipt_errors[:8]},
                    )
                self._connection.execute(
                    """
                    INSERT INTO batches(
                        namespace_id, batch_id, batch_hash, client_id, client_epoch,
                        client_from, client_to, archive_from, archive_to,
                        prior_chain_hash, chain_hash, mutation_count, receipt_json, created_at_ms
                    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        namespace_id,
                        batch["batch_id"],
                        batch["batch_hash"],
                        request["client_id"],
                        request["client_epoch"],
                        request["client_sequence"]["from"],
                        request["client_sequence"]["to"],
                        archive_from,
                        archive_to,
                        prior_chain_hash,
                        committed_chain_hash,
                        len(mutations),
                        _json_text(receipt),
                        now,
                    ),
                )
                self._connection.execute(
                    """
                    INSERT INTO checkpoints(namespace_id, archive_seq, chain_hash, schema_revision, created_at_ms)
                    VALUES(?, ?, ?, ?, ?)
                    """,
                    (namespace_id, archive_to, committed_chain_hash, SCHEMA_REVISION, now),
                )
                self._connection.execute(
                    """
                    UPDATE archive_state
                    SET next_archive_seq = ?, chain_hash = ?, updated_at_ms = ?
                    WHERE namespace_id = ?
                    """,
                    (archive_to, committed_chain_hash, now, namespace_id),
                )
                self._connection.execute(
                    """
                    UPDATE clients
                    SET last_client_seq = ?, last_batch_id = ?, last_batch_hash = ?, updated_at_ms = ?
                    WHERE namespace_id = ? AND client_id = ? AND client_epoch = ?
                    """,
                    (
                        request["client_sequence"]["to"],
                        batch["batch_id"],
                        batch["batch_hash"],
                        now,
                        namespace_id,
                        request["client_id"],
                        request["client_epoch"],
                    ),
                )
                self._hit_failpoint("before_transaction_commit")
                self._connection.execute("COMMIT")
                committed = True
            except Exception as error:
                if not committed:
                    self._rollback_if_open()
                if isinstance(error, FailpointError):
                    if committed:
                        raise CommitUnknownError(
                            request_id=request_id,
                            archive_id=self.archive_id,
                            namespace_id=namespace_id,
                        )
                    raise CompanionError(
                        "companion_busy",
                        "the companion transaction was interrupted before acknowledgement",
                        retryable=True,
                        request_id=request_id,
                        archive_id=self.archive_id,
                        namespace_id=namespace_id,
                    )
                raise

            try:
                self._hit_failpoint("wal_checkpoint")
                if str(self.db_path) != ":memory:":
                    self._connection.execute("PRAGMA wal_checkpoint(PASSIVE)")
                self._hit_failpoint("after_transaction_commit")
                self._hit_failpoint("after_commit_before_response")
            except FailpointError:
                raise CommitUnknownError(
                    request_id=request_id,
                    archive_id=self.archive_id,
                    namespace_id=namespace_id,
                )
            return receipt

    def checkpoint(self, namespace_id: str) -> Dict[str, Any]:
        with self._lock:
            self._namespace(namespace_id)
            return _copy(self._current_checkpoint(namespace_id))

    def _page_specs(
        self,
        items: Iterable[Mapping[str, Any]],
        page_hint: int,
    ) -> Iterable[List[Mapping[str, Any]]]:
        item_limit = min(page_hint, self.max_page_items)
        current: List[Mapping[str, Any]] = []
        current_bytes = 2
        page_count = 0
        for item in items:
            item_bytes = len(canonical_bytes(item))
            candidate_bytes = current_bytes + item_bytes + (1 if current else 0)
            too_many = len(current) + 1 > item_limit
            too_large = candidate_bytes > self.max_page_bytes
            if too_large and not current:
                raise CompanionError(
                    "limit_exceeded",
                    "a reconciliation item exceeds the advertised page byte limit",
                    expected={"max_page_bytes": self.max_page_bytes},
                )
            if (too_many or too_large) and current:
                page_count += 1
                if page_count > self.max_stream_pages:
                    raise CompanionError(
                        "limit_exceeded",
                        "the reconciliation stream exceeds the advertised page limit",
                        expected={"max_stream_pages": self.max_stream_pages},
                        observed={"page_count": page_count},
                    )
                yield current
                current = [item]
                current_bytes = item_bytes + 2
            else:
                current.append(item)
                current_bytes = candidate_bytes
        if current or page_count == 0:
            page_count += 1
            if page_count > self.max_stream_pages:
                raise CompanionError(
                    "limit_exceeded",
                    "the reconciliation stream exceeds the advertised page limit",
                    expected={"max_stream_pages": self.max_stream_pages},
                    observed={"page_count": page_count},
                )
            yield current

    def _manifest_and_page_stats(
        self,
        mode: str,
        namespace_id: str,
        source: Mapping[str, Any],
        target: Mapping[str, Any],
        items: Iterable[Mapping[str, Any]],
        page_hint: int,
    ) -> Tuple[str, int, int]:
        digest = hashlib.sha256()
        digest.update(b'{"items":[')
        item_count = 0
        page_count = 0
        page_items = 0
        page_bytes = 2
        item_limit = min(page_hint, self.max_page_items)
        for item in items:
            encoded = canonical_bytes(item)
            digest.update(b"," if item_count else b"")
            digest.update(encoded)
            item_count += 1
            candidate_bytes = page_bytes + len(encoded) + (1 if page_items else 0)
            too_many = page_items + 1 > item_limit
            too_large = candidate_bytes > self.max_page_bytes
            if too_large and page_items == 0:
                raise CompanionError(
                    "limit_exceeded",
                    "a reconciliation item exceeds the advertised page byte limit",
                    expected={"max_page_bytes": self.max_page_bytes},
                )
            if (too_many or too_large) and page_items:
                page_count += 1
                page_items = 1
                page_bytes = len(encoded) + 2
            else:
                page_items += 1
                page_bytes = candidate_bytes
        if page_items or page_count == 0:
            page_count += 1
        if page_count > self.max_stream_pages:
            raise CompanionError(
                "limit_exceeded",
                "the reconciliation stream exceeds the advertised page limit",
                expected={"max_stream_pages": self.max_stream_pages},
                observed={"page_count": page_count},
            )
        digest.update(b'],"mode":')
        digest.update(canonical_bytes(mode))
        digest.update(b',"namespace_id":')
        digest.update(canonical_bytes(namespace_id))
        digest.update(b',"source_checkpoint":')
        digest.update(canonical_bytes(source))
        digest.update(b',"target_checkpoint":')
        digest.update(canonical_bytes(target))
        digest.update(b"}")
        return digest.hexdigest(), item_count, page_count

    def _delta_items(
        self,
        namespace_id: str,
        after_seq: int,
        target_seq: int,
    ) -> Iterable[Dict[str, Any]]:
        rows = self._connection.execute(
            """
            SELECT archive_seq, batch_id, mutation_id, mutation_json, record_hash, chain_hash
            FROM journal
            WHERE namespace_id = ? AND archive_seq > ? AND archive_seq <= ?
            ORDER BY archive_seq ASC
            """,
            (namespace_id, after_seq, target_seq),
        )
        for row in rows:
            yield {
                "archive_seq": int(row["archive_seq"]),
                "batch_id": row["batch_id"],
                "mutation_id": row["mutation_id"],
                "mutation": _json_value(row["mutation_json"]),
                "record_hash": row["record_hash"],
                "chain_hash": row["chain_hash"],
            }

    def _bootstrap_items(self, namespace_id: str) -> Iterable[Dict[str, Any]]:
        rows = self._connection.execute(
            """
            SELECT state_key, mutation_json, archive_seq, record_hash
            FROM state_records WHERE namespace_id = ? ORDER BY state_key ASC
            """,
            (namespace_id,),
        )
        for row in rows:
            mutation = _json_value(row["mutation_json"])
            yield {
                "state_key": row["state_key"],
                "archive_seq": int(row["archive_seq"]),
                "mutation_id": mutation["mutation_id"],
                "mutation": mutation,
                "record_hash": row["record_hash"],
            }

    def reconcile(self, request: Mapping[str, Any]) -> Dict[str, Any]:
        """Pin and persist a finite, immutable reconciliation stream descriptor."""
        self._validate_request(request, reconciliation=True)
        request_id = request["request_id"]
        namespace_id = request["namespace_id"]
        with self._lock:
            if request["archive_id"] != self.archive_id:
                raise CompanionError(
                    "archive_binding_mismatch",
                    "the request archive binding does not match this companion",
                    request_id=request_id,
                    archive_id=self.archive_id,
                    namespace_id=namespace_id,
                )
            self._namespace(namespace_id)
            self._client(namespace_id, request["client_id"], request["client_epoch"])
            mode = request["mode"]
            source: Optional[Dict[str, Any]]
            if mode == "deltas":
                if request.get("after_checkpoint") is None:
                    raise CompanionError(
                        "validation_failed",
                        "delta reconciliation requires an after_checkpoint",
                        request_id=request_id,
                        archive_id=self.archive_id,
                        namespace_id=namespace_id,
                    )
                source = self._validate_checkpoint_locked(request["after_checkpoint"], namespace_id)
            else:
                if request.get("after_checkpoint") is not None:
                    raise CompanionError(
                        "validation_failed",
                        "state bootstrap does not accept an after_checkpoint",
                        request_id=request_id,
                        archive_id=self.archive_id,
                        namespace_id=namespace_id,
                    )
                source = request.get("known_checkpoint")
                if source is None:
                    source = {
                        "namespace_id": namespace_id,
                        "archive_seq": 0,
                        "chain_hash": ZERO_HASH,
                        "schema_revision": SCHEMA_REVISION,
                    }
                else:
                    source = self._validate_checkpoint_locked(source, namespace_id)
            target = self._current_checkpoint(namespace_id)
            if mode == "deltas":
                def items() -> Iterable[Dict[str, Any]]:
                    return self._delta_items(
                        namespace_id,
                        source["archive_seq"],
                        target["archive_seq"],
                    )
            else:
                def items() -> Iterable[Dict[str, Any]]:
                    return self._bootstrap_items(namespace_id)
            manifest_hash, item_count, page_count = self._manifest_and_page_stats(
                mode,
                namespace_id,
                source,
                target,
                items(),
                request["page_hint"],
            )
            stream_id = "stream-" + secrets.token_hex(16)
            expires_at_ms = self._clock() + self.max_stream_lifetime_ms
            cursors = [None] + [
                "cursor-" + secrets.token_hex(16)
                for _ in range(1, page_count)
            ]

            self._hit_failpoint("reconciliation_page_before_persistence")
            self._begin()
            committed = False
            try:
                self._connection.execute(
                    """
                    INSERT INTO streams(
                        stream_id, namespace_id, mode, source_checkpoint_json,
                        target_checkpoint_json, manifest_hash, item_count, page_count,
                        expires_at_ms, activated, created_at_ms
                    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
                    """,
                    (
                        stream_id,
                        namespace_id,
                        mode,
                        _json_text(source),
                        _json_text(target),
                        manifest_hash,
                        item_count,
                        page_count,
                        expires_at_ms,
                        self._clock(),
                    ),
                )
                self._hit_failpoint("reconciliation_page_after_hash_validation")
                previous_chain = source["chain_hash"]
                for page_index, page_items in enumerate(
                    self._page_specs(items(), request["page_hint"])
                ):
                    page: Dict[str, Any] = {
                        "protocol": dict(PROTOCOL),
                        "stream_id": stream_id,
                        "namespace_id": namespace_id,
                        "mode": mode,
                        "page_index": page_index,
                        "item_count": len(page_items),
                        "byte_count": len(canonical_bytes(page_items)),
                        "items": _copy(page_items),
                        "page_hash": "",
                        "target_checkpoint": _copy(target),
                        "manifest_hash": manifest_hash,
                        "final": page_index == page_count - 1,
                    }
                    if mode == "deltas":
                        page["previous_chain_hash"] = previous_chain
                        next_chain = (
                            page_items[-1]["chain_hash"]
                            if page_items
                            else target["chain_hash"]
                        )
                        page["next_chain_hash"] = next_chain
                        previous_chain = next_chain
                    if not page["final"]:
                        page["next_cursor"] = cursors[page_index + 1]
                    page["page_hash"] = sha256_hex(
                        {key: value for key, value in page.items() if key != "page_hash"}
                    )
                    self._connection.execute(
                        """
                        INSERT INTO stream_pages(stream_id, page_index, cursor, page_json)
                        VALUES(?, ?, ?, ?)
                        """,
                        (
                            stream_id,
                            page_index,
                            cursors[page_index],
                            _json_text(page),
                        ),
                    )
                self._hit_failpoint("reconciliation_page_before_activation")
                self._connection.execute(
                    "UPDATE streams SET activated = 1 WHERE stream_id = ?", (stream_id,)
                )
                self._connection.execute("COMMIT")
                committed = True
            except Exception:
                if not committed:
                    self._rollback_if_open()
                raise
            return {
                "protocol": dict(PROTOCOL),
                "stream_id": stream_id,
                "namespace_id": namespace_id,
                "mode": mode,
                "source_checkpoint": _copy(source),
                "target_checkpoint": _copy(target),
                "manifest_hash": manifest_hash,
                "item_count": item_count,
                "page_count": page_count,
                "page_limits": {
                    "max_items": min(request["page_hint"], self.max_page_items),
                    "max_bytes": self.max_page_bytes,
                },
                "expires_at_ms": expires_at_ms,
                "capability_revision": CAPABILITY_REVISION,
            }

    def reconciliation_page(self, stream_id: str, cursor: Optional[str] = None) -> Dict[str, Any]:
        """Read one precomputed page from a still-valid pinned stream."""
        _id(stream_id, "stream_id")
        with self._lock:
            stream = self._connection.execute(
                "SELECT * FROM streams WHERE stream_id = ?", (stream_id,)
            ).fetchone()
            if stream is None or not stream["activated"] or int(stream["expires_at_ms"]) <= self._clock():
                raise CompanionError(
                    "stream_expired",
                    "the reconciliation stream is no longer available",
                    retryable=False,
                    archive_id=self.archive_id,
                    namespace_id=stream["namespace_id"] if stream is not None else None,
                )
            if cursor is None:
                page = self._connection.execute(
                    "SELECT page_json FROM stream_pages WHERE stream_id = ? AND page_index = 0",
                    (stream_id,),
                ).fetchone()
            else:
                page = self._connection.execute(
                    """
                    SELECT page_json FROM stream_pages
                    WHERE stream_id = ? AND cursor = ?
                    """,
                    (stream_id, cursor),
                ).fetchone()
            if page is None:
                raise CompanionError(
                    "validation_failed",
                    "the reconciliation cursor is invalid for this stream",
                    archive_id=self.archive_id,
                    namespace_id=stream["namespace_id"],
                )
            return _copy(_json_value(page["page_json"]))

    def compact_journal(self, namespace_id: str, before_archive_seq: int) -> None:
        """Test/maintenance seam for proving checkpoint-expiry behavior."""
        if not isinstance(before_archive_seq, int) or before_archive_seq < 1:
            raise ValueError("before_archive_seq must be a positive integer")
        with self._lock:
            self._namespace(namespace_id)
            state = self._archive_state(namespace_id)
            if before_archive_seq > int(state["next_archive_seq"]) + 1:
                raise ValueError("cannot compact beyond the archive head")
            self._begin()
            committed = False
            try:
                # Retention is logical in T3.  The append-only journal is
                # retained for audit/recovery; reconciliation simply refuses
                # cursors older than this advertised boundary.
                self._connection.execute(
                    """
                    UPDATE archive_state SET retained_from = ?, updated_at_ms = ?
                    WHERE namespace_id = ?
                    """,
                    (max(int(state["retained_from"]), before_archive_seq), self._clock(), namespace_id),
                )
                self._connection.execute("COMMIT")
                committed = True
            except Exception:
                if not committed:
                    self._rollback_if_open()
                raise

    def capabilities(self) -> Dict[str, Any]:
        with self._lock:
            retained_from = 1
            rows = self._connection.execute("SELECT retained_from FROM archive_state").fetchall()
            if rows:
                retained_from = min(int(row["retained_from"]) for row in rows)
            return {
                "protocol_versions": [{"major": 1, "minor": 0}],
                "schema_revisions": [SCHEMA_REVISION],
                "hash_algorithm": HASH_ALGORITHM,
                "capability_revision": CAPABILITY_REVISION,
                "limits": {
                    "max_mutations_per_batch": self.max_mutations_per_batch,
                    "max_request_bytes": self.max_request_bytes,
                    "max_page_items": self.max_page_items,
                    "max_page_bytes": self.max_page_bytes,
                    "max_stream_lifetime_ms": self.max_stream_lifetime_ms,
                    "max_stream_pages": self.max_stream_pages,
                    "retained_journal_from": retained_from,
                },
                "features": {
                    "delta_reconciliation": True,
                    "state_bootstrap": True,
                    "idempotent_receipts": True,
                    "tombstones": True,
                    "direct_messages": False,
                    "snapshots": True,
                    "snapshot_restore": True,
                    "durable_destroy_guard": True,
                    "canonical_bundle_bridge": True,
                },
            }

    def archive_info(self) -> Dict[str, Any]:
        with self._lock:
            namespaces: List[Dict[str, Any]] = []
            rows = self._connection.execute(
                "SELECT * FROM namespaces ORDER BY namespace_id"
            ).fetchall()
            for namespace in rows:
                state = self._connection.execute(
                    "SELECT * FROM archive_state WHERE namespace_id = ?",
                    (namespace["namespace_id"],),
                ).fetchone()
                clients = self._connection.execute(
                    "SELECT COUNT(*) AS count FROM clients WHERE namespace_id = ? AND active = 1",
                    (namespace["namespace_id"],),
                ).fetchone()["count"]
                namespaces.append(
                    {
                        "namespace_id": namespace["namespace_id"],
                        "state": namespace["state"],
                        "identity_fingerprint": hashlib.sha256(
                            str(namespace["binding_json"] or "").encode("utf-8")
                        ).hexdigest()[:24],
                        "checkpoint": {
                            "namespace_id": namespace["namespace_id"],
                            "archive_seq": int(state["next_archive_seq"]),
                            "chain_hash": state["chain_hash"],
                            "schema_revision": SCHEMA_REVISION,
                        },
                        "retained_from": int(state["retained_from"]),
                        "admitted_clients": int(clients),
                    }
                )
            return {"archive_id": self.archive_id, "namespaces": namespaces}

    def health(self) -> Dict[str, Any]:
        with self._lock:
            self._hit_failpoint("health_publication")
            info = self.archive_info()
            journal_count = self._connection.execute("SELECT COUNT(*) AS count FROM journal").fetchone()["count"]
            receipt_count = self._connection.execute("SELECT COUNT(*) AS count FROM batches").fetchone()["count"]
            active_namespace_ids = [
                namespace["namespace_id"]
                for namespace in info["namespaces"]
                if namespace["state"] == "active"
            ]
            ready = bool(active_namespace_ids)
            return {
                "protocol": dict(PROTOCOL),
                "ready": ready,
                "companion": {"version": COMPANION_VERSION},
                "archive": info,
                "active_namespace_ids": active_namespace_ids,
                "journal": {"mutation_count": int(journal_count), "receipt_count": int(receipt_count)},
                "capabilities": self.capabilities(),
                "degraded": not ready,
            }

    def verify_integrity(self, namespace_id: str) -> Dict[str, Any]:
        """Recompute stored journal hashes and chain boundaries for the proof harness."""
        with self._lock:
            self._namespace(namespace_id)
            rows = self._connection.execute(
                """
                SELECT archive_seq, batch_id, mutation_id, mutation_json, record_hash,
                       batch_hash, chain_hash
                FROM journal WHERE namespace_id = ? ORDER BY archive_seq
                """,
                (namespace_id,),
            ).fetchall()
            mismatches: List[str] = []
            for row in rows:
                mutation = _json_value(row["mutation_json"])
                if record_hash(namespace_id, mutation) != row["record_hash"]:
                    mismatches.append("record:%s" % row["mutation_id"])
            batch_rows = self._connection.execute(
                """
                SELECT batch_id, batch_hash, archive_from, archive_to, prior_chain_hash,
                       chain_hash, mutation_count
                FROM batches WHERE namespace_id = ? ORDER BY archive_from
                """,
                (namespace_id,),
            ).fetchall()
            prior = ZERO_HASH
            for row in batch_rows:
                if chain_hash(
                    namespace_id,
                    row["prior_chain_hash"],
                    row["batch_hash"],
                    row["archive_from"],
                    row["archive_to"],
                    SCHEMA_REVISION,
                ) != row["chain_hash"]:
                    mismatches.append("chain:%s" % row["batch_id"])
                if row["prior_chain_hash"] != prior:
                    mismatches.append("prior:%s" % row["batch_id"])
                prior = row["chain_hash"]
            current = self._current_checkpoint(namespace_id)
            return {
                "ok": not mismatches and current["chain_hash"] == prior,
                "journal_rows": len(rows),
                "receipt_rows": len(batch_rows),
                "checkpoint": current,
                "mismatches": mismatches,
            }


CompanionStore = CanonicalArchiveStore

__all__ = ["CanonicalArchiveStore", "CompanionStore"]
