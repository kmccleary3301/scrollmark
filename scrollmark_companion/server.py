"""Authenticated HTTP adapter for the canonical companion interface."""
from __future__ import annotations

import argparse
import json
import os
import secrets
import signal
import stat
import threading
from dataclasses import dataclass, field
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence, Set, Tuple
from urllib.parse import parse_qs, unquote, urlsplit

from .contract_runtime import ID_RE
from .destructive import DurableDestroyGuard
from .errors import CompanionError
from .snapshot_crypto import MacOSKeychainSnapshotKeyStore, SnapshotKeyStore
from .snapshots import SnapshotManager
from .store import PROTOCOL, CanonicalArchiveStore

DEFAULT_ORIGINS = frozenset({"https://x.com", "https://twitter.com", "https://mobile.x.com"})
PROTOCOL_HEADER = "X-Scrollmark-Protocol"
PROTOCOL_HEADER_VALUE = "v1"
ALLOWED_CORS_HEADERS = frozenset({"authorization", "content-type", "x-scrollmark-protocol"})


@dataclass(frozen=True)
class CompanionConfig:
    token: str
    host: str = "127.0.0.1"
    port: int = 0
    allowed_origins: Set[str] = field(default_factory=lambda: set(DEFAULT_ORIGINS))
    max_body_bytes: int = 8 * 1024 * 1024
    snapshot_root: Optional[str] = None

    def __post_init__(self) -> None:
        if not self.token:
            raise ValueError("a per-install bearer token is required")
        if self.host != "127.0.0.1":
            raise ValueError("the canonical companion must bind to loopback")
        if self.port < 0 or self.port > 65535:
            raise ValueError("invalid TCP port")
        if not self.allowed_origins:
            raise ValueError("at least one exact origin is required")
        invalid = [origin for origin in self.allowed_origins if origin not in DEFAULT_ORIGINS]
        if invalid:
            raise ValueError("only the locked X origins are permitted")


class _HTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, address: Tuple[str, int], handler: Any, companion: "CompanionServer") -> None:
        super().__init__(address, handler)
        self.companion = companion


