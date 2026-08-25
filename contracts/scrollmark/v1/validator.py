"""Dependency-free semantic validators for the neutral v1 contracts."""

from __future__ import annotations

import re
from typing import Any, Dict, Iterable, List

from canonical import batch_hash, record_hash

ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
HASH_RE = re.compile(r"^[0-9a-f]{64}$")
MUTATION_KINDS = {
    "entity_upsert",
    "relationship_upsert",
    "enrichment_upsert",
    "tombstone",
}
ENTITY_KINDS = {"tweet", "user", "folder", "media_reference"}
RELATIONSHIP_KINDS = {
    "capture_membership",
    "bookmark_folder_membership",
    "social_edge",
    "tweet_reference",
    "interaction_state",
    "article_media_association",
}
ERROR_CODES = {
    "protocol_version_unsupported",
    "auth_required",
    "origin_denied",
    "archive_binding_mismatch",
    "namespace_not_active",
    "identity_required",
    "client_epoch_unknown",
    "client_sequence_gap",
    "batch_hash_mismatch",
    "mutation_hash_conflict",
    "validation_failed",
    "checkpoint_mismatch",
    "checkpoint_expired",
    "stream_expired",
    "limit_exceeded",
    "companion_busy",
    "companion_unavailable",
    "internal_commit_unknown",
}


def _error(errors: List[Dict[str, str]], code: str, path: str, message: str) -> None:
    errors.append({"code": code, "path": path, "message": message})


def _required(value: Any, fields: Iterable[str], path: str, errors: List[Dict[str, str]]) -> None:
    if not isinstance(value, dict):
        _error(errors, "type", path, "expected object")
        return
    for field in fields:
        if field not in value:
            _error(errors, f"missing:{field}", f"{path}.{field}", "required field is missing")


def _id(value: Any, path: str, errors: List[Dict[str, str]]) -> None:
    if not isinstance(value, str) or not ID_RE.fullmatch(value):
        _error(errors, "invalid_id", path, "expected an opaque bounded identifier")


def _hash(value: Any, path: str, errors: List[Dict[str, str]]) -> None:
    if not isinstance(value, str) or not HASH_RE.fullmatch(value):
        _error(errors, "invalid_hash", path, "expected lowercase SHA-256 hex")


def _protocol(value: Any, path: str, errors: List[Dict[str, str]]) -> None:
    _required(value, ("major", "minor"), path, errors)
    if not isinstance(value, dict):
        return
    unknown_keys = set(value) - {"major", "minor", "extensions"}
    if unknown_keys:
        _error(errors, "unknown_required_field", path, "unknown protocol fields are not admitted as required semantics")
    if value.get("major") != 1 or value.get("minor") != 0:
        _error(errors, "protocol_version_unsupported", path, "only protocol 1.0 is admitted")


def _endpoint(value: Any, namespace_id: str, path: str, errors: List[Dict[str, str]]) -> None:
    _required(value, ("namespace_id", "kind", "id"), path, errors)
    if not isinstance(value, dict):
        return
    _id(value.get("namespace_id"), f"{path}.namespace_id", errors)
    if value.get("namespace_id") != namespace_id:
        _error(errors, "relationship_namespace_context_required", path, "endpoint namespace differs from request namespace")
    if value.get("kind") not in ENTITY_KINDS:
        _error(errors, "invalid_endpoint_kind", f"{path}.kind", "endpoint kind is not admitted")
    _id(value.get("id"), f"{path}.id", errors)


def _provenance(value: Any, path: str, errors: List[Dict[str, str]]) -> None:
    _required(value, ("source",), path, errors)
    if not isinstance(value, dict):
        return
    if not isinstance(value.get("source"), str) or not value["source"]:
        _error(errors, "invalid_provenance", f"{path}.source", "source is required")


