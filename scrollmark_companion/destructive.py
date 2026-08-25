"""Independent, fail-closed durable archive destruction guard."""
from __future__ import annotations

import hashlib
import json
import secrets
import threading
import time
from dataclasses import dataclass
from typing import Any, Dict, Mapping, Optional

from .errors import CompanionError
from .snapshots import SnapshotManager
from .store import CanonicalArchiveStore

CHALLENGE_TTL_MS = 5 * 60 * 1000
RECENT_SNAPSHOT_MS = 30 * 24 * 60 * 60 * 1000


@dataclass(frozen=True)
class DestroyChallenge:
    challenge_id: str
    archive_id: str
    namespace_ids: tuple[str, ...]
    namespace_disclosures: tuple[tuple[str, str], ...]
    phrase: str
    pending_count: int
    snapshot_digest: str
    expires_at_ms: int


class DurableDestroyGuard:
    def __init__(
        self,
        store: CanonicalArchiveStore,
        snapshots: SnapshotManager,
        *,
        clock=lambda: int(time.time() * 1000),
    ) -> None:
        self.store = store
        self.snapshots = snapshots
        self.clock = clock
        self._lock = threading.RLock()
        self._challenges: Dict[str, DestroyChallenge] = {}

    def _fail(self, message: str, *, observed: Optional[Dict[str, Any]] = None) -> CompanionError:
        return CompanionError("destroy_guard_failed", message, retryable=False, observed=observed)

    def _snapshot_state(self) -> tuple[list[Dict[str, Any]], str]:
        snapshots = self.snapshots.list_verified()
        digest = hashlib.sha256(
            json.dumps(
                [(item["snapshot_id"], item["manifest_payload_hash"]) for item in snapshots],
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()
        return snapshots, digest

    def preflight(self, request: Mapping[str, Any]) -> Dict[str, Any]:
        allowed = {
            "archive_id",
            "namespace_ids",
            "migration_active",
            "pending_count",
            "pending_acknowledged",
            "explicit_loss_acknowledgement",
        }
        if set(request) - allowed:
            raise self._fail("durable destroy preflight contains unknown fields")
        if request.get("archive_id") != self.store.archive_id:
            raise self._fail("durable destroy archive binding is invalid")
        namespace_ids = request.get("namespace_ids")
        if not isinstance(namespace_ids, list) or not namespace_ids or not all(
            isinstance(value, str) and value for value in namespace_ids
        ):
            raise self._fail("durable destroy namespace disclosure is invalid")
        health = self.store.health()
        active = tuple(sorted(health["active_namespace_ids"]))
        if tuple(sorted(namespace_ids)) != active:
            raise self._fail("durable destroy namespace disclosure differs from active archive")
        namespace_disclosures = tuple(
            sorted(
                (
                    str(namespace["namespace_id"]),
                    str(namespace["identity_fingerprint"]),
                )
                for namespace in health["archive"]["namespaces"]
                if namespace["namespace_id"] in active
            )
        )
        if tuple(value[0] for value in namespace_disclosures) != active:
            raise self._fail("durable destroy identity disclosure is incomplete")
        if request.get("migration_active") is not False:
            raise self._fail("durable destroy is blocked while migration state is unknown or active")
        pending_count = request.get("pending_count")
        if not isinstance(pending_count, int) or pending_count < 0:
            raise self._fail("durable destroy pending count disclosure is invalid")
        if pending_count and request.get("pending_acknowledged") is not True:
            raise self._fail("durable destroy requires explicit pending-data acknowledgement")
        snapshots, snapshot_digest = self._snapshot_state()
        recent = any(self.clock() - int(item["verified_at_ms"]) <= RECENT_SNAPSHOT_MS for item in snapshots)
        if not recent and request.get("explicit_loss_acknowledgement") is not True:
            raise self._fail("durable destroy requires a recent verified snapshot or explicit loss acknowledgement")
        challenge_id = "destroy-challenge-" + secrets.token_hex(16)
        phrase = "DESTROY " + self.store.archive_id
        challenge = DestroyChallenge(
            challenge_id=challenge_id,
            archive_id=self.store.archive_id,
            namespace_ids=active,
            namespace_disclosures=namespace_disclosures,
            phrase=phrase,
            pending_count=pending_count,
            snapshot_digest=snapshot_digest,
            expires_at_ms=self.clock() + CHALLENGE_TTL_MS,
        )
        with self._lock:
            self._challenges = {
                key: value for key, value in self._challenges.items() if value.expires_at_ms > self.clock()
            }
            self._challenges[challenge_id] = challenge
        return {
            "challenge_id": challenge_id,
            "archive_id": self.store.archive_id,
            "namespace_ids": list(active),
            "namespace_disclosures": [
                {"namespace_id": namespace_id, "identity_fingerprint": identity_fingerprint}
                for namespace_id, identity_fingerprint in namespace_disclosures
            ],
            "required_phrase": phrase,
            "pending_count": pending_count,
            "recent_verified_snapshot": recent,
            "expires_at_ms": challenge.expires_at_ms,
            "second_confirmation_required": True,
        }

    def confirm(self, request: Mapping[str, Any]) -> Dict[str, Any]:
        allowed = {"challenge_id", "archive_id", "phrase", "second_confirmation"}
        if set(request) - allowed:
            raise self._fail("durable destroy confirmation contains unknown fields")
        challenge_id = request.get("challenge_id")
        if not isinstance(challenge_id, str):
            raise self._fail("durable destroy challenge is missing")
        with self._lock:
            challenge = self._challenges.pop(challenge_id, None)
        if challenge is None or challenge.expires_at_ms <= self.clock():
            raise self._fail("durable destroy challenge is missing or expired")
        if request.get("archive_id") != challenge.archive_id or challenge.archive_id != self.store.archive_id:
            raise self._fail("durable destroy archive binding changed")
        if request.get("phrase") != challenge.phrase:
            raise self._fail("durable destroy phrase does not match the archive identity")
        if request.get("second_confirmation") is not True:
            raise self._fail("durable destroy second confirmation is required")
        health = self.store.health()
        active = tuple(sorted(health["active_namespace_ids"]))
        disclosures = tuple(
            sorted(
                (
                    str(namespace["namespace_id"]),
                    str(namespace["identity_fingerprint"]),
                )
                for namespace in health["archive"]["namespaces"]
                if namespace["namespace_id"] in active
            )
        )
        if active != challenge.namespace_ids or disclosures != challenge.namespace_disclosures:
            raise self._fail("durable destroy namespace or identity state changed after preflight")
        _, snapshot_digest = self._snapshot_state()
        if snapshot_digest != challenge.snapshot_digest:
            raise self._fail("durable destroy snapshot state changed after preflight")
        self.store._hit_failpoint("durable_destroy_before_transaction")
        audit_id = "audit-destroy-" + secrets.token_hex(16)
        with self.store._lock:
            self.store._begin()
            committed = False
            try:
                self.store._connection.execute("DELETE FROM stream_pages")
                self.store._connection.execute("DELETE FROM streams")
                self.store._connection.execute("DELETE FROM state_records")
                self.store._connection.execute("DELETE FROM journal")
                self.store._connection.execute("DELETE FROM batches")
                self.store._connection.execute("DELETE FROM checkpoints")
                self.store._connection.execute("DELETE FROM clients")
                self.store._connection.execute("DELETE FROM archive_state")
                self.store._connection.execute("DELETE FROM namespaces")
                self.store._connection.execute(
                    """
                    INSERT INTO operation_audit(
                        audit_id, operation, archive_id, snapshot_id, state, details_json, created_at_ms
                    ) VALUES(?, 'durable_destroy', ?, NULL, 'destroyed', ?, ?)
                    """,
                    (
                        audit_id,
                        self.store.archive_id,
                        json.dumps(
                            {
                                "namespace_ids": list(challenge.namespace_ids),
                                "pending_count": challenge.pending_count,
                                "snapshot_digest": challenge.snapshot_digest,
                            },
                            sort_keys=True,
                            separators=(",", ":"),
                        ),
                        self.clock(),
                    ),
                )
                self.store._hit_failpoint("durable_destroy_before_commit")
                self.store._connection.execute("COMMIT")
                committed = True
            except Exception:
                if not committed:
                    self.store._rollback_if_open()
                raise
        self.store._hit_failpoint("durable_destroy_after_commit")
        return {
            "archive_id": self.store.archive_id,
            "state": "destroyed",
            "audit_id": audit_id,
            "destroyed_namespace_ids": list(challenge.namespace_ids),
            "snapshots_preserved": True,
        }


__all__ = ["DurableDestroyGuard"]
