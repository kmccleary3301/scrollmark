"""Build artifact-pinned Scrollmark durability release evidence and fail closed."""
from __future__ import annotations

import hashlib
import json
import os
import platform
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Tuple

import jsonschema

ROOT = Path(__file__).resolve().parents[1]
BROWSER = ROOT
COMPANION = ROOT / "scrollmark_companion"
CONTRACTS = ROOT / "contracts" / "scrollmark" / "v1"
CAMPAIGN = BROWSER / ".scratch" / "scrollmark-durability"
EVIDENCE = CAMPAIGN / "evidence"
CARDS = EVIDENCE / "cards"
RELEASE = CAMPAIGN / "release"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while True:
            chunk = source.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def canonical_hash(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def read_json(path: Path) -> Dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise AssertionError("JSON evidence is not an object: %s" % path)
    return value


def relative(path: Path) -> str:
    return path.resolve().relative_to(ROOT).as_posix()


def deterministic_companion_archive(destination: Path) -> None:
    package_files = [
        "__init__.py",
        "__main__.py",
        "errors.py",
        "contract_runtime.py",
        "store.py",
        "server.py",
        "snapshot_crypto.py",
        "snapshots.py",
        "destructive.py",
        "launchagent.py",
        "snapshot-manifest.schema.json",
    ]
    contract_files = [
        "canonical.py",
        "validator.py",
        "reference_model.py",
        "browser-validator.mjs",
        "archive-delta.schema.json",
        "compatibility-matrix.schema.json",
        "compatibility-matrix.json",
        "evidence-card.schema.json",
        "release-manifest.schema.json",
    ]
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for source, name in sorted(
            [(COMPANION / name, "scrollmark_companion/" + name) for name in package_files]
            + [(CONTRACTS / name, "contracts/scrollmark/v1/" + name) for name in contract_files],
            key=lambda item: item[1],
        ):
            if not source.is_file():
                raise AssertionError("release source is missing: %s" % source)
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, source.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)


def run_evidence_command(
    label: str,
    command: List[str],
    *,
    cwd: Path,
    output: Path,
    timeout: int,
    environment: Optional[Mapping[str, str]] = None,
) -> Dict[str, Any]:
    output.unlink(missing_ok=True)
    run_environment = os.environ.copy()
    if environment:
        run_environment.update(environment)
    completed = subprocess.run(
        command,
        cwd=cwd,
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout,
        env=run_environment,
    )
    if completed.returncode != 0:
        raise AssertionError(
            "%s failed (%d): %s" % (label, completed.returncode, completed.stderr[-2000:])
        )
    if not output.is_file():
        raise AssertionError("%s did not create fresh evidence: %s" % (label, output))
    return read_json(output)


