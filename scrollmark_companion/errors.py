"""Stable companion failures shared by the store and HTTP adapter."""
from __future__ import annotations

from typing import Any, Dict, Optional


class CompanionError(Exception):
    """A safe, protocol-shaped failure with no storage details."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        retryable: bool = False,
        expected: Optional[Dict[str, Any]] = None,
        observed: Optional[Dict[str, Any]] = None,
        retry_after_ms: Optional[int] = None,
        request_id: Optional[str] = None,
        archive_id: Optional[str] = None,
        namespace_id: Optional[str] = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message[:512]
        self.retryable = retryable
        self.expected = expected
        self.observed = observed
        self.retry_after_ms = retry_after_ms
        self.request_id = request_id
        self.archive_id = archive_id
        self.namespace_id = namespace_id


class FailpointError(RuntimeError):
    """Internal deterministic fault injection used only by focused proofs."""


class CommitUnknownError(CompanionError):
    """The transaction committed but the response path was interrupted."""

    def __init__(self, *, request_id: Optional[str], archive_id: str, namespace_id: str) -> None:
        super().__init__(
            "internal_commit_unknown",
            "the commit result is temporarily unknown; retry the exact batch",
            retryable=True,
            request_id=request_id,
            archive_id=archive_id,
            namespace_id=namespace_id,
        )
