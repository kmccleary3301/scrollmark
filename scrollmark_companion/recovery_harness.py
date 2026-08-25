"""Focused T6 proof gate for snapshots, restore, destruction, and recovery HTTP APIs."""
from __future__ import annotations

import hashlib
import json
import shutil
import tempfile
from pathlib import Path
from typing import Any, Dict, Mapping, Optional

from .contract_runtime import sha256_hex, validate_evidence_card
from .destructive import DurableDestroyGuard
from .errors import CompanionError
from .harness import CLIENT, EPOCH, NAMESPACE, ORIGIN, TOKEN, _http, _mutation, _request
from .server import CompanionConfig, CompanionServer
from .snapshot_crypto import InMemorySnapshotKeyStore, aes256_gcm_decrypt, aes256_gcm_encrypt
from .snapshots import SnapshotManager
from .store import CanonicalArchiveStore

EVIDENCE_PATH = Path(__file__).resolve().parent / "out" / "t6-snapshot-restore.json"


def _assert(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def _commit(store: CanonicalArchiveStore, sequence: int, checkpoint: Optional[Mapping[str, Any]]) -> Dict[str, Any]:
    mutation = _mutation(
        NAMESPACE,
        "t6-mutation-%d" % sequence,
        sequence,
        target_id="tweet-%d" % sequence,
        text="snapshot-state-%d" % sequence,
    )
    return store.commit(
        _request(
            store.archive_id,
            NAMESPACE,
            CLIENT,
            EPOCH,
            "req-t6-%d" % sequence,
            [mutation],
            known_checkpoint=checkpoint,
        )
    )


def _expect_code(action, code: str) -> None:
    try:
        action()
    except CompanionError as error:
        _assert(error.code == code, "expected %s, got %s" % (code, error.code))
        return
    raise AssertionError("expected %s failure" % code)

def _expect_failure(action) -> None:
    try:
        action()
    except Exception:
        return
    raise AssertionError("expected injected failure")


def run() -> Dict[str, Any]:
    observed: Dict[str, Any] = {}
    with tempfile.TemporaryDirectory(prefix="scrollmark-t6-") as temporary:
        root = Path(temporary)
        db_path = root / "archive.sqlite3"
        vector_payload = aes256_gcm_encrypt(b"\x00" * 32, b"\x00" * 16, b"", b"\x00" * 12)
        _assert(
            vector_payload[-32:].hex()
            == "d0d1c8a799996bf0265b98b5d48ab919cea7403d4d606b6e074ec5d3baf39d18",
            "AES-256-GCM output diverged from the NIST vector",
        )
        _assert(
            aes256_gcm_decrypt(b"\x00" * 32, vector_payload, b"") == b"\x00" * 16,
            "AES-256-GCM NIST vector did not round trip",
        )
        snapshots_root = root / "snapshots"
        key_store = InMemorySnapshotKeyStore()
        store = CanonicalArchiveStore(db_path)
        store.admit_namespace(NAMESPACE, binding={"identity": "proof-account"})
        store.admit_client(NAMESPACE, CLIENT, EPOCH)
        checkpoint1 = _commit(store, 1, None)["checkpoint"]
        manager = SnapshotManager(store, snapshots_root, key_store=key_store)

        plaintext = manager.create()
        encrypted = manager.create(encrypted=True, recovery_key_path=root / "recovery-key.txt")
        _assert(plaintext["verification"]["state"] == "verified", "plaintext snapshot was not verified")
        _assert(encrypted["image"]["mode"] == "aes-256-gcm", "encrypted snapshot mode is wrong")
        manager.verify(snapshots_root / plaintext["snapshot_id"], expected_archive_id=store.archive_id)
        manager.verify(snapshots_root / encrypted["snapshot_id"], expected_archive_id=store.archive_id)
        _assert((root / "recovery-key.txt").stat().st_mode & 0o777 == 0o600, "recovery key permissions are unsafe")

        _expect_code(
            lambda: manager.verify(
                snapshots_root / plaintext["snapshot_id"],
                expected_archive_id="wrong-archive",
            ),
            "archive_binding_mismatch",
        )
        missing_key_manager = SnapshotManager(
            store,
            snapshots_root,
            key_store=InMemorySnapshotKeyStore(),
        )
        _expect_code(
            lambda: missing_key_manager.verify(snapshots_root / encrypted["snapshot_id"]),
            "snapshot_key_unavailable",
        )

        corrupted_path = snapshots_root / "snapshot-corrupt-proof"
        shutil.copytree(snapshots_root / plaintext["snapshot_id"], corrupted_path)
        manifest = json.loads((corrupted_path / "manifest.json").read_text(encoding="utf-8"))
        image_path = corrupted_path / manifest["image"]["path"]
        image_bytes = bytearray(image_path.read_bytes())
        image_bytes[len(image_bytes) // 2] ^= 0x01
        image_path.write_bytes(image_bytes)
        _expect_code(lambda: manager.verify(corrupted_path), "snapshot_corrupt")
        shutil.rmtree(corrupted_path)

        failed_root = root / "failed-publication"
        failed_store = CanonicalArchiveStore(root / "failed.sqlite3", failpoints={"snapshot_after_marker"})
        failed_store.admit_namespace(NAMESPACE, binding={"identity": "proof-account"})
        failed_store.admit_client(NAMESPACE, CLIENT, EPOCH)
        _commit(failed_store, 1, None)
        failed_manager = SnapshotManager(failed_store, failed_root)
        _expect_failure(lambda: failed_manager.create())
        _assert(failed_manager.list_verified() == [], "failed snapshot candidate became visible")
        failed_store.close()

        checkpoint2 = _commit(store, 2, checkpoint1)["checkpoint"]
        store._failpoints.add("restore_after_active_switch")
        _expect_code(
            lambda: manager.restore(
                snapshots_root / plaintext["snapshot_id"],
                expected_namespace_ids=[NAMESPACE],
            ),
            "restore_failed",
        )
        store._failpoints.clear()
        _assert(store.checkpoint(NAMESPACE) == checkpoint2, "failed restore changed the active checkpoint")
        restored = manager.restore(
            snapshots_root / plaintext["snapshot_id"],
            expected_namespace_ids=[NAMESPACE],
        )
        restored_checkpoint = restored["checkpoints"][NAMESPACE]
        _assert(restored_checkpoint["archive_seq"] > checkpoint2["archive_seq"], "restore reused archive sequence")
        integrity = store.verify_integrity(NAMESPACE)
        _assert(integrity["ok"], "restored archive journal integrity failed")

        rotated = manager.rotate(hourly=0, daily=0, monthly=0, dry_run=True)
        _assert(rotated["retained"], "rotation did not protect a verified snapshot")
        _assert(plaintext["snapshot_id"] in rotated["retained"], "restored snapshot was not protected")

        guard = DurableDestroyGuard(store, manager)
        disclosure = {
            "archive_id": store.archive_id,
            "namespace_ids": [NAMESPACE],
            "migration_active": False,
            "pending_count": 2,
            "pending_acknowledged": True,
            "explicit_loss_acknowledgement": False,
        }
        challenge = guard.preflight(disclosure)
        _assert(
            challenge["namespace_disclosures"][0]["identity_fingerprint"],
            "destroy challenge omitted account identity disclosure",
        )
        _expect_code(
            lambda: guard.confirm(
                {
                    "challenge_id": challenge["challenge_id"],
                    "archive_id": store.archive_id,
                    "phrase": "wrong",
                    "second_confirmation": True,
                }
            ),
            "destroy_guard_failed",
        )
        _assert(store.checkpoint(NAMESPACE) == restored_checkpoint, "bad destroy phrase mutated archive")
        challenge = guard.preflight(disclosure)
        receipt = guard.confirm(
            {
                "challenge_id": challenge["challenge_id"],
                "archive_id": store.archive_id,
                "phrase": challenge["required_phrase"],
                "second_confirmation": True,
            }
        )
        _assert(receipt["state"] == "destroyed", "guarded destruction did not complete")
        _assert(manager.list_verified(), "durable destruction removed verified snapshots")
        store.close()

        http_store = CanonicalArchiveStore(root / "http.sqlite3")
        http_store.admit_namespace(NAMESPACE, binding={"identity": "proof-account"})
        http_store.admit_client(NAMESPACE, CLIENT, EPOCH)
        _commit(http_store, 1, None)
        server = CompanionServer(
            http_store,
            CompanionConfig(token=TOKEN, port=0, snapshot_root=str(root / "http-snapshots")),
            key_store=InMemorySnapshotKeyStore(),
        )
        server.start()
        base_url = "http://%s:%d" % server.address
        try:
            status, payload = _http(base_url, "GET", "/v1/snapshots", token=None)
            _assert(status == 401 and payload["code"] == "auth_required", "snapshot API admitted unauthenticated request")
            status, created = _http(
                base_url,
                "POST",
                "/v1/snapshots",
                body={"request_id": "t6-http-create", "encrypted": True},
            )
            _assert(status == 201, "authenticated snapshot creation failed")
            _assert(created["archive_id"] == http_store.archive_id, "snapshot response archive binding is missing")
            snapshot_id = created["snapshot"]["snapshot_id"]
            status, verified = _http(
                base_url,
                "POST",
                "/v1/snapshots/%s/verify" % snapshot_id,
                body={"request_id": "t6-http-verify", "namespace_ids": [NAMESPACE]},
            )
            _assert(status == 200 and verified["snapshot_id"] == snapshot_id, "snapshot verification endpoint failed")
            status, listed = _http(base_url, "GET", "/v1/snapshots")
            _assert(status == 200 and len(listed["snapshots"]) == 1, "snapshot listing endpoint failed")
        finally:
            server.stop()
            http_store.close()

        observed.update(
            {
                "plaintext_verified": True,
                "encrypted_verified": True,
                "corruption_rejected": True,
                "wrong_binding_rejected": True,
                "missing_key_rejected": True,
                "failed_publication_hidden": True,
                "restore_rollback_preserved_checkpoint": True,
                "restore_sequence_not_reused": True,
                "rotation_protected_restored_snapshot": True,
                "durable_destroy_guarded": True,
                "snapshots_preserved_after_destroy": True,
                "authenticated_recovery_api": True,
            }
        )
    return observed


def _file_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def evidence_card(status: str, observed: Mapping[str, Any], failure: Optional[str] = None) -> Dict[str, Any]:
    package_root = Path(__file__).resolve().parent
    source_files = ["snapshots.py", "snapshot_crypto.py", "destructive.py", "server.py", "recovery_harness.py"]
    artifact_hashes = {name: _file_hash(package_root / name) for name in source_files}
    safe_observed = dict(observed)
    if failure:
        safe_observed["failure"] = failure
    card: Dict[str, Any] = {
        "card_version": 1,
        "card_id": "t6-snapshot-restore-proof",
        "scenario": "verified snapshots, rollback-safe restore, guarded destruction, and recovery API",
        "status": status,
        "source_identity": {
            "source_revision": "scrollmark-companion-0.1.0",
            "config_hash": sha256_hex({"snapshot_format": "twe.snapshot.v1", "retention": [24, 30, 12]}),
            "contract_revision": 1,
            "build_id": "t6-proof",
        },
        "fixture": {
            "name": "companion-t6-recovery-fixture",
            "seed": 6,
            "record_counts": {"batches": 2, "namespaces": 1, "streams": 0},
            "fixture_hash": sha256_hex({"fixture": "companion-t6", "seed": 6}),
        },
        "expected": {
            "snapshot_format": "twe.snapshot.v1",
            "encryption": "aes-256-gcm",
            "atomic_restore": True,
            "dm_allowed": False,
        },
        "observed": safe_observed,
        "oracles": {
            "reference_model_hash": sha256_hex({"snapshot": "verified", "restore": "compensating-forward"}),
            "artifact_hashes": artifact_hashes,
            "independent_checks": ["sqlite-integrity", "journal-chain", "aes-gcm-vector", "http-auth"],
        },
        "privacy": {
            "profile": "private_archive",
            "redacted": True,
            "dm_allowed": False,
            "excluded_fields": ["bearer_token", "encryption_key", "raw_payload", "direct_messages"],
        },
        "retries": {"attempts": 1, "retryable_failures": 0, "permanent_failures": 5},
        "artifacts": [
            {"path": "scrollmark_companion/%s" % name, "sha256": artifact_hashes[name], "kind": "metrics" if name == "recovery_harness.py" else "manifest"}
            for name in source_files
        ],
    }
    errors = validate_evidence_card(card)
    if errors:
        raise AssertionError("T6 evidence card failed neutral validation: %r" % errors)
    return card


def _emit(card: Mapping[str, Any]) -> None:
    encoded = json.dumps(card, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    EVIDENCE_PATH.parent.mkdir(parents=True, exist_ok=True)
    EVIDENCE_PATH.write_text(encoded, encoding="utf-8")
    print(encoded, end="")


def main() -> int:
    observed: Dict[str, Any] = {}
    try:
        observed = run()
        card = evidence_card("passed", observed)
        _emit(card)
        return 0
    except Exception as error:
        card = evidence_card("failed", observed, failure="%s: %s" % (type(error).__name__, error))
        _emit(card)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
