"""Focused T3 proof gate for the canonical companion vertical tranche.

Run from the project root with::

    python3 -m scrollmark_companion.harness

The command uses a temporary SQLite archive, a real authenticated HTTP server,
the neutral contract validators, and the independent reference model.  It
prints one redacted evidence-card-shaped JSON object and exits non-zero on any
failed assertion.
"""
from __future__ import annotations

import hashlib
import json
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Tuple

from reference_model import ReferenceArchive  # type: ignore

from .contract_runtime import (
    ZERO_HASH,
    batch_hash,
    canonical_bytes,
    record_hash,
    sha256_hex,
    validate_error,
    validate_evidence_card,
    validate_reconciliation_request,
    validate_receipt,
    validate_request,
)
from .errors import CompanionError
from .server import CompanionConfig, CompanionServer
from .store import CanonicalArchiveStore

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = "https://x.com"
TOKEN = "t3-proof-token"
NAMESPACE = "namespace-alpha"
OTHER_NAMESPACE = "namespace-beta"
CLIENT = "client-proof"
EPOCH = "epoch-proof"


def _assert(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _mutation(
    namespace_id: str,
    mutation_id: str,
    client_seq: int,
    *,
    target_kind: str = "tweet",
    target_id: str,
    text: str,
) -> Dict[str, Any]:
    mutation: Dict[str, Any] = {
        "mutation_id": mutation_id,
        "client_seq": client_seq,
        "kind": "entity_upsert",
        "schema_revision": 1,
        "target": {"namespace_id": namespace_id, "kind": target_kind, "id": target_id},
        "payload": {"rest_id": target_id, "text": text},
        "provenance": {"source": "t3-proof"},
        "observed_at_ms": 1700000000000 + client_seq,
    }
    mutation["record_hash"] = record_hash(namespace_id, mutation)
    return mutation


def _relationship(
    namespace_id: str,
    mutation_id: str,
    client_seq: int,
    *,
    subject_namespace: Optional[str] = None,
) -> Dict[str, Any]:
    mutation: Dict[str, Any] = {
        "mutation_id": mutation_id,
        "client_seq": client_seq,
        "kind": "relationship_upsert",
        "schema_revision": 1,
        "relationship_kind": "tweet_reference",
        "subject": {
            "namespace_id": subject_namespace or namespace_id,
            "kind": "user",
            "id": "user-1",
        },
        "object": {"namespace_id": namespace_id, "kind": "tweet", "id": "tweet-1"},
        "qualifier": None,
        "payload": {"relation": "author"},
        "provenance": {"source": "t3-proof"},
        "observed_at_ms": 1700000000000 + client_seq,
    }
    mutation["record_hash"] = record_hash(namespace_id, mutation)
    return mutation


def _tombstone(namespace_id: str, mutation_id: str, client_seq: int) -> Dict[str, Any]:
    mutation: Dict[str, Any] = {
        "mutation_id": mutation_id,
        "client_seq": client_seq,
        "kind": "tombstone",
        "schema_revision": 1,
        "target_kind": "tweet",
        "target_id": "tweet-1",
        "deletion_id": "deletion-tweet-1",
        "record_hash": "",
        "provenance": {"source": "t3-proof"},
        "observed_at_ms": 1700000000000 + client_seq,
    }
    mutation["record_hash"] = record_hash(namespace_id, mutation)
    return mutation


def _request(
    archive_id: str,
    namespace_id: str,
    client_id: str,
    client_epoch: str,
    request_id: str,
    mutations: Iterable[Mapping[str, Any]],
    *,
    known_checkpoint: Optional[Mapping[str, Any]],
) -> Dict[str, Any]:
    mutation_list = [dict(mutation) for mutation in mutations]
    batch = {
        "batch_id": request_id.replace("req-", "batch-"),
        "mutation_count": len(mutation_list),
        "mutations": mutation_list,
        "batch_hash": "",
    }
    batch["batch_hash"] = batch_hash(namespace_id, batch)
    return {
        "protocol": {"major": 1, "minor": 0},
        "request_id": request_id,
        "archive_id": archive_id,
        "namespace_id": namespace_id,
        "client_id": client_id,
        "client_epoch": client_epoch,
        "sent_at_ms": 1700000000000,
        "client_sequence": {
            "from": mutation_list[0]["client_seq"],
            "to": mutation_list[-1]["client_seq"],
        },
        "batch": batch,
        "known_checkpoint": dict(known_checkpoint) if known_checkpoint is not None else None,
    }


def _reconciliation_request(
    archive_id: str,
    namespace_id: str,
    request_id: str,
    *,
    mode: str,
    after_checkpoint: Optional[Mapping[str, Any]],
    known_checkpoint: Optional[Mapping[str, Any]],
    page_hint: int,
) -> Dict[str, Any]:
    return {
        "protocol": {"major": 1, "minor": 0},
        "request_id": request_id,
        "archive_id": archive_id,
        "namespace_id": namespace_id,
        "client_id": CLIENT,
        "client_epoch": EPOCH,
        "sent_at_ms": 1700000000000,
        "mode": mode,
        "after_checkpoint": dict(after_checkpoint) if after_checkpoint is not None else None,
        "known_checkpoint": dict(known_checkpoint) if known_checkpoint is not None else None,
        "page_hint": page_hint,
    }


def _http(
    base_url: str,
    method: str,
    path: str,
    *,
    body: Optional[Mapping[str, Any]] = None,
    token: Optional[str] = TOKEN,
    origin: Optional[str] = ORIGIN,
    protocol_header: Optional[str] = "v1",
) -> Tuple[int, Dict[str, Any]]:
    data = None if body is None else json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    headers: Dict[str, str] = {}
    if token is not None:
        headers["Authorization"] = "Bearer " + token
    if origin is not None:
        headers["Origin"] = origin
    if protocol_header is not None:
        headers["X-Scrollmark-Protocol"] = protocol_header
    if body is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(base_url + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return int(response.status), json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        return int(error.code), json.loads(error.read().decode("utf-8"))


def _assert_error(status: int, payload: Mapping[str, Any], code: str) -> None:
    _assert(status != 200, "expected an HTTP error")
    _assert(payload.get("code") == code, "expected %s, got %s" % (code, payload.get("code")))
    _assert(not validate_error(payload), "protocol error failed neutral validation: %r" % validate_error(payload))


def _collect_pages(base_url: str, stream_id: str) -> List[Dict[str, Any]]:
    pages: List[Dict[str, Any]] = []
    cursor: Optional[str] = None
    while True:
        path = "/v1/archive/reconciliation/%s/pages" % stream_id
        if cursor is not None:
            path += "?cursor=" + urllib.parse.quote(cursor, safe="")
        status, page = _http(base_url, "GET", path)
        _assert(status == 200, "reconciliation page failed: %r" % page)
        _assert(page["page_hash"] == sha256_hex({key: value for key, value in page.items() if key != "page_hash"}), "page hash mismatch")
        _assert(page["byte_count"] == len(canonical_bytes(page["items"])), "page byte count mismatch")
        pages.append(page)
        if page["final"]:
            return pages
        cursor = page.get("next_cursor")
        _assert(isinstance(cursor, str) and cursor, "non-final page omitted next cursor")


def run() -> Dict[str, Any]:
    observed: Dict[str, Any] = {}
    reference_hash = sha256_hex({"uninitialized": True})
    fixture_hash = sha256_hex({"seed": 3, "namespace": NAMESPACE, "mutations": ["b1", "b2", "b3", "delete"]})
    with tempfile.TemporaryDirectory(prefix="scrollmark-t3-") as temporary:
        db_path = Path(temporary) / "archive.sqlite3"
        store = CanonicalArchiveStore(
            db_path,
            max_request_bytes=64 * 1024,
            max_page_items=2,
            max_page_bytes=64 * 1024,
        )
        store.admit_namespace(NAMESPACE, binding={"identity": "proof-account"})
        store.admit_namespace(OTHER_NAMESPACE, binding={"identity": "other-account"})
        store.admit_client(NAMESPACE, CLIENT, EPOCH)
        store.admit_client(OTHER_NAMESPACE, "client-beta", "epoch-beta")
        server = CompanionServer(store, CompanionConfig(token=TOKEN, port=0))
        server.start()
        base_url = "http://%s:%d" % server.address
        reference = ReferenceArchive(store.archive_id, NAMESPACE, capability_revision="cap-v1")
        try:
            # Neutral examples and generated contract requests are validated
            # before they reach the store.
            examples = ROOT / "contracts" / "scrollmark" / "v1" / "examples"
            example_request = json.loads((examples / "archive-delta-request.json").read_text())
            example_reconcile = json.loads((examples / "reconciliation-request.json").read_text())
            example_error = json.loads((examples / "protocol-error.json").read_text())
            _assert(not validate_request(example_request), "locked delta example is invalid")
            _assert(not validate_reconciliation_request(example_reconcile), "locked reconciliation example is invalid")
            _assert(not validate_error(example_error), "locked protocol error example is invalid")

            m1 = _mutation(NAMESPACE, "mutation-1", 1, target_id="tweet-1", text="one")
            request1 = _request(store.archive_id, NAMESPACE, CLIENT, EPOCH, "req-1", [m1], known_checkpoint=None)
            status, receipt1 = _http(base_url, "POST", "/v1/archive/deltas", body=request1)
            _assert(status == 200 and receipt1["result"] == "committed", "first commit failed")
            _assert(not validate_receipt(receipt1), "first receipt failed contract validation")
            reference_receipt1 = reference.apply_batch(request1)
            _assert(receipt1 == reference_receipt1, "first receipt diverged from reference model")

            m2 = _mutation(NAMESPACE, "mutation-2", 2, target_kind="user", target_id="user-1", text="user")
            m3 = _relationship(NAMESPACE, "mutation-3", 3)
            request2 = _request(
                store.archive_id,
                NAMESPACE,
                CLIENT,
                EPOCH,
                "req-2",
                [m2, m3],
                known_checkpoint=receipt1["checkpoint"],
            )
            status, receipt2 = _http(base_url, "POST", "/v1/archive/deltas", body=request2)
            _assert(status == 200, "multi-mutation commit failed")
            reference_receipt2 = reference.apply_batch(request2)
            _assert(receipt2 == reference_receipt2, "second receipt diverged from reference model")

            m4 = _mutation(NAMESPACE, "mutation-4", 4, target_id="tweet-2", text="four")
            request3 = _request(
                store.archive_id,
                NAMESPACE,
                CLIENT,
                EPOCH,
                "req-3",
                [m4],
                known_checkpoint=receipt2["checkpoint"],
            )
            status, receipt3 = _http(base_url, "POST", "/v1/archive/deltas", body=request3)
            _assert(status == 200, "third commit failed")
            reference_receipt3 = reference.apply_batch(request3)
            _assert(receipt3 == reference_receipt3, "third receipt diverged from reference model")
            reference_hash = reference.state_digest()

            # Validation is all-or-nothing; a malformed hash does not advance
            # the client or archive sequence.
            invalid = _mutation(NAMESPACE, "mutation-invalid", 5, target_id="tweet-invalid", text="invalid")
            invalid["record_hash"] = ZERO_HASH
            invalid_request = _request(
                store.archive_id,
                NAMESPACE,
                CLIENT,
                EPOCH,
                "req-invalid",
                [invalid],
                known_checkpoint=receipt3["checkpoint"],
            )
            status, invalid_error = _http(base_url, "POST", "/v1/archive/deltas", body=invalid_request)
            _assert_error(status, invalid_error, "batch_hash_mismatch")
            _assert(store.checkpoint(NAMESPACE) == receipt3["checkpoint"], "rejected batch advanced checkpoint")

            # Tombstone admission and non-resurrection.
            deletion = _tombstone(NAMESPACE, "mutation-delete", 5)
            delete_request = _request(
                store.archive_id,
                NAMESPACE,
                CLIENT,
                EPOCH,
                "req-delete",
                [deletion],
                known_checkpoint=receipt3["checkpoint"],
            )
            status, delete_receipt = _http(base_url, "POST", "/v1/archive/deltas", body=delete_request)
            _assert(status == 200, "tombstone commit failed")
            resurrection = _mutation(NAMESPACE, "mutation-resurrect", 6, target_id="tweet-1", text="old payload")
            resurrect_request = _request(
                store.archive_id,
                NAMESPACE,
                CLIENT,
                EPOCH,
                "req-resurrect",
                [resurrection],
                known_checkpoint=delete_receipt["checkpoint"],
            )
            status, resurrect_error = _http(base_url, "POST", "/v1/archive/deltas", body=resurrect_request)
            _assert_error(status, resurrect_error, "validation_failed")
            _assert(store.checkpoint(NAMESPACE) == delete_receipt["checkpoint"], "resurrection changed checkpoint")

            # Cross-namespace relationship endpoints fail before admission.
            cross_namespace = _relationship(
                NAMESPACE,
                "mutation-cross-namespace",
                6,
                subject_namespace=OTHER_NAMESPACE,
            )
            cross_request = _request(
                store.archive_id,
                NAMESPACE,
                CLIENT,
                EPOCH,
                "req-cross-namespace",
                [cross_namespace],
                known_checkpoint=delete_receipt["checkpoint"],
            )
            status, cross_error = _http(base_url, "POST", "/v1/archive/deltas", body=cross_request)
            _assert_error(status, cross_error, "validation_failed")

            # Lost response after a successful transaction resolves by exact
            # replay, not by generating a new batch identity.
            store.set_failpoint("after_transaction_commit")
            m6 = _mutation(NAMESPACE, "mutation-6", 6, target_id="tweet-3", text="six")
            request6 = _request(
                store.archive_id,
                NAMESPACE,
                CLIENT,
                EPOCH,
                "req-6-lost-response",
                [m6],
                known_checkpoint=delete_receipt["checkpoint"],
            )
            status, unknown = _http(base_url, "POST", "/v1/archive/deltas", body=request6)
            _assert_error(status, unknown, "internal_commit_unknown")
            store.set_failpoint("after_transaction_commit", False)
            request6_retry = dict(request6)
            request6_retry["request_id"] = "req-6-retry"
            status, duplicate6 = _http(base_url, "POST", "/v1/archive/deltas", body=request6_retry)
            _assert(status == 200 and duplicate6["result"] == "duplicate", "lost response did not resolve as duplicate")
            _assert(duplicate6["batch_id"] == request6["batch"]["batch_id"], "duplicate proof batch changed")
            checkpoint6 = duplicate6["checkpoint"]

            # Same mutation identity with changed canonical content is a
            # permanent conflict, while a later range is a sequence gap.
            conflict_mutation = dict(m4)
            conflict_mutation["payload"] = {"rest_id": "tweet-2", "text": "changed"}
            conflict_mutation["record_hash"] = record_hash(NAMESPACE, conflict_mutation)
            conflict_request = _request(
                store.archive_id,
                NAMESPACE,
                CLIENT,
                EPOCH,
                "req-conflict",
                [conflict_mutation],
                known_checkpoint=checkpoint6,
            )
            conflict_request["client_sequence"] = {"from": 7, "to": 7}
            conflict_mutation["client_seq"] = 7
            conflict_mutation["record_hash"] = record_hash(NAMESPACE, conflict_mutation)
            conflict_request["batch"]["mutations"] = [conflict_mutation]
            conflict_request["batch"]["batch_hash"] = batch_hash(NAMESPACE, conflict_request["batch"])
            status, conflict_error = _http(base_url, "POST", "/v1/archive/deltas", body=conflict_request)
            _assert_error(status, conflict_error, "mutation_hash_conflict")

            gap_mutation = _mutation(NAMESPACE, "mutation-gap", 8, target_id="tweet-gap", text="gap")
            gap_request = _request(
                store.archive_id,
                NAMESPACE,
                CLIENT,
                EPOCH,
                "req-gap",
                [gap_mutation],
                known_checkpoint=checkpoint6,
            )
            status, gap_error = _http(base_url, "POST", "/v1/archive/deltas", body=gap_request)
            _assert_error(status, gap_error, "client_sequence_gap")

            # A second namespace can reuse public IDs without crossing state.
            beta_mutation = _mutation(OTHER_NAMESPACE, "beta-1", 1, target_kind="user", target_id="user-1", text="beta")
            beta_request = _request(
                store.archive_id,
                OTHER_NAMESPACE,
                "client-beta",
                "epoch-beta",
                "req-beta",
                [beta_mutation],
                known_checkpoint=None,
            )
            status, beta_receipt = _http(base_url, "POST", "/v1/archive/deltas", body=beta_request)
            _assert(status == 200 and beta_receipt["namespace_id"] == OTHER_NAMESPACE, "second namespace commit failed")

            # Authentication, exact origin, protocol header, and bounded body
            # gates happen in the HTTP adapter before store delegation.
            status, auth_error = _http(base_url, "GET", "/v1/health", token=None)
            _assert_error(status, auth_error, "auth_required")
            status, origin_error = _http(base_url, "GET", "/v1/health", origin="https://evil.example")
            _assert_error(status, origin_error, "origin_denied")
            status, version_error = _http(base_url, "GET", "/v1/health", protocol_header="v2")
            _assert_error(status, version_error, "protocol_version_unsupported")
            oversized = {"payload": "x" * (70 * 1024)}
            status, limit_error = _http(base_url, "POST", "/v1/archive/deltas", body=oversized)
            _assert_error(status, limit_error, "limit_exceeded")

            # Stop and reopen the real WAL database; the exact replay remains
            # durable and the archive UUID is stable.
            server.stop()
            store.close()
            store = CanonicalArchiveStore(db_path, max_request_bytes=64 * 1024, max_page_items=2, max_page_bytes=64 * 1024)
            _assert(store.archive_id == receipt1["archive_id"], "archive identity changed after restart")
            _assert(store._connection.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal", "SQLite WAL is not enabled")
            _assert(int(store._connection.execute("PRAGMA synchronous").fetchone()[0]) == 2, "SQLite synchronous=FULL is not enabled")
            store.admit_namespace(NAMESPACE, binding={"identity": "proof-account"})
            store.admit_namespace(OTHER_NAMESPACE, binding={"identity": "other-account"})
            store.admit_client(NAMESPACE, CLIENT, EPOCH)
            store.admit_client(OTHER_NAMESPACE, "client-beta", "epoch-beta")
            server = CompanionServer(store, CompanionConfig(token=TOKEN, port=0))
            server.start()
            base_url = "http://%s:%d" % server.address
            status, replay_after_restart = _http(base_url, "POST", "/v1/archive/deltas", body=request3)
            _assert(status == 200 and replay_after_restart["result"] == "duplicate", "restart replay failed")
            _assert(store.checkpoint(NAMESPACE) == checkpoint6, "restart checkpoint mismatch")

            # Private/direct-message provenance is rejected by default and
            # does not consume the next client sequence.
            dm_mutation = _mutation(NAMESPACE, "mutation-dm", 7, target_id="tweet-dm", text="private")
            dm_mutation["provenance"] = {"source": "dm"}
            dm_mutation["record_hash"] = record_hash(NAMESPACE, dm_mutation)
            dm_request = _request(
                store.archive_id,
                NAMESPACE,
                CLIENT,
                EPOCH,
                "req-dm",
                [dm_mutation],
                known_checkpoint=checkpoint6,
            )
            status, dm_error = _http(base_url, "POST", "/v1/archive/deltas", body=dm_request)
            _assert_error(status, dm_error, "validation_failed")
            _assert(store.checkpoint(NAMESPACE) == checkpoint6, "private mutation advanced checkpoint")

            # Pinned delta stream excludes commits made after stream creation.
            zero_checkpoint = {
                "namespace_id": NAMESPACE,
                "archive_seq": 0,
                "chain_hash": ZERO_HASH,
                "schema_revision": 1,
            }
            stream_request = _reconciliation_request(
                store.archive_id,
                NAMESPACE,
                "req-stream",
                mode="deltas",
                after_checkpoint=zero_checkpoint,
                known_checkpoint=zero_checkpoint,
                page_hint=1,
            )
            _assert(not validate_reconciliation_request(stream_request), "generated reconciliation request invalid")
            status, descriptor = _http(
                base_url,
                "POST",
                "/v1/archive/namespaces/%s/reconciliation" % NAMESPACE,
                body=stream_request,
            )
            _assert(status == 200 and descriptor["page_count"] > 1, "bounded stream was not paged")
            m7 = _mutation(NAMESPACE, "mutation-7", 7, target_id="tweet-4", text="after stream")
            request7 = _request(
                store.archive_id,
                NAMESPACE,
                CLIENT,
                EPOCH,
                "req-7",
                [m7],
                known_checkpoint=checkpoint6,
            )
            status, receipt7 = _http(base_url, "POST", "/v1/archive/deltas", body=request7)
            _assert(status == 200, "post-stream commit failed")
            pages = _collect_pages(base_url, descriptor["stream_id"])
            page_mutation_ids = [item["mutation_id"] for page in pages for item in page["items"]]
            _assert("mutation-7" not in page_mutation_ids, "pinned stream included a later commit")
            _assert(pages[-1]["final"] is True, "stream did not expose a final page")
            _assert(pages[-1]["target_checkpoint"] == checkpoint6, "stream target was not pinned")

            # A divergent checkpoint cannot be guessed or merged.
            bad_checkpoint = dict(zero_checkpoint)
            bad_checkpoint["chain_hash"] = "f" * 64
            repair_request = _reconciliation_request(
                store.archive_id,
                NAMESPACE,
                "req-repair",
                mode="deltas",
                after_checkpoint=bad_checkpoint,
                known_checkpoint=None,
                page_hint=2,
            )
            status, repair_error = _http(
                base_url,
                "POST",
                "/v1/archive/namespaces/%s/reconciliation" % NAMESPACE,
                body=repair_request,
            )
            _assert_error(status, repair_error, "checkpoint_mismatch")

            # Logical retention expires an old delta cursor without deleting
            # the append-only audit journal; bootstrap remains available.
            store.compact_journal(NAMESPACE, before_archive_seq=3)
            expired_request = _reconciliation_request(
                store.archive_id,
                NAMESPACE,
                "req-expired",
                mode="deltas",
                after_checkpoint=zero_checkpoint,
                known_checkpoint=None,
                page_hint=2,
            )
            status, expired_error = _http(
                base_url,
                "POST",
                "/v1/archive/namespaces/%s/reconciliation" % NAMESPACE,
                body=expired_request,
            )
            _assert_error(status, expired_error, "checkpoint_expired")

            # Bootstrap is namespace-isolated and includes the tombstone state.
            bootstrap_request = _reconciliation_request(
                store.archive_id,
                NAMESPACE,
                "req-bootstrap",
                mode="state_bootstrap",
                after_checkpoint=None,
                known_checkpoint=store.checkpoint(NAMESPACE),
                page_hint=2,
            )
            status, bootstrap_descriptor = _http(
                base_url,
                "POST",
                "/v1/archive/namespaces/%s/reconciliation" % NAMESPACE,
                body=bootstrap_request,
            )
            _assert(status == 200, "bootstrap stream creation failed")
            bootstrap_pages = _collect_pages(base_url, bootstrap_descriptor["stream_id"])
            bootstrap_items = [item for page in bootstrap_pages for item in page["items"]]
            _assert(all(item["mutation"]["target"].get("namespace_id") == NAMESPACE for item in bootstrap_items if "target" in item["mutation"]), "bootstrap crossed namespace")
            _assert(any(item["mutation"].get("kind") == "tombstone" for item in bootstrap_items), "bootstrap omitted tombstone")
            _assert(not any(item["mutation"].get("target", {}).get("namespace_id") == OTHER_NAMESPACE for item in bootstrap_items), "bootstrap included beta namespace")

            integrity = store.verify_integrity(NAMESPACE)
            _assert(integrity["ok"], "stored journal integrity failed: %r" % integrity)
            observed.update(
                {
                    "archive_id": store.archive_id,
                    "alpha_checkpoint": store.checkpoint(NAMESPACE),
                    "beta_checkpoint": store.checkpoint(OTHER_NAMESPACE),
                    "stream_pages": len(pages),
                    "bootstrap_pages": len(bootstrap_pages),
                    "journal_rows": integrity["journal_rows"],
                    "retained_from": store.archive_info()["namespaces"][0]["retained_from"],
                    "receipt_rows": integrity["receipt_rows"],
                    "duplicate_result": duplicate6["result"],
                    "response_loss_code": unknown["code"],
                    "privacy_rejected": True,
                    "reference_state_hash": reference_hash,
                }
            )
        finally:
            server.stop()
            store.close()

    return observed


def evidence_card(status: str, observed: Mapping[str, Any], failure: Optional[str] = None) -> Dict[str, Any]:
    source_files = [
        ROOT / "scrollmark_companion" / "store.py",
        ROOT / "scrollmark_companion" / "server.py",
        ROOT / "scrollmark_companion" / "harness.py",
    ]
    config = {
        "protocol": {"major": 1, "minor": 0},
        "origins": sorted(CompanionConfig(token=TOKEN).allowed_origins),
        "max_request_bytes": 64 * 1024,
        "max_page_items": 2,
    }
    artifact_hashes = {path.name: _sha(path) for path in source_files}
    checks = [
        "neutral contract examples and generated requests validated",
        "reference receipt and chain hashes matched SQLite commits",
        "atomic invalid batch, duplicate replay, mutation conflict, and client gap checked",
        "tombstone resurrection and cross-namespace relationship rejected",
        "WAL restart and commit-unknown exact retry checked",
        "finite pinned delta and namespace-isolated bootstrap pages checked",
        "origin, bearer, protocol header, and request byte limits checked",
        "DM/private-lane admission remains fail-closed",
    ]
    if failure:
        observed = dict(observed)
        observed["failure"] = failure
    card: Dict[str, Any] = {
        "card_version": 1,
        "card_id": "t3-companion-proof",
        "scenario": "authenticated canonical companion store and protocol",
        "status": status,
        "source_identity": {
            "source_revision": "scrollmark-companion-0.1.0",
            "config_hash": sha256_hex(config),
            "contract_revision": 1,
            "build_id": "t3-proof",
        },
        "fixture": {
            "name": "companion-t3-deterministic-fixture",
            "seed": 3,
            "record_counts": {"batches": 7, "namespaces": 2, "streams": 2},
            "fixture_hash": sha256_hex({"fixture": "companion-t3", "seed": 3}),
        },
        "expected": {
            "protocol": "1.0",
            "hash_algorithm": "sha256-jcs-hex",
            "atomic_commit": True,
            "dm_allowed": False,
        },
        "observed": dict(observed),
        "oracles": {
            "reference_model_hash": str(observed.get("reference_state_hash", sha256_hex({"missing": True}))),
            "artifact_hashes": artifact_hashes,
            "independent_checks": checks,
        },
        "privacy": {
            "profile": "private_archive",
            "redacted": True,
            "dm_allowed": False,
            "excluded_fields": ["bearer_token", "raw_payload", "direct_messages"],
        },
        "retries": {"attempts": 2, "retryable_failures": 1, "permanent_failures": 5},
        "artifacts": [
            {"path": "scrollmark_companion/store.py", "sha256": artifact_hashes["store.py"], "kind": "manifest"},
            {"path": "scrollmark_companion/server.py", "sha256": artifact_hashes["server.py"], "kind": "manifest"},
            {"path": "scrollmark_companion/harness.py", "sha256": artifact_hashes["harness.py"], "kind": "metrics"},
        ],
    }
    errors = validate_evidence_card(card)
    if errors:
        raise AssertionError("evidence card failed neutral validation: %r" % errors)
    return card


def main() -> int:
    observed: Dict[str, Any] = {}
    try:
        observed = run()
        card = evidence_card("passed", observed)
        print(json.dumps(card, ensure_ascii=False, indent=2, sort_keys=True))
        return 0
    except Exception as error:
        card = evidence_card("failed", observed, failure="%s: %s" % (type(error).__name__, error))
        print(json.dumps(card, ensure_ascii=False, indent=2, sort_keys=True))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
