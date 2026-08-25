"""Dependency-free RFC 8785-style canonical JSON and Scrollmark hash helpers.

This module is intentionally independent from the browser and companion storage
implementations. It is the Python side of the neutral-contract oracle.
"""

from __future__ import annotations

import hashlib
import json
import math
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterable, Union

HASH_ALGORITHM = "sha256-jcs-hex"
ZERO_HASH = "0" * 64


def _utf16_sort_key(value: str) -> bytes:
    return value.encode("utf-16-be", "surrogatepass")


def _scientific_number(value: Decimal) -> str:
    sign = "-" if value < 0 else ""
    digits = "".join(str(digit) for digit in value.copy_abs().as_tuple().digits).lstrip("0")
    if not digits:
        return "0"
    exponent = value.copy_abs().as_tuple().exponent + len(value.copy_abs().as_tuple().digits) - 1
    coefficient = digits[0]
    tail = digits[1:].rstrip("0")
    if tail:
        coefficient += "." + tail
    exponent_text = f"+{exponent}" if exponent >= 0 else str(exponent)
    return f"{sign}{coefficient}e{exponent_text}"


def _number_text(value: Union[int, float]) -> str:
    if isinstance(value, bool):
        raise TypeError("boolean is not a number")
    if isinstance(value, int):
        return str(value)
    if not math.isfinite(value):
        raise ValueError("JCS does not encode NaN or Infinity")
    if value == 0:
        return "0"
    decimal = Decimal(repr(value))
    magnitude = abs(value)
    if 1e-6 <= magnitude < 1e21:
        rendered = format(decimal, "f")
        if "." in rendered:
            rendered = rendered.rstrip("0").rstrip(".")
        return "0" if rendered in {"-0", ""} else rendered
    return _scientific_number(decimal)


def _encode(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return _number_text(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    if isinstance(value, list):
        return "[" + ",".join(_encode(item) for item in value) + "]"
    if isinstance(value, dict):
        if any(not isinstance(key, str) for key in value):
            raise TypeError("JCS object keys must be strings")
        pairs = []
        for key in sorted(value, key=_utf16_sort_key):
            pairs.append(_encode(key) + ":" + _encode(value[key]))
        return "{" + ",".join(pairs) + "}"
    raise TypeError(f"unsupported JSON value: {type(value).__name__}")


def canonicalize(value: Any) -> str:
    """Return canonical JSON text with UTF-16 key ordering and no whitespace."""

    return _encode(value)


def canonical_bytes(value: Any) -> bytes:
    return canonicalize(value).encode("utf-8")


def sha256_hex(value: Any) -> str:
    payload = value if isinstance(value, bytes) else canonical_bytes(value)
    return hashlib.sha256(payload).hexdigest()


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def record_material(namespace_id: str, mutation: dict[str, Any]) -> dict[str, Any]:
    """Select semantic mutation fields; exclude transport/idempotency decoration."""

    material: dict[str, Any] = {
        "namespace_id": namespace_id,
        "kind": mutation["kind"],
        "schema_revision": mutation["schema_revision"],
        "provenance": mutation["provenance"],
        "observed_at_ms": mutation["observed_at_ms"],
    }
    if mutation["kind"] == "entity_upsert":
        material.update({"target": mutation["target"], "payload": mutation["payload"]})
    elif mutation["kind"] == "relationship_upsert":
        material.update(
            {
                "relationship_kind": mutation["relationship_kind"],
                "subject": mutation["subject"],
                "object": mutation["object"],
                "qualifier": mutation["qualifier"],
                "payload": mutation["payload"],
            }
        )
    elif mutation["kind"] == "enrichment_upsert":
        material.update(
            {
                "target": mutation["target"],
                "enrichment_kind": mutation["enrichment_kind"],
                "payload": mutation["payload"],
            }
        )
    elif mutation["kind"] == "tombstone":
        material.update(
            {
                "target_kind": mutation["target_kind"],
                "target_id": mutation["target_id"],
                "relationship_kind": mutation.get("relationship_kind"),
                "deletion_id": mutation["deletion_id"],
            }
        )
    else:
        raise ValueError(f"unknown mutation kind: {mutation.get('kind')!r}")
    return material


def record_hash(namespace_id: str, mutation: dict[str, Any]) -> str:
    return sha256_hex(record_material(namespace_id, mutation))


def batch_material(namespace_id: str, batch: dict[str, Any]) -> dict[str, Any]:
    mutations = [
        {
            "client_seq": mutation["client_seq"],
            "mutation_id": mutation["mutation_id"],
            "kind": mutation["kind"],
            "record_hash": mutation["record_hash"],
        }
        for mutation in batch["mutations"]
    ]
    schema_revisions = sorted({mutation["schema_revision"] for mutation in batch["mutations"]})
    return {
        "namespace_id": namespace_id,
        "schema_revisions": schema_revisions,
        "mutations": mutations,
    }


def batch_hash(namespace_id: str, batch: dict[str, Any]) -> str:
    return sha256_hex(batch_material(namespace_id, batch))


def chain_material(
    namespace_id: str,
    prior_chain_hash: str,
    committed_batch_hash: str,
    archive_from: int,
    archive_to: int,
    schema_revision: int = 1,
) -> dict[str, Any]:
    return {
        "namespace_id": namespace_id,
        "schema_revision": schema_revision,
        "prior_chain_hash": prior_chain_hash,
        "batch_hash": committed_batch_hash,
        "archive_sequence": {"from": archive_from, "to": archive_to},
    }


def chain_hash(
    namespace_id: str,
    prior_chain_hash: str,
    committed_batch_hash: str,
    archive_from: int,
    archive_to: int,
    schema_revision: int = 1,
) -> str:
    return sha256_hex(
        chain_material(
            namespace_id,
            prior_chain_hash,
            committed_batch_hash,
            archive_from,
            archive_to,
            schema_revision,
        )
    )


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def dump_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def iter_hashes(values: Iterable[Any]) -> list[str]:
    return [sha256_hex(value) for value in values]
