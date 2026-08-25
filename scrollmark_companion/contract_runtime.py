"""Load the repository's dependency-free Scrollmark v1 contract oracle.

The companion is a project-root sibling of ``contracts/`` rather than an
installed distribution.  This small bridge keeps that layout detail out of
store and protocol code while reusing the locked canonicalization and semantic
validators.
"""
from __future__ import annotations

import sys
from pathlib import Path

_CONTRACT_ROOT = Path(__file__).resolve().parents[1] / "contracts" / "scrollmark" / "v1"
if str(_CONTRACT_ROOT) not in sys.path:
    sys.path.insert(0, str(_CONTRACT_ROOT))

from canonical import (  # type: ignore  # noqa: E402
    HASH_ALGORITHM,
    ZERO_HASH,
    batch_hash,
    canonical_bytes,
    canonicalize,
    chain_hash,
    record_hash,
    sha256_hex,
)
from validator import (  # type: ignore  # noqa: E402
    ID_RE,
    validate_checkpoint,
    validate_error,
    validate_evidence_card,
    validate_reconciliation_request,
    validate_receipt,
    validate_request,
)

__all__ = [
    "HASH_ALGORITHM",
    "ZERO_HASH",
    "ID_RE",
    "batch_hash",
    "canonical_bytes",
    "canonicalize",
    "chain_hash",
    "record_hash",
    "sha256_hex",
    "validate_checkpoint",
    "validate_error",
    "validate_evidence_card",
    "validate_reconciliation_request",
    "validate_receipt",
    "validate_request",
]