def _mutation(mutation: Any, namespace_id: str, path: str, errors: List[Dict[str, str]]) -> None:
    required = (
        "mutation_id",
        "client_seq",
        "kind",
        "schema_revision",
        "record_hash",
        "provenance",
        "observed_at_ms",
    )
    _required(mutation, required, path, errors)
    if not isinstance(mutation, dict):
        return
    _id(mutation.get("mutation_id"), f"{path}.mutation_id", errors)
    if not isinstance(mutation.get("client_seq"), int) or mutation["client_seq"] < 1:
        _error(errors, "invalid_client_sequence", f"{path}.client_seq", "client sequence must be positive integer")
    if mutation.get("schema_revision") != 1:
        _error(errors, "schema_revision_unsupported", f"{path}.schema_revision", "schema revision is not admitted")
    if mutation.get("kind") not in MUTATION_KINDS:
        _error(errors, "invalid_mutation_kind", f"{path}.kind", "mutation kind is not admitted")
        return
    _hash(mutation.get("record_hash"), f"{path}.record_hash", errors)
    _provenance(mutation.get("provenance"), f"{path}.provenance", errors)
    if not isinstance(mutation.get("observed_at_ms"), int) or mutation["observed_at_ms"] < 0:
        _error(errors, "invalid_observed_at", f"{path}.observed_at_ms", "observed time must be non-negative integer")
    if mutation["kind"] == "entity_upsert":
        _required(mutation, ("target", "payload"), path, errors)
        _endpoint(mutation.get("target"), namespace_id, f"{path}.target", errors)
        if not isinstance(mutation.get("payload"), dict):
            _error(errors, "invalid_payload", f"{path}.payload", "entity payload must be object")
    elif mutation["kind"] == "relationship_upsert":
        _required(mutation, ("relationship_kind", "subject", "object", "qualifier", "payload"), path, errors)
        if mutation.get("relationship_kind") not in RELATIONSHIP_KINDS:
            _error(errors, "invalid_relationship_kind", f"{path}.relationship_kind", "relationship kind is not admitted")
        _endpoint(mutation.get("subject"), namespace_id, f"{path}.subject", errors)
        _endpoint(mutation.get("object"), namespace_id, f"{path}.object", errors)
        if mutation.get("qualifier") is not None and not isinstance(mutation.get("qualifier"), dict):
            _error(errors, "invalid_qualifier", f"{path}.qualifier", "qualifier must be object or null")
        if not isinstance(mutation.get("payload"), dict):
            _error(errors, "invalid_payload", f"{path}.payload", "relationship payload must be object")
    elif mutation["kind"] == "enrichment_upsert":
        _required(mutation, ("target", "enrichment_kind", "payload"), path, errors)
        _endpoint(mutation.get("target"), namespace_id, f"{path}.target", errors)
        if mutation.get("enrichment_kind") not in {"article_markdown", "media_reference"}:
            _error(errors, "invalid_enrichment_kind", f"{path}.enrichment_kind", "enrichment kind is not admitted")
        if not isinstance(mutation.get("payload"), dict):
            _error(errors, "invalid_payload", f"{path}.payload", "enrichment payload must be object")
    else:
        _required(mutation, ("target_kind", "target_id", "deletion_id"), path, errors)
        if mutation.get("target_kind") not in {"tweet", "user", "folder", "media_reference", "relationship", "enrichment"}:
            _error(errors, "invalid_tombstone_kind", f"{path}.target_kind", "tombstone target kind is not admitted")
        _id(mutation.get("target_id"), f"{path}.target_id", errors)
        _id(mutation.get("deletion_id"), f"{path}.deletion_id", errors)


