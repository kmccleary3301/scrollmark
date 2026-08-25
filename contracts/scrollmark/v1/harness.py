#!/usr/bin/env python3
"""Focused T2 proof harness for neutral contracts and independent oracles."""

from __future__ import annotations

import copy
import json
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from canonical import batch_hash, dump_json, file_sha256, record_hash, sha256_hex  # noqa: E402
from reference_model import (  # noqa: E402
    BoundedOutbox,
    ProjectionGeneration,
    ReferenceArchive,
    ReferenceModelError,
)
from validator import (  # noqa: E402
    validate_evidence_card,
    validate_error,
    validate_matrix,
    validate_receipt,
    validate_reconciliation_request,
    validate_request,
    validate_schema_artifact,
)


class HarnessFailure(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise HarnessFailure(message)


def load_json(name: str) -> Any:
    return json.loads((ROOT / name).read_text(encoding="utf-8"))


def assert_expected_errors(value: Any, expected_code: str, name: str) -> List[Dict[str, str]]:
    errors = validate_matrix(value) if isinstance(value, dict) and value.get("format") == "scrollmark.compatibility-matrix.v1" else validate_request(value)
    codes = {error["code"] for error in errors}
    require(expected_code in codes, f"{name}: expected {expected_code}, got {sorted(codes)}")
    return errors


def make_single_mutation_request(base: Dict[str, Any], mutation: Dict[str, Any], batch_id: str) -> Dict[str, Any]:
    request = copy.deepcopy(base)
    request["request_id"] = f"{batch_id}-request"
    request["client_sequence"] = {"from": mutation["client_seq"], "to": mutation["client_seq"]}
    request["batch"] = {
        "batch_id": batch_id,
        "mutation_count": 1,
        "mutations": [mutation],
        "batch_hash": "0" * 64,
    }
    mutation["record_hash"] = record_hash(request["namespace_id"], mutation)
    request["batch"]["batch_hash"] = batch_hash(request["namespace_id"], request["batch"])
    return request


def run() -> Dict[str, Any]:
    schema_names = [
        "archive-delta.schema.json",
        "compatibility-matrix.schema.json",
        "evidence-card.schema.json",
        "release-manifest.schema.json",
    ]
    schema_errors: List[Dict[str, str]] = []
    for name in schema_names:
        schema_errors.extend(validate_schema_artifact(load_json(name), name))
    require(not schema_errors, f"schema artifacts invalid: {schema_errors}")

    matrix = load_json("compatibility-matrix.json")
    matrix_errors = validate_matrix(matrix)
    require(not matrix_errors, f"compatibility matrix invalid: {matrix_errors}")

    vectors = load_json("fixtures/canonicalization.json")["vectors"]
    vector_results = []
    for vector in vectors:
        from canonical import canonicalize

        canonical = canonicalize(vector["input"])
        digest = sha256_hex(canonical.encode("utf-8"))
        require(canonical == vector["canonical"], f"canonical vector mismatch: {vector['name']}")
        require(digest == vector["sha256"], f"hash vector mismatch: {vector['name']}")
        vector_results.append({"name": vector["name"], "sha256": digest})

    positive = load_json("examples/archive-delta-request.json")
    positive_errors = validate_request(positive)
    require(not positive_errors, f"positive request rejected: {positive_errors}")

    negatives = load_json("fixtures/negative.json")
    negative_results = []
    for fixture in negatives:
        errors = assert_expected_errors(fixture["value"], fixture["expected_code"], fixture["name"])
        negative_results.append({"name": fixture["name"], "errors": len(errors)})

    browser_process = subprocess.run(
        ["node", str(ROOT / "browser-validator.mjs")],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    require(browser_process.returncode == 0, browser_process.stderr or "browser oracle failed")
    browser_result = json.loads(browser_process.stdout)
    require(browser_result["ok"], f"browser oracle reported failure: {browser_result}")
    require(browser_result["positiveValid"], "browser validator rejected positive request")
    for result in browser_result["negativeResults"]:
        expected = next(item["expected_code"] for item in negatives if item["name"] == result["name"])
        require(expected in result["codes"], f"browser negative mismatch: {result}")

    model = ReferenceArchive("archive-demo", "namespace-alpha")
    receipt = model.apply_batch(positive)
    require(not validate_receipt(receipt), "reference receipt failed receipt validator")
    reconciliation_example = load_json("examples/reconciliation-request.json")
    require(not validate_reconciliation_request(reconciliation_example), "reconciliation example failed validator")
    protocol_error_example = load_json("examples/protocol-error.json")
    require(not validate_error(protocol_error_example), "protocol error example failed validator")
    duplicate_request = copy.deepcopy(positive)
    duplicate_request["request_id"] = "req-replay"
    duplicate = model.apply_batch(duplicate_request)
    require(duplicate["result"] == "duplicate", "exact replay did not return duplicate proof")
    require(duplicate["batch_hash"] == receipt["batch_hash"], "duplicate proof changed batch hash")

    conflict_request = copy.deepcopy(positive)
    conflict_request["request_id"] = "req-conflict"
    conflict_request["batch"]["batch_hash"] = "f" * 64
    try:
        model.apply_batch(conflict_request)
    except ReferenceModelError as error:
        require(error.code == "mutation_hash_conflict", f"wrong replay conflict code: {error.code}")
    else:
        raise HarnessFailure("changed batch replay was accepted")

    tombstone = {
        "mutation_id": "mutation-delete-1",
        "client_seq": 4,
        "kind": "tombstone",
        "schema_revision": 1,
        "target_kind": "tweet",
        "target_id": "tweet-1",
        "deletion_id": "deletion-1",
        "record_hash": "0" * 64,
        "provenance": {"source": "fixture", "source_event_id": "event-delete-1"},
        "observed_at_ms": 1700000000004,
    }
    delete_request = make_single_mutation_request(positive, tombstone, "batch-delete-1")
    delete_receipt = model.apply_batch(delete_request)
    require(delete_receipt["archive_sequence"] == {"from": 4, "to": 4}, "tombstone sequence mismatch")

    resurrection = {
        "mutation_id": "mutation-resurrect-1",
        "client_seq": 5,
        "kind": "entity_upsert",
        "schema_revision": 1,
        "target": {"namespace_id": "namespace-alpha", "kind": "tweet", "id": "tweet-1"},
        "payload": {"rest_id": "tweet-1", "text": "resurrect"},
        "record_hash": "0" * 64,
        "provenance": {"source": "fixture", "source_event_id": "event-resurrect-1"},
        "observed_at_ms": 1700000000005,
    }
    resurrection_request = make_single_mutation_request(positive, resurrection, "batch-resurrect-1")
    try:
        model.apply_batch(resurrection_request)
    except ReferenceModelError as error:
        require(error.code == "tombstone_resurrection", f"wrong tombstone code: {error.code}")
    else:
        raise HarnessFailure("tombstoned entity was resurrected")

    small_outbox = BoundedOutbox(max_mutations=2, max_bytes=100_000, max_age_ms=1000)
    try:
        small_outbox.add(positive["batch"], 1000)
    except ReferenceModelError as error:
        require(error.code == "outbox_bound_exceeded", f"wrong outbox bound code: {error.code}")
    else:
        raise HarnessFailure("outbox accepted a batch over its mutation bound")
    require(small_outbox.status(1000)["stopped"], "outbox did not enter stopped state")

    age_outbox = BoundedOutbox(max_mutations=10, max_bytes=100_000, max_age_ms=1000)
    age_outbox.add({**positive["batch"], "mutations": [positive["batch"]["mutations"][0]], "mutation_count": 1}, 1000)
    age_status = age_outbox.status(2001)
    require(age_status["stopped"] and age_status["stop_reason"] == "age_bound", "outbox age bound was not enforced")

    generation = ProjectionGeneration("generation-1", "namespace-alpha")
    checkpoint = model.checkpoint()
    generation.stage_page(0, [{"kind": "tweet", "id": "tweet-1"}], final=True)
    staged_state = {"namespace_id": "namespace-alpha", "pages": generation.pages, "checkpoint": checkpoint}
    generation_hash = sha256_hex(staged_state)
    require(generation.activate(checkpoint, generation_hash) == generation_hash, "projection generation did not activate")

    artifact_paths = [ROOT / name for name in schema_names] + [ROOT / "compatibility-matrix.json", ROOT / "fixtures/canonicalization.json", ROOT / "examples/archive-delta-request.json"]
    artifact_hashes = {str(path.relative_to(ROOT)): file_sha256(path) for path in artifact_paths}
    card = {
        "card_version": 1,
        "card_id": "t2-neutral-contracts",
        "scenario": "neutral-contracts-and-independent-oracles",
        "status": "passed",
        "source_identity": {"source_revision": "uncommitted-working-tree", "config_hash": sha256_hex(matrix), "contract_revision": 1},
        "fixture": {
            "name": "archive-delta-demo",
            "seed": 1,
            "record_counts": {"mutations": 3, "negative_cases": len(negatives), "canonical_vectors": len(vectors)},
            "fixture_hash": sha256_hex(positive),
        },
        "expected": {"protocol": "1.0", "schema_revision": 1, "hash_algorithm": "sha256-jcs-hex"},
        "observed": {
            "receipt_result": receipt["result"],
            "duplicate_result": duplicate["result"],
            "checkpoint": model.checkpoint(),
            "state_digest": model.state_digest(),
            "generation_hash": generation_hash,
            "browser_oracle": browser_result["canonicalization_impl"],
        },
        "oracles": {
            "reference_model_hash": model.state_digest(),
            "artifact_hashes": artifact_hashes,
            "independent_checks": [
                "python-jcs-vectors",
                "javascript-jcs-vectors",
                "python-browser-positive-parity",
                "python-browser-negative-parity",
                "atomic-receipt-replay-conflict",
                "tombstone-no-resurrection",
                "outbox-stop-before-loss",
                "generation-activate-after-hash",
            ],
        },
        "privacy": {
            "profile": "safe_shared",
            "redacted": True,
            "dm_allowed": False,
            "excluded_fields": ["bearer_token", "cookies", "raw_graphql", "direct_messages"],
        },
        "retries": {"attempts": 1, "retryable_failures": 0, "permanent_failures": 0},
        "artifacts": [{"path": relative, "sha256": digest, "kind": "fixture"} for relative, digest in artifact_hashes.items()],
    }
    card_errors = validate_evidence_card(card)
    require(not card_errors, f"generated evidence card failed validator: {card_errors}")
    dump_json(ROOT / "examples/commit-receipt.json", receipt)
    output_path = ROOT / "out/t2-neutral-contracts.json"
    output_path.parent.mkdir(exist_ok=True)
    dump_json(output_path, card)
    return {
        "ok": True,
        "card": str(output_path.relative_to(ROOT)),
        "schema_count": len(schema_names),
        "canonical_vectors": len(vectors),
        "positive_cases": 1,
        "negative_cases": len(negatives),
        "receipt_checks": ["committed", "duplicate", "mutation_hash_conflict"],
        "state_digest": model.state_digest(),
        "generation_hash": generation_hash,
        "browser_oracle": browser_result["canonicalization_impl"],
    }


if __name__ == "__main__":
    try:
        print(json.dumps(run(), ensure_ascii=False, separators=(",", ":")))
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False, separators=(",", ":")))
        raise