class _Handler(BaseHTTPRequestHandler):
    server: _HTTPServer
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:
        # Request paths and headers can contain account-sensitive identifiers;
        # the companion deliberately emits no access log by default.
        return

    @property
    def companion(self) -> "CompanionServer":
        return self.server.companion

    @property
    def config(self) -> CompanionConfig:
        return self.companion.config

    @property
    def store(self) -> CanonicalArchiveStore:
        return self.companion.store
    @property
    def snapshots(self) -> SnapshotManager:
        return self.companion.snapshots

    @property
    def destroy_guard(self) -> DurableDestroyGuard:
        return self.companion.destroy_guard

    def _new_request_id(self) -> str:
        candidate = self.headers.get("X-Request-ID")
        if candidate and ID_RE.fullmatch(candidate):
            return candidate
        return "req-" + secrets.token_hex(12)

    def _origin(self) -> Optional[str]:
        value = self.headers.get("Origin")
        return value if value in self.config.allowed_origins else None

    def _write_json(
        self,
        status: int,
        payload: Mapping[str, Any],
        *,
        origin: Optional[str],
    ) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header(PROTOCOL_HEADER, PROTOCOL_HEADER_VALUE)
        self.send_header("Cache-Control", "no-store")
        if origin is not None:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.end_headers()
        self.wfile.write(body)

    def _error_payload(self, error: CompanionError, request_id: str) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "protocol": dict(PROTOCOL),
            "request_id": error.request_id or request_id,
            "code": error.code,
            "retryable": bool(error.retryable),
            "message": error.message[:512],
        }
        if error.archive_id is not None:
            payload["archive_id"] = error.archive_id
        if error.namespace_id is not None:
            payload["namespace_id"] = error.namespace_id
        if error.expected is not None:
            payload["expected"] = error.expected
        if error.observed is not None:
            payload["observed"] = error.observed
        if error.retry_after_ms is not None:
            payload["retry_after_ms"] = int(error.retry_after_ms)
        return payload

    def _status_for_error(self, code: str) -> int:
        if code == "auth_required":
            return HTTPStatus.UNAUTHORIZED
        if code == "origin_denied":
            return HTTPStatus.FORBIDDEN
        if code == "protocol_version_unsupported":
            return HTTPStatus.UPGRADE_REQUIRED
        if code in {"limit_exceeded"}:
            return HTTPStatus.REQUEST_ENTITY_TOO_LARGE
        if code in {"companion_busy", "companion_unavailable", "internal_commit_unknown"}:
            return HTTPStatus.SERVICE_UNAVAILABLE
        if code in {
            "client_sequence_gap",
            "batch_hash_mismatch",
            "mutation_hash_conflict",
            "checkpoint_mismatch",
            "checkpoint_expired",
            "stream_expired",
            "snapshot_corrupt",
            "snapshot_incompatible",
            "snapshot_key_unavailable",
            "restore_failed",
            "destroy_guard_failed",
        }:
            return HTTPStatus.CONFLICT
        return HTTPStatus.BAD_REQUEST

    def _send_error(
        self,
        error: CompanionError,
        *,
        request_id: Optional[str] = None,
        origin: Optional[str] = None,
    ) -> None:
        request_id = request_id or self._new_request_id()
        self._write_json(
            self._status_for_error(error.code),
            self._error_payload(error, request_id),
            origin=origin,
        )

    def _check_origin_and_auth(self, request_id: str) -> str:
        origin_header = self.headers.get("Origin")
        if origin_header not in self.config.allowed_origins:
            raise CompanionError(
                "origin_denied",
                "the request origin is not allowlisted",
                request_id=request_id,
            )
        if self.headers.get("Cookie"):
            raise CompanionError(
                "origin_denied",
                "cookies are not accepted by the canonical companion",
                request_id=request_id,
            )
        if self.headers.get(PROTOCOL_HEADER) != PROTOCOL_HEADER_VALUE:
            raise CompanionError(
                "protocol_version_unsupported",
                "the required protocol header is missing or unsupported",
                request_id=request_id,
            )
        authorization = self.headers.get("Authorization", "")
        expected = "Bearer " + self.config.token
        if not secrets.compare_digest(authorization, expected):
            raise CompanionError(
                "auth_required",
                "a valid companion bearer token is required",
                request_id=request_id,
            )
        return origin_header

    def _check_options(self, request_id: str) -> str:
        origin_header = self.headers.get("Origin")
        if origin_header not in self.config.allowed_origins:
            raise CompanionError(
                "origin_denied",
                "the request origin is not allowlisted",
                request_id=request_id,
            )
        requested_method = self.headers.get("Access-Control-Request-Method", "")
        if requested_method not in {"GET", "POST"}:
            raise CompanionError(
                "validation_failed",
                "the requested CORS method is not admitted",
                request_id=request_id,
            )
        requested_headers = {
            header.strip().lower()
            for header in self.headers.get("Access-Control-Request-Headers", "").split(",")
            if header.strip()
        }
        if not requested_headers.issubset(ALLOWED_CORS_HEADERS):
            raise CompanionError(
                "origin_denied",
                "the requested CORS headers are not admitted",
                request_id=request_id,
            )
        return origin_header

    def _read_json(self, request_id: str) -> Mapping[str, Any]:
        content_type = self.headers.get("Content-Type", "")
        if not content_type.lower().split(";", 1)[0].strip() == "application/json":
            raise CompanionError(
                "validation_failed",
                "canonical requests require application/json",
                request_id=request_id,
            )
        try:
            content_length = int(self.headers.get("Content-Length", "-1"))
        except ValueError:
            content_length = -1
        if content_length < 0:
            raise CompanionError(
                "validation_failed",
                "a bounded Content-Length is required",
                request_id=request_id,
            )
        if content_length > min(self.config.max_body_bytes, self.store.max_request_bytes):
            raise CompanionError(
                "limit_exceeded",
                "the request exceeds the companion byte limit",
                retryable=False,
                request_id=request_id,
                expected={"max_request_bytes": min(self.config.max_body_bytes, self.store.max_request_bytes)},
                observed={"content_length": content_length},
            )
        raw = self.rfile.read(content_length)
        if len(raw) != content_length:
            raise CompanionError(
                "validation_failed",
                "the request body was truncated",
                request_id=request_id,
            )
        try:
            value = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise CompanionError(
                "validation_failed",
                "the request body is not valid UTF-8 JSON",
                request_id=request_id,
            )
        if not isinstance(value, dict):
            raise CompanionError(
                "validation_failed",
                "the request body must be a JSON object",
                request_id=request_id,
            )
        return value

    def _path_parts(self) -> Tuple[List[str], Mapping[str, List[str]]]:
        parsed = urlsplit(self.path)
        parts = [unquote(part) for part in parsed.path.split("/") if part]
        query = parse_qs(parsed.query, keep_blank_values=True)
        return parts, query

    def do_OPTIONS(self) -> None:
        request_id = self._new_request_id()
        try:
            origin = self._check_options(request_id)
            self.send_response(HTTPStatus.NO_CONTENT)
            self.send_header("Content-Length", "0")
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header(
                "Access-Control-Allow-Headers",
                "Authorization, Content-Type, X-Scrollmark-Protocol",
            )
            self.send_header("Access-Control-Max-Age", "300")
            self.send_header("Vary", "Origin")
            self.end_headers()
        except CompanionError as error:
            self._send_error(error, request_id=request_id, origin=None)

    def do_GET(self) -> None:
        request_id = self._new_request_id()
        origin: Optional[str] = self.headers.get("Origin")
        if origin not in self.config.allowed_origins:
            origin = None
        try:
            origin = self._check_origin_and_auth(request_id)
            parts, query = self._path_parts()
            if parts == ["v1", "capabilities"]:
                self._write_json(HTTPStatus.OK, self.store.capabilities(), origin=origin)
                return
            if parts == ["v1", "health"]:
                self._write_json(HTTPStatus.OK, self.store.health(), origin=origin)
                return
            if parts == ["v1", "snapshots"]:
                if query:
                    raise CompanionError(
                        "validation_failed",
                        "snapshot listing does not accept query parameters",
                        request_id=request_id,
                    )
                self._write_json(
                    HTTPStatus.OK,
                    {
                        "protocol": dict(PROTOCOL),
                        "archive_id": self.store.archive_id,
                        "snapshots": self.snapshots.list_verified(),
                    },
                    origin=origin,
                )
                return
            if len(parts) == 5 and parts[:3] == ["v1", "archive", "namespaces"] and parts[4] == "checkpoint":
                namespace_id = parts[3]
                checkpoint = self.store.checkpoint(namespace_id)
                info = next(
                    item
                    for item in self.store.archive_info()["namespaces"]
                    if item["namespace_id"] == namespace_id
                )
                self._write_json(
                    HTTPStatus.OK,
                    {
                        "protocol": dict(PROTOCOL),
                        "archive_id": self.store.archive_id,
                        "namespace_id": namespace_id,
                        "checkpoint": checkpoint,
                        "retained_from": info["retained_from"],
                        "active": info["state"] == "active",
                        "capability_revision": self.store.capabilities()["capability_revision"],
                    },
                    origin=origin,
                )
                return
            if len(parts) == 5 and parts[:3] == ["v1", "archive", "reconciliation"] and parts[4] == "pages":
                stream_id = parts[3]
                unknown_query = set(query) - {"cursor"}
                if unknown_query:
                    raise CompanionError(
                        "validation_failed",
                        "unknown reconciliation query parameters are not admitted",
                        request_id=request_id,
                    )
                values = query.get("cursor", [None])
                if len(values) != 1:
                    raise CompanionError(
                        "validation_failed",
                        "a single reconciliation cursor is required",
                        request_id=request_id,
                    )
                page = self.store.reconciliation_page(stream_id, values[0])
                self._write_json(HTTPStatus.OK, page, origin=origin)
                return
            raise CompanionError("validation_failed", "the requested companion endpoint does not exist", request_id=request_id)
        except CompanionError as error:
            self._send_error(error, request_id=request_id, origin=origin)
        except Exception:
            self._send_error(
                CompanionError(
                    "companion_unavailable",
                    "the companion could not complete the request",
                    retryable=True,
                    request_id=request_id,
                ),
                request_id=request_id,
                origin=origin,
            )

    def do_POST(self) -> None:
        request_id = self._new_request_id()
        origin: Optional[str] = self.headers.get("Origin")
        if origin not in self.config.allowed_origins:
            origin = None
        try:
            origin = self._check_origin_and_auth(request_id)
            parts, query = self._path_parts()
            if query:
                raise CompanionError(
                    "validation_failed",
                    "POST endpoints do not accept query parameters",
                    request_id=request_id,
                )
            body = self._read_json(request_id)
            if isinstance(body.get("request_id"), str) and ID_RE.fullmatch(body["request_id"]):
                request_id = body["request_id"]
            if parts == ["v1", "snapshots"]:
                if set(body) - {"request_id", "encrypted"}:
                    raise CompanionError(
                        "validation_failed",
                        "snapshot creation contains unknown fields",
                        request_id=request_id,
                    )
                snapshot = self.snapshots.create(encrypted=body.get("encrypted") is True)
                self._write_json(
                    HTTPStatus.CREATED,
                    {
                        "protocol": dict(PROTOCOL),
                        "archive_id": self.store.archive_id,
                        "snapshot": snapshot,
                    },
                    origin=origin,
                )
                return
            if parts == ["v1", "snapshots", "rotation"]:
                if set(body) - {"request_id", "hourly", "daily", "monthly", "dry_run"}:
                    raise CompanionError(
                        "validation_failed",
                        "snapshot rotation contains unknown fields",
                        request_id=request_id,
                    )
                rotation = self.snapshots.rotate(
                    hourly=int(body.get("hourly", 24)),
                    daily=int(body.get("daily", 30)),
                    monthly=int(body.get("monthly", 12)),
                    dry_run=body.get("dry_run") is True,
                )
                self._write_json(
                    HTTPStatus.OK,
                    {
                        "protocol": dict(PROTOCOL),
                        "archive_id": self.store.archive_id,
                        "rotation": rotation,
                    },
                    origin=origin,
                )
                return
            if (
                len(parts) == 4
                and parts[:2] == ["v1", "snapshots"]
                and parts[3] in {"verify", "restore"}
            ):
                snapshot_id = parts[2]
                if ID_RE.fullmatch(snapshot_id) is None:
                    raise CompanionError(
                        "validation_failed",
                        "snapshot identity is invalid",
                        request_id=request_id,
                    )
                snapshot_path = self.snapshots.root / snapshot_id
                if parts[3] == "verify":
                    if set(body) - {"request_id", "namespace_ids"}:
                        raise CompanionError(
                            "validation_failed",
                            "snapshot verification contains unknown fields",
                            request_id=request_id,
                        )
                    manifest = self.snapshots.verify(
                        snapshot_path,
                        expected_archive_id=self.store.archive_id,
                        expected_namespace_ids=body.get("namespace_ids"),
                    )
                    self._write_json(
                        HTTPStatus.OK,
                        {
                            "protocol": dict(PROTOCOL),
                            "archive_id": self.store.archive_id,
                            "snapshot_id": snapshot_id,
                            "verification": manifest["verification"],
                            "manifest_payload_hash": manifest["manifest_payload_hash"],
                        },
                        origin=origin,
                    )
                    return
                if set(body) - {"request_id", "namespace_ids"}:
                    raise CompanionError(
                        "validation_failed",
                        "snapshot restore contains unknown fields",
                        request_id=request_id,
                    )
                namespace_ids = body.get("namespace_ids")
                if not isinstance(namespace_ids, list):
                    raise CompanionError(
                        "validation_failed",
                        "snapshot restore requires an explicit namespace list",
                        request_id=request_id,
                    )
                restored = self.snapshots.restore(
                    snapshot_path,
                    expected_namespace_ids=namespace_ids,
                )
                self._write_json(
                    HTTPStatus.OK,
                    {
                        "protocol": dict(PROTOCOL),
                        "archive_id": self.store.archive_id,
                        **restored,
                    },
                    origin=origin,
                )
                return
            if parts == ["v1", "archive", "destroy", "preflight"]:
                challenge = self.destroy_guard.preflight(body)
                self._write_json(
                    HTTPStatus.OK,
                    {
                        "protocol": dict(PROTOCOL),
                        "archive_id": self.store.archive_id,
                        **challenge,
                    },
                    origin=origin,
                )
                return
            if parts == ["v1", "archive", "destroy", "confirm"]:
                receipt = self.destroy_guard.confirm(body)
                self._write_json(
                    HTTPStatus.OK,
                    {
                        "protocol": dict(PROTOCOL),
                        "archive_id": self.store.archive_id,
                        **receipt,
                    },
                    origin=origin,
                )
                return
            if parts == ["v1", "archive", "deltas"]:
                receipt = self.store.commit(body)
                self._write_json(HTTPStatus.OK, receipt, origin=origin)
                return
            if len(parts) == 5 and parts[:3] == ["v1", "archive", "namespaces"] and parts[4] == "reconciliation":
                if body.get("namespace_id") != parts[3]:
                    raise CompanionError(
                        "validation_failed",
                        "the path namespace differs from the request namespace",
                        request_id=request_id,
                    )
                descriptor = self.store.reconcile(body)
                self._write_json(HTTPStatus.OK, descriptor, origin=origin)
                return
            raise CompanionError("validation_failed", "the requested companion endpoint does not exist", request_id=request_id)
        except CompanionError as error:
            self._send_error(error, request_id=request_id, origin=origin)
        except Exception:
            self._send_error(
                CompanionError(
                    "companion_unavailable",
                    "the companion could not complete the request",
                    retryable=True,
                    request_id=request_id,
                ),
                request_id=request_id,
                origin=origin,
            )