def validate_request(value: Any) -> List[Dict[str, str]]:
    errors: List[Dict[str, str]] = []
    _required(
        value,
        (
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
        ),
        "request",
        errors,
    )
    if not isinstance(value, dict):
        return errors
    _protocol(value.get("protocol"), "request.protocol", errors)
    for field in ("request_id", "archive_id", "namespace_id", "client_id", "client_epoch"):
        _id(value.get(field), f"request.{field}", errors)
    if not isinstance(value.get("sent_at_ms"), int) or value["sent_at_ms"] < 0:
        _error(errors, "invalid_sent_at", "request.sent_at_ms", "sent_at_ms must be non-negative integer")
    sequence = value.get("client_sequence")
    _required(sequence, ("from", "to"), "request.client_sequence", errors)
    if isinstance(sequence, dict):
        if not isinstance(sequence.get("from"), int) or not isinstance(sequence.get("to"), int):
            _error(errors, "invalid_client_sequence", "request.client_sequence", "sequence bounds must be integers")
        elif sequence["from"] < 1 or sequence["to"] < sequence["from"]:
            _error(errors, "invalid_client_sequence", "request.client_sequence", "sequence range is invalid")
    batch = value.get("batch")
    _required(batch, ("batch_id", "mutation_count", "mutations", "batch_hash"), "request.batch", errors)
    if not isinstance(batch, dict):
        return errors
    _id(batch.get("batch_id"), "request.batch.batch_id", errors)
    _hash(batch.get("batch_hash"), "request.batch.batch_hash", errors)
    mutations = batch.get("mutations")
    if not isinstance(mutations, list) or not mutations:
        _error(errors, "empty_batch", "request.batch.mutations", "batch must contain mutations")
        return errors
    if batch.get("mutation_count") != len(mutations):
        _error(errors, "mutation_count_mismatch", "request.batch.mutation_count", "count does not match mutations")
    for index, mutation in enumerate(mutations):
        _mutation(mutation, value.get("namespace_id"), f"request.batch.mutations[{index}]", errors)
    sequence_values = [mutation.get("client_seq") for mutation in mutations if isinstance(mutation, dict)]
    if isinstance(sequence, dict) and sequence_values:
        expected = list(range(sequence.get("from", 0), sequence.get("to", -1) + 1))
        if sequence_values != expected:
            _error(errors, "client_sequence_not_contiguous", "request.batch.mutations", "mutation sequences are not contiguous")
        if sequence.get("from") != sequence_values[0] or sequence.get("to") != sequence_values[-1]:
            _error(errors, "client_sequence_range_mismatch", "request.client_sequence", "range does not match mutations")
    if not errors:
        for mutation in mutations:
            expected_record_hash = record_hash(value["namespace_id"], mutation)
            if mutation["record_hash"] != expected_record_hash:
                _error(errors, "record_hash_mismatch", "request.batch.mutations", "record hash does not match canonical content")
        if batch["batch_hash"] != batch_hash(value["namespace_id"], batch):
            _error(errors, "batch_hash_mismatch", "request.batch.batch_hash", "batch hash does not match canonical content")
    checkpoint = value.get("known_checkpoint")
    if checkpoint is not None:
        validate_checkpoint(checkpoint, value.get("namespace_id"), errors, "request.known_checkpoint")
    return errors


def validate_checkpoint(value: Any, namespace_id: str, errors: List[Dict[str, str]], path: str = "checkpoint") -> None:
    _required(value, ("namespace_id", "archive_seq", "chain_hash", "schema_revision"), path, errors)
    if not isinstance(value, dict):
        return
    _id(value.get("namespace_id"), f"{path}.namespace_id", errors)
    if value.get("namespace_id") != namespace_id:
        _error(errors, "namespace_mismatch", path, "checkpoint namespace differs")
    if not isinstance(value.get("archive_seq"), int) or value["archive_seq"] < 0:
        _error(errors, "invalid_archive_sequence", f"{path}.archive_seq", "archive sequence must be non-negative integer")
    _hash(value.get("chain_hash"), f"{path}.chain_hash", errors)
    if value.get("schema_revision") != 1:
        _error(errors, "schema_revision_unsupported", f"{path}.schema_revision", "schema revision is not admitted")


