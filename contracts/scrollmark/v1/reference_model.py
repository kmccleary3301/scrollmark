"""Small deterministic model for T2 contract/oracle checks.

It models canonical namespace state, atomic batches, proof receipts, replay and
conflict behavior, bounded pending outbox admission, and staged projections.
It intentionally has no dependency on Scrollmark production storage code.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

from canonical import (
    ZERO_HASH,
    batch_hash,
    canonical_bytes,
    chain_hash,
    record_hash,
    sha256_hex,
)


class ReferenceModelError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _target_key(namespace_id: str, target: Dict[str, Any]) -> Tuple[Any, ...]:
    if target.get("namespace_id") != namespace_id:
        raise ReferenceModelError("namespace_mismatch", "target namespace differs from request context")
    return (target["kind"], target["id"])


def _relationship_key(namespace_id: str, mutation: Dict[str, Any]) -> Tuple[Any, ...]:
    subject = mutation["subject"]
    obj = mutation["object"]
    if subject.get("namespace_id") != namespace_id or obj.get("namespace_id") != namespace_id:
        raise ReferenceModelError("relationship_namespace_context_required", "relationship endpoint namespace mismatch")
    qualifier = sha256_hex(mutation.get("qualifier")) if mutation.get("qualifier") is not None else None
    return (
        mutation["relationship_kind"],
        subject["kind"],
        subject["id"],
        obj["kind"],
        obj["id"],
        qualifier,
    )


def _mutation_key(namespace_id: str, mutation: Dict[str, Any]) -> Tuple[Any, ...]:
    kind = mutation["kind"]
    if kind == "entity_upsert":
        return ("entity",) + _target_key(namespace_id, mutation["target"])
    if kind == "relationship_upsert":
        return ("relationship",) + _relationship_key(namespace_id, mutation)
    if kind == "enrichment_upsert":
        return ("enrichment", mutation["enrichment_kind"]) + _target_key(namespace_id, mutation["target"])
    if kind == "tombstone":
        return ("tombstone", mutation["target_kind"], mutation["target_id"])
    raise ReferenceModelError("validation_failed", "unknown mutation kind")


@dataclass
class OutboxRow:
    batch_id: str
    batch: Dict[str, Any]
    bytes: int
    created_at_ms: int
    disposition: str = "pending"
    disposition_reason: Optional[str] = None


class BoundedOutbox:
    def __init__(
        self,
        max_mutations: int = 50_000,
        max_bytes: int = 512 * 1024 * 1024,
        max_age_ms: int = 24 * 60 * 60 * 1000,
    ) -> None:
        self.max_mutations = max_mutations
        self.max_bytes = max_bytes
        self.max_age_ms = max_age_ms
        self.rows: List[OutboxRow] = []
        self.stopped = False
        self.stop_reason: Optional[str] = None

    def _totals(self) -> Tuple[int, int]:
        return (
            sum(len(row.batch.get("mutations", [])) for row in self.rows if row.disposition == "pending"),
            sum(row.bytes for row in self.rows if row.disposition == "pending"),
        )

    def add(self, batch: Dict[str, Any], now_ms: int) -> OutboxRow:
        if self.stopped:
            raise ReferenceModelError("outbox_stopped", self.stop_reason or "outbox admission stopped")
        row = OutboxRow(
            batch_id=batch["batch_id"],
            batch=copy.deepcopy(batch),
            bytes=len(canonical_bytes(batch)),
            created_at_ms=now_ms,
        )
        mutations, bytes_used = self._totals()
        if mutations + len(row.batch.get("mutations", [])) > self.max_mutations:
            self.stopped = True
            self.stop_reason = "mutation_bound"
            raise ReferenceModelError("outbox_bound_exceeded", self.stop_reason)
        if bytes_used + row.bytes > self.max_bytes:
            self.stopped = True
            self.stop_reason = "byte_bound"
            raise ReferenceModelError("outbox_bound_exceeded", self.stop_reason)
        self.rows.append(row)
        return row

    def enforce_age(self, now_ms: int) -> None:
        for row in self.rows:
            if row.disposition == "pending" and now_ms - row.created_at_ms > self.max_age_ms:
                self.stopped = True
                self.stop_reason = "age_bound"
                return

    def acknowledge(self, batch_id: str) -> None:
        for row in self.rows:
            if row.batch_id == batch_id and row.disposition == "pending":
                row.disposition = "acknowledged"
                return
        raise ReferenceModelError("outbox_batch_unknown", batch_id)

    def quarantine(self, batch_id: str, reason: str) -> None:
        for row in self.rows:
            if row.batch_id == batch_id and row.disposition == "pending":
                row.disposition = "quarantined"
                row.disposition_reason = reason
                return
        raise ReferenceModelError("outbox_batch_unknown", batch_id)

    def status(self, now_ms: int) -> Dict[str, Any]:
        self.enforce_age(now_ms)
        mutations, bytes_used = self._totals()
        oldest = min(
            (row.created_at_ms for row in self.rows if row.disposition == "pending"),
            default=None,
        )
        return {
            "pending_batches": sum(row.disposition == "pending" for row in self.rows),
            "pending_mutations": mutations,
            "pending_bytes": bytes_used,
            "oldest_age_ms": None if oldest is None else now_ms - oldest,
            "stopped": self.stopped,
            "stop_reason": self.stop_reason,
        }


class ProjectionGeneration:
    def __init__(self, generation_id: str, namespace_id: str) -> None:
        self.generation_id = generation_id
        self.namespace_id = namespace_id
        self.pages: List[Dict[str, Any]] = []
        self.final_page_seen = False
        self.active = False
        self.state_hash: Optional[str] = None

    def stage_page(self, page_index: int, items: List[Dict[str, Any]], final: bool) -> None:
        if self.active:
            raise ReferenceModelError("generation_active", "cannot mutate active generation")
        if page_index != len(self.pages):
            raise ReferenceModelError("page_sequence_gap", "generation pages must be contiguous")
        self.pages.append(copy.deepcopy({"page_index": page_index, "items": items}))
        self.final_page_seen = self.final_page_seen or final

    def activate(self, target_checkpoint: Dict[str, Any], expected_state_hash: str) -> str:
        if not self.final_page_seen:
            raise ReferenceModelError("generation_incomplete", "final page proof is missing")
        if target_checkpoint["namespace_id"] != self.namespace_id:
            raise ReferenceModelError("namespace_mismatch", "generation checkpoint namespace mismatch")
        state = {"namespace_id": self.namespace_id, "pages": self.pages, "checkpoint": target_checkpoint}
        actual = sha256_hex(state)
        if actual != expected_state_hash:
            raise ReferenceModelError("generation_hash_mismatch", "staged state hash differs")
        self.state_hash = actual
        self.active = True
        return actual


class ReferenceArchive:
    def __init__(self, archive_id: str, namespace_id: str, capability_revision: str = "cap-1") -> None:
        self.archive_id = archive_id
        self.namespace_id = namespace_id
        self.capability_revision = capability_revision
        self.client_next_sequence = 1
        self.archive_next_sequence = 1
        self.chain_head = ZERO_HASH
        self.records: Dict[Tuple[Any, ...], Dict[str, Any]] = {}
        self.relationships: Dict[Tuple[Any, ...], Dict[str, Any]] = {}
        self.enrichments: Dict[Tuple[Any, ...], Dict[str, Any]] = {}
        self.tombstones: Dict[Tuple[Any, ...], Dict[str, Any]] = {}
        self.journal: List[Dict[str, Any]] = []
        self.receipts: Dict[str, Dict[str, Any]] = {}
        self.mutation_hashes: Dict[str, str] = {}

    def checkpoint(self) -> Dict[str, Any]:
        return {
            "namespace_id": self.namespace_id,
            "archive_seq": self.archive_next_sequence - 1,
            "chain_hash": self.chain_head,
            "schema_revision": 1,
        }

    def state_digest(self) -> str:
        return sha256_hex(
            {
                "archive_id": self.archive_id,
                "namespace_id": self.namespace_id,
                "records": [[list(key), value] for key, value in sorted(self.records.items(), key=lambda item: repr(item[0]))],
                "relationships": [[list(key), value] for key, value in sorted(self.relationships.items(), key=lambda item: repr(item[0]))],
                "enrichments": [[list(key), value] for key, value in sorted(self.enrichments.items(), key=lambda item: repr(item[0]))],
                "tombstones": [[list(key), value] for key, value in sorted(self.tombstones.items(), key=lambda item: repr(item[0]))],
                "checkpoint": self.checkpoint(),
            }
        )

    def _validate_request(self, request: Dict[str, Any]) -> None:
        for field in ("archive_id", "namespace_id", "client_id", "client_epoch", "client_sequence", "batch"):
            if field not in request:
                raise ReferenceModelError("validation_failed", f"missing request field: {field}")
        if request["archive_id"] != self.archive_id:
            raise ReferenceModelError("archive_binding_mismatch", "archive binding differs")
        if request["namespace_id"] != self.namespace_id:
            raise ReferenceModelError("namespace_not_active", "namespace differs")
        mutations = request["batch"].get("mutations", [])
        if request["batch"].get("mutation_count") != len(mutations) or not mutations:
            raise ReferenceModelError("validation_failed", "mutation_count does not match non-empty batch")
        client_range = request["client_sequence"]
        sequence_values = [mutation.get("client_seq") for mutation in mutations]
        if sequence_values != list(range(client_range["from"], client_range["to"] + 1)):
            raise ReferenceModelError("client_sequence_not_contiguous", "mutation client sequence is not contiguous")
        if client_range["from"] != self.client_next_sequence:
            raise ReferenceModelError("client_sequence_gap", "batch does not begin at expected client sequence")
        for mutation in mutations:
            if mutation.get("record_hash") != record_hash(self.namespace_id, mutation):
                raise ReferenceModelError("batch_hash_mismatch", "record hash does not match canonical content")
            for endpoint_name in ("target", "subject", "object"):
                endpoint = mutation.get(endpoint_name)
                if endpoint is not None and endpoint.get("namespace_id") != self.namespace_id:
                    raise ReferenceModelError("relationship_namespace_context_required", "endpoint namespace mismatch")
            previous = self.mutation_hashes.get(mutation["mutation_id"])
            if previous is not None and previous != mutation["record_hash"]:
                raise ReferenceModelError("mutation_hash_conflict", "mutation identity reused with different content")
        if request["batch"].get("batch_hash") != batch_hash(self.namespace_id, request["batch"]):
            raise ReferenceModelError("batch_hash_mismatch", "batch hash does not match canonical content")

    def _apply_mutation_to_copy(
        self,
        mutation: Dict[str, Any],
        records: Dict[Tuple[Any, ...], Dict[str, Any]],
        relationships: Dict[Tuple[Any, ...], Dict[str, Any]],
        enrichments: Dict[Tuple[Any, ...], Dict[str, Any]],
        tombstones: Dict[Tuple[Any, ...], Dict[str, Any]],
    ) -> None:
        key = _mutation_key(self.namespace_id, mutation)
        if mutation["kind"] == "tombstone":
            tomb_key = (mutation["target_kind"], mutation["target_id"])
            tombstones[tomb_key] = copy.deepcopy(mutation)
            return
        if mutation["kind"] in {"entity_upsert", "enrichment_upsert"}:
            target = mutation["target"]
            target_key = (target["kind"], target["id"])
            if target_key in tombstones:
                raise ReferenceModelError("tombstone_resurrection", "upsert would resurrect a tombstoned target")
            destination = records if mutation["kind"] == "entity_upsert" else enrichments
            destination[key[1:]] = copy.deepcopy(mutation)
            return
        if mutation["kind"] == "relationship_upsert":
            if ("relationship",) + _relationship_key(self.namespace_id, mutation) in tombstones:
                raise ReferenceModelError("tombstone_resurrection", "relationship is tombstoned")
            relationships[key[1:]] = copy.deepcopy(mutation)
            return
        raise ReferenceModelError("validation_failed", "unsupported mutation kind")

    def apply_batch(self, request: Dict[str, Any]) -> Dict[str, Any]:
        batch = request["batch"]
        existing = self.receipts.get(batch.get("batch_id"))
        if existing is not None:
            if existing["batch_hash"] != batch.get("batch_hash"):
                raise ReferenceModelError("mutation_hash_conflict", "batch identity reused with different hash")
            duplicate = copy.deepcopy(existing)
            duplicate["request_id"] = request.get("request_id", duplicate["request_id"])
            duplicate["result"] = "duplicate"
            return duplicate
        self._validate_request(request)
        records = copy.deepcopy(self.records)
        relationships = copy.deepcopy(self.relationships)
        enrichments = copy.deepcopy(self.enrichments)
        tombstones = copy.deepcopy(self.tombstones)
        for mutation in batch["mutations"]:
            self._apply_mutation_to_copy(mutation, records, relationships, enrichments, tombstones)
        archive_from = self.archive_next_sequence
        archive_to = archive_from + len(batch["mutations"]) - 1
        prior_chain = self.chain_head
        next_chain = chain_hash(
            self.namespace_id,
            prior_chain,
            batch["batch_hash"],
            archive_from,
            archive_to,
        )
        for offset, mutation in enumerate(batch["mutations"]):
            self.journal.append(
                {
                    "archive_seq": archive_from + offset,
                    "mutation_id": mutation["mutation_id"],
                    "mutation": copy.deepcopy(mutation),
                }
            )
            self.mutation_hashes[mutation["mutation_id"]] = mutation["record_hash"]
        self.records = records
        self.relationships = relationships
        self.enrichments = enrichments
        self.tombstones = tombstones
        self.client_next_sequence = request["client_sequence"]["to"] + 1
        self.archive_next_sequence = archive_to + 1
        self.chain_head = next_chain
        receipt = {
            "protocol": {"major": 1, "minor": 0},
            "request_id": request.get("request_id", "request-unknown"),
            "archive_id": self.archive_id,
            "namespace_id": self.namespace_id,
            "client_id": request["client_id"],
            "client_epoch": request["client_epoch"],
            "batch_id": batch["batch_id"],
            "result": "committed",
            "client_sequence": copy.deepcopy(request["client_sequence"]),
            "archive_sequence": {"from": archive_from, "to": archive_to},
            "mutation_count": len(batch["mutations"]),
            "batch_hash": batch["batch_hash"],
            "prior_chain_hash": prior_chain,
            "chain_hash": next_chain,
            "checkpoint": self.checkpoint(),
            "capability_revision": self.capability_revision,
        }
        self.receipts[batch["batch_id"]] = copy.deepcopy(receipt)
        return receipt

    def reconcile(self, after_checkpoint: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        start = 0 if after_checkpoint is None else after_checkpoint["archive_seq"]
        if after_checkpoint is not None and after_checkpoint["chain_hash"] != (
            ZERO_HASH if start == 0 else self._chain_at(start)
        ):
            raise ReferenceModelError("checkpoint_mismatch", "checkpoint chain differs")
        return {
            "namespace_id": self.namespace_id,
            "after_archive_seq": start,
            "target_checkpoint": self.checkpoint(),
            "items": copy.deepcopy([entry for entry in self.journal if entry["archive_seq"] > start]),
        }

    def _chain_at(self, archive_seq: int) -> str:
        for receipt in self.receipts.values():
            if receipt["archive_sequence"]["to"] == archive_seq:
                return receipt["chain_hash"]
        return ZERO_HASH