class CompanionServer:
    """Lifecycle wrapper for the authenticated companion and recovery services."""

    def __init__(
        self,
        store: CanonicalArchiveStore,
        config: CompanionConfig,
        *,
        key_store: Optional[SnapshotKeyStore] = None,
    ) -> None:
        self.store = store
        self.config = config
        snapshot_root = (
            Path(config.snapshot_root).expanduser()
            if config.snapshot_root
            else store.db_path.parent / "snapshots"
        )
        self.snapshots = SnapshotManager(
            store,
            snapshot_root,
            key_store=key_store or MacOSKeychainSnapshotKeyStore(),
        )
        self.destroy_guard = DurableDestroyGuard(store, self.snapshots)
        self._httpd = _HTTPServer((config.host, config.port), _Handler, self)
        self._thread: Optional[threading.Thread] = None


    @property
    def address(self) -> Tuple[str, int]:
        host, port = self._httpd.server_address[:2]
        return str(host), int(port)

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._httpd.serve_forever, name="scrollmark-companion", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None


def read_token_file(path: Path) -> str:
    """Read a bearer token only from a private, owner-controlled regular file."""
    metadata = path.lstat()
    if path.is_symlink() or not stat.S_ISREG(metadata.st_mode):
        raise ValueError("token file must be a regular file, not a symlink")
    if metadata.st_mode & 0o077:
        raise ValueError("token file permissions must be 0600 or stricter")
    if hasattr(os, "getuid") and metadata.st_uid != os.getuid():
        raise ValueError("token file must be owned by the current user")
    return path.read_text(encoding="utf-8").strip()