def validate_receipt(value: Any) -> List[Dict[str, str]]:
    errors: List[Dict[str, str]] = []
    _required(
        value,
        (
            "protocol",
            "request_id",
            "archive_id",
            "namespace_id",
            "client_id",
            "client_epoch",
            "batch_id",
            "result",
            "client_sequence",
            "archive_sequence",
            "mutation_count",
            "batch_hash",
            "prior_chain_hash",
            "chain_hash",
            "checkpoint",
            "capability_revision",
        ),
        "receipt",
        errors,
    )
    if not isinstance(value, dict):
        return errors
    _protocol(value.get("protocol"), "receipt.protocol", errors)
    for field in ("request_id", "archive_id", "namespace_id", "client_id", "client_epoch", "batch_id", "capability_revision"):
        _id(value.get(field), f"receipt.{field}", errors)
    if value.get("result") not in {"committed", "duplicate"}:
        _error(errors, "invalid_receipt_result", "receipt.result", "result is not admitted")
    for field in ("batch_hash", "prior_chain_hash", "chain_hash"):
        _hash(value.get(field), f"receipt.{field}", errors)
    if not isinstance(value.get("mutation_count"), int) or value["mutation_count"] < 1:
        _error(errors, "invalid_mutation_count", "receipt.mutation_count", "count must be positive integer")
    for field in ("client_sequence", "archive_sequence"):
        sequence = value.get(field)
        _required(sequence, ("from", "to"), f"receipt.{field}", errors)
        if isinstance(sequence, dict):
            sequence_from = sequence.get("from")
            sequence_to = sequence.get("to")
            if not isinstance(sequence_from, int) or not isinstance(sequence_to, int) or sequence_to < sequence_from:
                _error(errors, "invalid_sequence_range", f"receipt.{field}", "range is invalid")
    validate_checkpoint(value.get("checkpoint"), value.get("namespace_id"), errors, "receipt.checkpoint")
    return errors


def validate_error(value: Any) -> List[Dict[str, str]]:
    errors: List[Dict[str, str]] = []
    _required(value, ("protocol", "request_id", "code", "retryable", "message"), "error", errors)
    if not isinstance(value, dict):
        return errors
    _protocol(value.get("protocol"), "error.protocol", errors)
    _id(value.get("request_id"), "error.request_id", errors)
    if value.get("code") not in ERROR_CODES:
        _error(errors, "invalid_error_code", "error.code", "error code is not in the compatibility matrix")
    if not isinstance(value.get("retryable"), bool):
        _error(errors, "invalid_retryable", "error.retryable", "retryable must be boolean")
    if not isinstance(value.get("message"), str) or not value["message"]:
        _error(errors, "invalid_error_message", "error.message", "safe message is required")
    return errors


def validate_matrix(value: Any) -> List[Dict[str, str]]:
    errors: List[Dict[str, str]] = []
    if not isinstance(value, dict):
        return [{"code": "type", "path": "matrix", "message": "expected object"}]
    if value.get("format") != "scrollmark.compatibility-matrix.v1":
        _error(errors, "matrix_format", "matrix.format", "unexpected matrix format")
    protocol = value.get("protocol", {})
    if protocol.get("major") != 1 or protocol.get("minor_min") != 0 or protocol.get("minor_max") != 0:
        _error(errors, "matrix_protocol", "matrix.protocol", "matrix must pin protocol 1.0")
    canonical = value.get("canonical_schema", {})
    if canonical.get("current_revision") != 1 or canonical.get("accepted_revisions") != [1]:
        _error(errors, "matrix_schema", "matrix.canonical_schema", "matrix must pin schema revision 1")
    if canonical.get("unknown_major_action") != "fail_closed" or canonical.get("unknown_required_field_action") != "fail_closed":
        _error(errors, "matrix_fail_closed", "matrix.canonical_schema", "unknown required compatibility must fail closed")
    if value.get("features", {}).get("direct_messages") is not False:
        _error(errors, "privacy_dm_enabled", "matrix.features.direct_messages", "DM feature must remain disabled")
    return errors