def run_t3_card() -> Tuple[Path, Dict[str, Any]]:
    output = COMPANION / "out" / "t3-canonical-store.json"
    output.unlink(missing_ok=True)
    command = subprocess.run(
        [sys.executable, "-m", "scrollmark_companion.harness"],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
        timeout=180,
    )
    if command.returncode != 0:
        raise AssertionError("T3 companion proof failed: %s" % command.stderr[-2000:])
    card = json.loads(command.stdout)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(card, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return output, card


def validate_gate_evidence(gate: str, raw_path: Path, raw: Mapping[str, Any]) -> None:
    status = raw.get("status")
    if status is None and raw.get("ok") is True:
        status = "passed"
    if status != "passed":
        raise AssertionError("non-passing evidence for %s: %s" % (gate, raw_path))
    observed = raw.get("observed")
    fixture = raw.get("fixture")
    expected = raw.get("expected")
    oracles = raw.get("oracles")
    name = raw_path.name
    if name == "t2-neutral-contracts.json":
        counts = fixture.get("record_counts") if isinstance(fixture, dict) else None
        checks = oracles.get("independent_checks") if isinstance(oracles, dict) else None
        if (
            expected != {
                "protocol": "1.0",
                "schema_revision": 1,
                "hash_algorithm": "sha256-jcs-hex",
            }
            or counts != {"mutations": 3, "negative_cases": 7, "canonical_vectors": 4}
            or not isinstance(observed, dict)
            or observed.get("receipt_result") != "committed"
            or observed.get("duplicate_result") != "duplicate"
            or not isinstance(checks, list)
            or len(checks) < 7
        ):
            raise AssertionError("G1 evidence lacks contract, negative-case, and independent-oracle proof")
    elif name == "t3-canonical-store.json":
        if (
            not isinstance(observed, dict)
            or observed.get("duplicate_result") != "duplicate"
            or observed.get("response_loss_code") != "internal_commit_unknown"
            or observed.get("privacy_rejected") is not True
            or int(observed.get("journal_rows", 0)) != 7
            or int(observed.get("receipt_rows", 0)) != 6
            or int(observed.get("bootstrap_pages", 0)) != 3
            or int(observed.get("stream_pages", 0)) != 6
            or not isinstance(observed.get("alpha_checkpoint"), dict)
            or int(observed["alpha_checkpoint"].get("archive_seq", 0)) != 7
            or not isinstance(observed.get("beta_checkpoint"), dict)
            or int(observed["beta_checkpoint"].get("archive_seq", 0)) != 1
        ):
            raise AssertionError("G2 evidence lacks atomic, replay, privacy, and pagination proof")
    elif name == "durability-coordinator-t4.json":
        required_checks = {
            "identity-missing-read-only",
            "identity-conflict-read-only",
            "serialized-concurrent-admission",
            "authenticated-client-proof-validation",
            "fifo-retry-and-bounds",
            "unknown-commit-duplicate-replay",
            "local-projection-divergence",
            "permanent-conflict-quarantine",
            "hard-bound-stop",
            "private-lane-rejection",
        }
        checks = set(observed.get("checks", [])) if isinstance(observed, dict) else set()
        routes = observed.get("routes") if isinstance(observed, dict) else None
        if (
            not required_checks.issubset(checks)
            or not isinstance(routes, dict)
            or set(routes.get("mutation_kinds", []))
            != {"entity_upsert", "relationship_upsert", "tombstone"}
            or int(routes.get("local_writes", 0)) != 11
        ):
            raise AssertionError("G3 evidence lacks coordinator admission, retry, and route proof")
    elif name == "generation-rebuild.json":
        first = observed.get("first") if isinstance(observed, dict) else None
        second = observed.get("second") if isinstance(observed, dict) else None
        repaired = observed.get("partial_repair") if isinstance(observed, dict) else None
        recovered = first.get("recovered_tweet") if isinstance(first, dict) else None
        private_fields = recovered.get("twe_private_fields") if isinstance(recovered, dict) else None
        same_count_repair = observed.get("same_count_repair") if isinstance(observed, dict) else None
        required_counts = {
            "tweets": 2,
            "users": 1,
            "captures": 3,
            "social_edges": 0,
            "search_documents": 3,
            "capture_index_pages": 4,
        }
        if (
            not isinstance(expected, dict)
            or expected.get("pages") != 4
            or expected.get("items") != 8
            or not isinstance(first, dict)
            or not isinstance(second, dict)
            or first.get("counts") != required_counts
            or second.get("counts") != required_counts
            or not isinstance(recovered, dict)
            or recovered.get("__bookmark_folder_id") != "folder-recovered"
            or not isinstance(private_fields, dict)
            or private_fields.get("article_markdown") != "# Recovered article"
            or not isinstance(repaired, dict)
            or repaired.get("verification") != "verified"
            or observed.get("tombstone_stubs_removed") != 1
            or not isinstance(same_count_repair, dict)
            or not isinstance(same_count_repair.get("projection_hash"), str)
        ):
            raise AssertionError("G4 evidence lacks exact rebuild, enrichment, and partial-repair proof")
    elif name == "t6-snapshot-restore.json":
        if (
            not isinstance(observed, dict)
            or not observed
            or any(value is not True for value in observed.values())
            or not isinstance(expected, dict)
            or expected.get("atomic_restore") is not True
            or expected.get("encryption") != "aes-256-gcm"
        ):
            raise AssertionError("G5 snapshot evidence lacks all rollback and encryption invariants")
    elif name == "companion-bundle-bridge.json":
        typed = observed.get("typed_records") if isinstance(observed, dict) else None
        if (
            not isinstance(observed, dict)
            or observed.get("canonical_manifest_verified") is not True
            or observed.get("tampered_page_rejected") is not True
            or observed.get("private_message_material_rejected") is not True
            or int(observed.get("write_operations", -1)) != 0
            or not isinstance(typed, dict)
            or typed.get("records") != 3
        ):
            raise AssertionError("G5 bundle evidence lacks manifest, privacy, and read-only proof")
    elif name == "snapshot-recovery-browser.json":
        if (
            not isinstance(observed, dict)
            or observed.get("restore_calls") != 1
            or observed.get("pending_batches_before") != observed.get("pending_batches_after")
            or observed.get("browser_safety_phase") != "healthy"
        ):
            raise AssertionError("G5 browser recovery evidence lacks outbox-preserving restore proof")
    workload = raw.get("workload")
    if raw_path.name.startswith("durability-scale-"):
        expected_tweets = int(raw_path.stem.rsplit("-", 1)[1])
        if not isinstance(workload, dict) or int(workload.get("tweets", 0)) < expected_tweets:
            raise AssertionError("%s has an undersized tweet workload" % raw_path)
        if int(workload.get("captures", 0)) < 15000:
            raise AssertionError("%s has an undersized capture workload" % raw_path)
        if (
            not isinstance(observed, dict)
            or observed.get("no_truncation") is not True
            or int(observed.get("max_page_items", 0)) > 512
            or int(observed.get("pages_requested", 0)) < 1
        ):
            raise AssertionError("%s lacks bounded, complete pagination evidence" % raw_path)
        counts = observed.get("counts")
        if not isinstance(counts, dict) or int(counts.get("tweets", 0)) != expected_tweets:
            raise AssertionError("%s recovered tweet counts do not match the workload" % raw_path)
    elif raw_path.name == "t7-companion-scale.json":
        if (
            not isinstance(workload, dict)
            or int(workload.get("tweets", 0)) < 40000
            or int(workload.get("captures", 0)) < 15000
        ):
            raise AssertionError("companion scale evidence is below the release workload")
        if (
            not isinstance(observed, dict)
            or observed.get("no_truncation") is not True
            or observed.get("restore_history_appended") is not True
            or observed.get("restore_receipt_checkpoint_equal") is not True
            or observed.get("sqlite_integrity") != "ok"
            or int(observed.get("max_page_items", 0)) > 512
        ):
            raise AssertionError("companion scale evidence lacks exact recovery invariants")
    elif raw_path.name == "t7-launchagent-keychain.json":
        required = {
            "old_token_rejected": True,
            "unsafe_token_file_rejected": True,
            "mobile_origin_admitted": True,
            "encrypted_snapshot_verified": True,
            "archive_preserved": True,
            "pairing_state_preserved": True,
            "service_unreachable_after_uninstall": True,
        }
        if not isinstance(observed, dict) or any(observed.get(key) != value for key, value in required.items()):
            raise AssertionError("LaunchAgent evidence does not prove the release security lifecycle")
    elif raw_path.name == "persistent-profile-recovery.json":
        restored = observed.get("restored_counts") if isinstance(observed, dict) else None
        restarted = observed.get("restart_counts") if isinstance(observed, dict) else None
        protocol_calls = observed.get("protocol_calls") if isinstance(observed, dict) else None
        if (
            not isinstance(observed, dict)
            or observed.get("recovery_reason") != "canonical-rebuild-after-cache-wipe"
            or restored != {"tweets": 2, "users": 1, "captures": 2, "search_documents": 2}
            or restarted != restored
            or observed.get("no_truncation") is not True
            or observed.get("hidden_fallback") is not False
            or not isinstance(protocol_calls, dict)
            or int(protocol_calls.get("reconcile", 0)) < 1
            or int(protocol_calls.get("pages", 0)) < 1
        ):
            raise AssertionError("persistent-profile evidence lacks destructive recovery proof")

def build_userscript_artifact() -> None:
    userscript = BROWSER / "dist" / "scrollmark.user.js"
    userscript.unlink(missing_ok=True)
    completed = subprocess.run(
        ["npm", "run", "build"],
        cwd=BROWSER,
        check=False,
        capture_output=True,
        text=True,
        timeout=300,
    )
    if completed.returncode != 0:
        raise AssertionError("userscript release build failed: %s" % completed.stderr[-2000:])
    if not userscript.is_file():
        raise AssertionError("userscript release build did not create the expected artifact")


def run_release_evidence_suite() -> Dict[str, List[Path]]:
    run_evidence_command(
        "G1 neutral contracts",
        [sys.executable, str(CONTRACTS / "harness.py")],
        cwd=ROOT,
        output=CONTRACTS / "out" / "t2-neutral-contracts.json",
        timeout=180,
    )
    t3_path, _ = run_t3_card()
    browser_jobs = [
        ("G3 coordinator", "test:durability-coordinator", "durability-coordinator-t4.json", 180, None),
        ("G4 generation", "test:generation-rebuild", "generation-rebuild.json", 240, None),
        ("G5 bundle bridge", "test:companion-bundle-bridge", "companion-bundle-bridge.json", 240, None),
        ("G5 browser recovery", "test:snapshot-recovery-browser", "snapshot-recovery-browser.json", 240, None),
        ("G7 persistent profile", "test:persistent-profile-recovery", "persistent-profile-recovery.json", 300, None),
        ("G8 browser scale 40k", "test:durability-scale", "durability-scale-40000.json", 300, None),
        (
            "G8 browser scale 80k",
            "test:durability-scale",
            "durability-scale-80000.json",
            420,
            {"SCROLLMARK_DURABILITY_TWEETS": "80000"},
        ),
    ]
    for label, script, output_name, timeout, environment in browser_jobs:
        run_evidence_command(
            label,
            ["npm", "run", script],
            cwd=BROWSER,
            output=BROWSER / "e2e" / "perf" / "out" / output_name,
            timeout=timeout,
            environment=environment,
        )
    run_evidence_command(
        "G5 companion snapshot recovery",
        [sys.executable, "-m", "scrollmark_companion.recovery_harness"],
        cwd=ROOT,
        output=COMPANION / "out" / "t6-snapshot-restore.json",
        timeout=240,
    )
    run_evidence_command(
        "G6 LaunchAgent lifecycle",
        [sys.executable, "-m", "scrollmark_companion.launchagent_harness"],
        cwd=ROOT,
        output=COMPANION / "out" / "t7-launchagent-keychain.json",
        timeout=180,
    )
    run_evidence_command(
        "G8 companion scale",
        [sys.executable, "-m", "scrollmark_companion.scale_harness"],
        cwd=ROOT,
        output=COMPANION / "out" / "t7-companion-scale.json",
        timeout=600,
    )
    return {
        "G1": [CONTRACTS / "out" / "t2-neutral-contracts.json"],
        "G2": [t3_path],
        "G3": [BROWSER / "e2e" / "perf" / "out" / "durability-coordinator-t4.json"],
        "G4": [BROWSER / "e2e" / "perf" / "out" / "generation-rebuild.json"],
        "G5": [
            COMPANION / "out" / "t6-snapshot-restore.json",
            BROWSER / "e2e" / "perf" / "out" / "companion-bundle-bridge.json",
            BROWSER / "e2e" / "perf" / "out" / "snapshot-recovery-browser.json",
        ],
        "G6": [COMPANION / "out" / "t7-launchagent-keychain.json"],
        "G7": [BROWSER / "e2e" / "perf" / "out" / "persistent-profile-recovery.json"],
        "G8": [
            BROWSER / "e2e" / "perf" / "out" / "durability-scale-40000.json",
            BROWSER / "e2e" / "perf" / "out" / "durability-scale-80000.json",
            COMPANION / "out" / "t7-companion-scale.json",
        ],
    }


def standardized_card(gate: str, raw_path: Path, raw: Mapping[str, Any]) -> Dict[str, Any]:
    raw_hash = sha256(raw_path)
    status = raw.get("status")
    if status is None and raw.get("ok") is True:
        status = "passed"
    if status != "passed":
        raise AssertionError("non-passing evidence for %s: %s" % (gate, raw_path))
    validate_gate_evidence(gate, raw_path, raw)
    scenario = str(raw.get("scenario") or raw.get("card_id") or raw_path.stem)[:160]
    card_id = ("release:%s:%s" % (gate.lower(), raw_path.stem)).replace("_", "-")[:128]
    return {
        "card_version": 1,
        "card_id": card_id,
        "scenario": scenario,
        "status": "passed",
        "source_identity": {
            "source_revision": "sha256:" + raw_hash,
            "config_hash": raw_hash,
            "contract_revision": 1,
            "build_id": "t7-release-evidence-v1",
        },
        "fixture": {
            "name": raw_path.stem,
            "seed": 0,
            "record_counts": {},
            "fixture_hash": raw_hash,
        },
        "expected": {"raw_status": "passed", "gate": gate},
        "observed": {
            "raw_card_id": raw.get("card_id", raw_path.stem),
            "raw_status": status,
            "raw_sha256": raw_hash,
        },
        "oracles": {
            "reference_model_hash": raw_hash,
            "artifact_hashes": {"raw_evidence": raw_hash},
            "independent_checks": ["raw-status-pass", "artifact-sha256", "schema-validation"],
        },
        "privacy": {
            "profile": "safe_shared",
            "redacted": True,
            "dm_allowed": False,
            "excluded_fields": ["bearer_token", "cookies", "direct_messages", "private_keys"],
        },
        "retries": {"attempts": 1, "retryable_failures": 0, "permanent_failures": 0},
        "artifacts": [{"path": relative(raw_path), "sha256": raw_hash, "kind": "metrics"}],
    }


def secret_violations(value: Any, path: str = "$") -> List[str]:
    violations: List[str] = []
    if isinstance(value, dict):
        for key, child in value.items():
            normalized = str(key).lower()
            child_path = "%s.%s" % (path, key)
            if normalized in {"token", "bearer_token", "cookie", "private_key", "recovery_key"}:
                if isinstance(child, str) and child.strip():
                    violations.append(child_path)
            violations.extend(secret_violations(child, child_path))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            violations.extend(secret_violations(child, "%s[%d]" % (path, index)))
    elif isinstance(value, str) and value.startswith("Bearer "):
        violations.append(path)
    return violations


def validate_snapshot_schema(schema: Mapping[str, Any]) -> None:
    sys.path.insert(0, str(ROOT))
    from scrollmark_companion.snapshots import SnapshotManager
    from scrollmark_companion.store import CanonicalArchiveStore

    with tempfile.TemporaryDirectory(prefix="scrollmark-release-schema-") as temporary:
        base = Path(temporary)
        store = CanonicalArchiveStore(base / "archive.sqlite")
        store.admit_namespace("namespace-release-schema", binding={"identity": "release-schema"})
        store.admit_client("namespace-release-schema", "client-release-schema", "epoch-release-schema")
        manager = SnapshotManager(store, base / "snapshots")
        summary = manager.create()
        manifest = read_json(manager.root / summary["snapshot_id"] / "manifest.json")
        jsonschema.validate(manifest, schema)
        store.close()


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main() -> None:
    CARDS.mkdir(parents=True, exist_ok=True)
    RELEASE.mkdir(parents=True, exist_ok=True)
    evidence_schema = read_json(CONTRACTS / "evidence-card.schema.json")
    release_schema = read_json(CONTRACTS / "release-manifest.schema.json")
    snapshot_schema_path = COMPANION / "snapshot-manifest.schema.json"
    snapshot_schema = read_json(snapshot_schema_path)
    jsonschema.Draft202012Validator.check_schema(evidence_schema)
    jsonschema.Draft202012Validator.check_schema(release_schema)
    jsonschema.Draft202012Validator.check_schema(snapshot_schema)
    validate_snapshot_schema(snapshot_schema)
    build_userscript_artifact()

    raw_by_gate = run_release_evidence_suite()
    card_paths: Dict[str, List[str]] = {}
    for gate, paths in raw_by_gate.items():
        card_paths[gate] = []
        for raw_path in paths:
            if not raw_path.is_file():
                raise AssertionError("required evidence is missing: %s" % raw_path)
            raw = read_json(raw_path)
            violations = secret_violations(raw)
            if violations:
                raise AssertionError("privacy scan failed for %s: %s" % (raw_path, violations))
            card = standardized_card(gate, raw_path, raw)
            jsonschema.validate(card, evidence_schema)
            card_path = CARDS / (card["card_id"].replace(":", "-") + ".json")
            write_json(card_path, card)
            card_paths[gate].append(relative(card_path))

    companion_archive = RELEASE / "scrollmark_companion-0.1.0.zip"
    deterministic_companion_archive(companion_archive)
    with zipfile.ZipFile(companion_archive) as packaged:
        corrupt_member = packaged.testzip()
        if corrupt_member is not None:
            raise AssertionError("companion release archive is corrupt: %s" % corrupt_member)
        with tempfile.TemporaryDirectory(prefix="scrollmark-release-artifact-") as temporary:
            packaged.extractall(temporary)
            smoke = subprocess.run(
                [sys.executable, "-m", "scrollmark_companion", "--help"],
                cwd=temporary,
                check=False,
                capture_output=True,
                text=True,
                timeout=30,
            )
            if smoke.returncode != 0:
                raise AssertionError("companion release artifact is not runnable: %s" % smoke.stderr[-1000:])
    userscript = BROWSER / "dist" / "scrollmark.user.js"
    package = read_json(BROWSER / "package.json")
    artifact_bytes = userscript.read_bytes()
    marker = b"// ==/UserScript=="
    marker_index = artifact_bytes.find(marker)
    if marker_index < 0:
        raise AssertionError("built userscript metadata block is missing")
    metadata_bytes = artifact_bytes[: marker_index + len(marker)] + b"\n"
    metadata_hash = hashlib.sha256(metadata_bytes).hexdigest()
    matrix_path = CONTRACTS / "compatibility-matrix.json"
    matrix = read_json(matrix_path)
    harness_sources = [
        CONTRACTS / "harness.py",
        CONTRACTS / "reference_model.py",
        CONTRACTS / "validator.py",
        CONTRACTS / "browser-validator.mjs",
        COMPANION / "harness.py",
        COMPANION / "recovery_harness.py",
        COMPANION / "launchagent_harness.py",
        COMPANION / "scale_harness.py",
        BROWSER / "e2e" / "perf" / "durability_coordinator_harness.ts",
        BROWSER / "e2e" / "perf" / "generation_rebuild_harness.ts",
        BROWSER / "e2e" / "perf" / "companion_bundle_bridge_harness.ts",
        BROWSER / "e2e" / "perf" / "snapshot_recovery_browser_harness.ts",
        BROWSER / "e2e" / "perf" / "persistent_profile_recovery_harness.ts",
        BROWSER / "e2e" / "perf" / "durability_scale_harness.ts",
    ]
    source_material = {
        "userscript": sha256(userscript),
        "companion": sha256(companion_archive),
        "contracts": sha256(matrix_path),
        "dependency_lock": sha256(BROWSER / "package-lock.json"),
        "package_manifest": sha256(BROWSER / "package.json"),
        "release_orchestrator": sha256(Path(__file__)),
        "snapshot_schema": sha256(snapshot_schema_path),
        "evidence": {relative(path): sha256(path) for paths in raw_by_gate.values() for path in paths},
        "harness_sources": {relative(path): sha256(path) for path in harness_sources},
    }
    source_revision = "working-tree-sha256:" + canonical_hash(source_material)
    manifest = {
        "manifest_version": 1,
        "release_id": "scrollmark-%s-durability-v1" % package["version"],
        "source_revision": source_revision,
        "userscript": {
            "version": package["version"],
            "artifact_sha256": sha256(userscript),
            "metadata_sha256": metadata_hash,
        },
        "companion": {
            "version": "0.1.0",
            "runtime": "CPython %s" % platform.python_version(),
            "artifact_sha256": sha256(companion_archive),
        },
        "contracts": {
            "protocol_major": 1,
            "protocol_minor": 0,
            "canonical_schema_revision": 1,
            "matrix_sha256": sha256(matrix_path),
        },
        "migration": {
            "matrix_revision": matrix["matrix_revision"],
            "matrix_sha256": sha256(matrix_path),
        },
        "snapshot_manifest": {"revision": "1", "schema_sha256": sha256(snapshot_schema_path)},
        "supported_clients": [
            {"name": "browser-userscript", "min_version": package["version"], "max_version": package["version"]},
            {"name": "companion-reference", "min_version": "0.1.0", "max_version": "0.1.0"},
        ],
        "evidence_card_schema_sha256": sha256(CONTRACTS / "evidence-card.schema.json"),
    }
    jsonschema.validate(manifest, release_schema)
    manifest_path = EVIDENCE / "release-manifest.json"
    write_json(manifest_path, manifest)

    weights = {"G1": 15, "G2": 15, "G3": 10, "G4": 10, "G5": 15, "G6": 10, "G7": 10, "G8": 15}
    gates = {
        gate: {
            "status": "passed",
            "score": weights[gate],
            "max_score": weights[gate],
            "cards": card_paths[gate],
        }
        for gate in weights
    }
    score = sum(value["score"] for value in gates.values())
    report = {
        "report_version": 1,
        "release_id": manifest["release_id"],
        "generated_at_ms": int(time.time() * 1000),
        "status": "passed" if score >= 90 else "failed",
        "score": score,
        "max_score": 100,
        "minimum_score": 90,
        "minimum_category_percent": 70,
        "gates": gates,
        "checks": {
            "all_required_cards_present": True,
            "all_cards_schema_valid": True,
            "all_raw_cards_passed": True,
            "snapshot_manifest_schema_valid": True,
            "release_manifest_schema_valid": True,
            "privacy_scan_passed": True,
            "artifact_hashes_pinned": True,
            "no_truncation": True,
            "hidden_fallback": False,
        },
        "release_manifest": {"path": relative(manifest_path), "sha256": sha256(manifest_path)},
        "companion_artifact": {"path": relative(companion_archive), "sha256": sha256(companion_archive)},
        "dependency_lock": {
            "path": relative(BROWSER / "package-lock.json"),
            "sha256": sha256(BROWSER / "package-lock.json"),
        },
    }
    if report["status"] != "passed":
        raise AssertionError("release score is below threshold")
    write_json(EVIDENCE / "gate-report.json", report)
    print(json.dumps({"status": report["status"], "score": score, "gates": list(gates), "source_revision": source_revision}))


if __name__ == "__main__":
    main()