def _main() -> int:
    parser = argparse.ArgumentParser(description="Scrollmark authenticated canonical companion")
    parser.add_argument("--db", required=True, help="SQLite archive path")
    token_source = parser.add_mutually_exclusive_group(required=True)
    token_source.add_argument("--token", help="per-install bearer token")
    token_source.add_argument("--token-file", help="0600 file containing the per-install bearer token")
    parser.add_argument("--snapshot-root", help="verified snapshot directory")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8755)
    parser.add_argument("--origin", action="append", dest="origins")
    args = parser.parse_args()
    token = args.token
    if args.token_file:
        token_path = Path(args.token_file).expanduser()
        try:
            token = read_token_file(token_path)
        except (OSError, ValueError) as error:
            parser.error(str(error))
    if not token:
        parser.error("the companion bearer token is empty")
    origins = set(args.origins or DEFAULT_ORIGINS)
    store = CanonicalArchiveStore(args.db)
    server = CompanionServer(
        store,
        CompanionConfig(
            token=token,
            host=args.host,
            port=args.port,
            allowed_origins=origins,
            snapshot_root=args.snapshot_root,
        ),
    )
    server.start()
    stop_event = threading.Event()

    def stop(_signum: int, _frame: Any) -> None:
        stop_event.set()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    stop_event.wait()
    server.stop()
    store.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())


__all__ = ["CompanionConfig", "CompanionServer", "DEFAULT_ORIGINS", "read_token_file"]