def validate_schema_artifact(value: Any, path: str) -> List[Dict[str, str]]:
    errors: List[Dict[str, str]] = []
    if not isinstance(value, dict):
        return [{"code": "type", "path": path, "message": "schema must be object"}]
    if value.get("$schema") != "https://json-schema.org/draft/2020-12/schema":
        _error(errors, "schema_dialect", path, "schema must declare draft 2020-12")
    if not isinstance(value.get("$id"), str) or not value["$id"].startswith("https://scrollmark.local/contracts/scrollmark/v1/"):
        _error(errors, "schema_id", path, "schema id must be versioned neutral contract URI")
    return errors


def validate_evidence_card(value: Any) -> List[Dict[str, str]]:
    errors: List[Dict[str, str]] = []
    required = (
        "card_version",
        "card_id",
        "scenario",
        "status",
        "source_identity",
        "fixture",
        "expected",
        "observed",
        "oracles",
        "privacy",
        "retries",
        "artifacts",
    )
    _required(value, required, "card", errors)
    if not isinstance(value, dict):
        return errors
    if value.get("card_version") != 1:
        _error(errors, "card_version", "card.card_version", "only evidence card v1 is admitted")
    _id(value.get("card_id"), "card.card_id", errors)
    if value.get("status") not in {"passed", "failed", "blocked", "inconclusive"}:
        _error(errors, "card_status", "card.status", "invalid evidence status")
    source = value.get("source_identity")
    _required(source, ("source_revision", "config_hash", "contract_revision"), "card.source_identity", errors)
    if isinstance(source, dict):
        _hash(source.get("config_hash"), "card.source_identity.config_hash", errors)
        if source.get("contract_revision") != 1:
            _error(errors, "contract_revision", "card.source_identity.contract_revision", "contract revision must be 1")
    fixture = value.get("fixture")
    _required(fixture, ("name", "seed", "record_counts", "fixture_hash"), "card.fixture", errors)
    if isinstance(fixture, dict):
        _hash(fixture.get("fixture_hash"), "card.fixture.fixture_hash", errors)
    oracles = value.get("oracles")
    _required(oracles, ("reference_model_hash", "artifact_hashes", "independent_checks"), "card.oracles", errors)
    if isinstance(oracles, dict):
        _hash(oracles.get("reference_model_hash"), "card.oracles.reference_model_hash", errors)
        for artifact, digest in (oracles.get("artifact_hashes") or {}).items():
            _hash(digest, f"card.oracles.artifact_hashes.{artifact}", errors)
    privacy = value.get("privacy")
    _required(privacy, ("profile", "redacted", "dm_allowed", "excluded_fields"), "card.privacy", errors)
    if isinstance(privacy, dict) and privacy.get("dm_allowed") is not False:
        _error(errors, "privacy_dm_enabled", "card.privacy.dm_allowed", "DM must remain disabled")
    return errors


def validate_reconciliation_request(value: Any) -> List[Dict[str, str]]:
    errors: List[Dict[str, str]] = []
    _required(value, ("protocol", "request_id", "archive_id", "namespace_id", "client_id", "client_epoch", "sent_at_ms", "mode", "after_checkpoint", "known_checkpoint", "page_hint"), "reconciliation", errors)
    if not isinstance(value, dict):
        return errors
    _protocol(value.get("protocol"), "reconciliation.protocol", errors)
    for field in ("request_id", "archive_id", "namespace_id", "client_id", "client_epoch"):
        _id(value.get(field), f"reconciliation.{field}", errors)
    if value.get("mode") not in {"deltas", "state_bootstrap"}:
        _error(errors, "invalid_reconciliation_mode", "reconciliation.mode", "mode is not admitted")
    if not isinstance(value.get("page_hint"), int) or not 1 <= value["page_hint"] <= 4096:
        _error(errors, "invalid_page_hint", "reconciliation.page_hint", "page hint exceeds bounded protocol limit")
    for field in ("after_checkpoint", "known_checkpoint"):
        if value.get(field) is not None:
            validate_checkpoint(value[field], value.get("namespace_id"), errors, f"reconciliation.{field}")
    return errors
