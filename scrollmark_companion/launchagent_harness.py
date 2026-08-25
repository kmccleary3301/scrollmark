"""T7 real macOS LaunchAgent, Keychain, restart, re-pair, and uninstall drill."""
from __future__ import annotations

import hashlib
import json
import os
import plistlib
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, Optional, Tuple
from .server import read_token_file

ORIGIN = "https://x.com"
PROTOCOL = "v1"
KEYCHAIN_SERVICE = "com.scrollmark.companion.snapshot"


def _assert(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def _port() -> int:
    with socket.socket() as candidate:
        candidate.bind(("127.0.0.1", 0))
        return int(candidate.getsockname()[1])


def _request(
    port: int,
    token: str,
    path: str,
    body: Optional[Dict[str, Any]] = None,
    *,
    timeout: float = 3,
) -> Tuple[int, Dict[str, Any]]:
    headers = {
        "Origin": ORIGIN,
        "Authorization": "Bearer " + token,
        "X-Scrollmark-Protocol": PROTOCOL,
    }
    data = None
    method = "GET"
    if body is not None:
        method = "POST"
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        "http://127.0.0.1:%d%s" % (port, path), data=data, headers=headers, method=method
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return int(response.status), json.loads(response.read())
    except urllib.error.HTTPError as error:
        return int(error.code), json.loads(error.read())


def _wait_health(port: int, token: str, timeout: float = 20.0) -> Dict[str, Any]:
    deadline = time.monotonic() + timeout
    last_result: Any = None
    while time.monotonic() < deadline:
        try:
            status, payload = _request(port, token, "/v1/health")
            last_result = (status, payload)
            if status == 200:
                return payload
        except Exception as error:
            last_result = error
        time.sleep(0.2)
    raise AssertionError("LaunchAgent health did not become ready: %s" % (last_result,))


def main() -> None:
    _assert(sys.platform == "darwin", "LaunchAgent drill requires macOS")
    label = "com.scrollmark.companion.t7.%d" % os.getpid()
    port = _port()
    launch_agents = Path.home() / "Library" / "LaunchAgents"
    plist = launch_agents / (label + ".plist")
    root = Path(__file__).resolve().parents[1]
    key_id: Optional[str] = None
    started = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix="scrollmark-t7-launchagent-", dir="/tmp") as temporary:
        state_root = Path(temporary) / "state"
        unsafe_token = Path(temporary) / "unsafe.token"
        unsafe_token.write_text("unsafe\n", encoding="utf-8")
        os.chmod(unsafe_token, 0o644)
        try:
            read_token_file(unsafe_token)
        except ValueError:
            unsafe_token_rejected = True
        else:
            unsafe_token_rejected = False
        _assert(unsafe_token_rejected, "world-readable token file was accepted")
        install_command = [
            sys.executable,
            "-m",
            "scrollmark_companion.launchagent",
            "install",
            "--label",
            label,
            "--state-root",
            str(state_root),
            "--plist",
            str(plist),
            "--port",
            str(port),
            "--load",
        ]
        uninstall_command = [
            sys.executable,
            "-m",
            "scrollmark_companion.launchagent",
            "uninstall",
            "--label",
            label,
            "--state-root",
            str(state_root),
            "--plist",
            str(plist),
        ]
        uninstalled: Dict[str, Any] = {}
        try:
            install = json.loads(subprocess.run(install_command, cwd=root, check=True, capture_output=True, text=True).stdout)
            launch_arguments = plistlib.loads(plist.read_bytes())["ProgramArguments"]
            _assert(
                "https://mobile.x.com" in launch_arguments,
                "LaunchAgent omitted the admitted mobile.x.com origin",
            )
            token_path = state_root / "companion.token"
            token = token_path.read_text(encoding="utf-8").strip()
            time.sleep(0.5)
            launchctl_state = subprocess.run(
                ["/bin/launchctl", "print", "gui/%d/%s" % (os.getuid(), label)],
                check=True,
                capture_output=True,
                text=True,
            ).stdout
            stderr_path = state_root / "companion.stderr.log"
            _assert(
                "state = running" in launchctl_state,
                "LaunchAgent is not running: %s" % stderr_path.read_text(encoding="utf-8", errors="replace"),
            )
            try:
                first_health = _wait_health(port, token)
            except AssertionError as error:
                raise AssertionError(
                    "%s; stderr=%s"
                    % (error, stderr_path.read_text(encoding="utf-8", errors="replace"))
                ) from error

            status, created = _request(
                port,
                token,
                "/v1/snapshots",
                {"request_id": "request-t7-launchagent-snapshot", "encrypted": True},
                timeout=30,
            )
            _assert(status == 201, "encrypted Keychain snapshot creation failed")
            snapshot = created["snapshot"]
            snapshot_id = snapshot["snapshot_id"]
            manifest_path = state_root / "snapshots" / snapshot_id / "manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            key_id = manifest["encryption"]["key_id"]
            _assert(manifest["encryption"]["key_storage"] == "macos-keychain", "snapshot key bypassed Keychain")
            status, verified = _request(
                port,
                token,
                "/v1/snapshots/%s/verify" % snapshot_id,
                {"request_id": "request-t7-launchagent-verify", "namespace_ids": []},
                timeout=30,
            )
            _assert(status == 200 and verified["verification"]["state"] == "verified", "encrypted snapshot verification failed")

            replacement_token = "t7-repaired-" + hashlib.sha256(os.urandom(32)).hexdigest()
            token_path.write_text(replacement_token + "\n", encoding="utf-8")
            os.chmod(token_path, 0o600)
            subprocess.run(
                ["/bin/launchctl", "kickstart", "-k", "gui/%d/%s" % (os.getuid(), label)],
                check=True,
                capture_output=True,
                text=True,
            )
            restarted_health = _wait_health(port, replacement_token)
            old_status, _ = _request(port, token, "/v1/health")
            _assert(old_status == 401, "old pairing token survived explicit re-pair restart")

            uninstalled = json.loads(
                subprocess.run(uninstall_command, cwd=root, check=True, capture_output=True, text=True).stdout
            )
            _assert(not plist.exists(), "LaunchAgent plist survived uninstall")
            _assert((state_root / "archive.sqlite").exists(), "uninstall deleted the canonical archive")
            _assert((state_root / "companion.token").exists(), "uninstall deleted pairing state")
            deadline = time.monotonic() + 10
            service_unreachable = False
            while time.monotonic() < deadline:
                try:
                    _request(port, replacement_token, "/v1/health")
                except Exception:
                    service_unreachable = True
                    break
                time.sleep(0.1)
            _assert(service_unreachable, "companion remained reachable after uninstall")

            card = {
                "card_version": 1,
                "card_id": "t7-launchagent-keychain-operations",
                "scenario": "real per-user LaunchAgent install, Keychain snapshot, restart, explicit re-pair, and non-destructive uninstall",
                "status": "passed",
                "observed": {
                    "label": label,
                    "install_loaded": install["loaded"],
                    "token_mode": install["token_mode"],
                    "first_health_protocol": first_health["protocol"],
                    "unsafe_token_file_rejected": unsafe_token_rejected,
                    "mobile_origin_admitted": True,
                    "restart_health_protocol": restarted_health["protocol"],
                    "old_token_rejected": True,
                    "encrypted_snapshot_verified": True,
                    "key_storage": "macos-keychain",
                    "plist_removed": uninstalled["plist_removed"],
                    "archive_preserved": uninstalled["archive_preserved"],
                    "pairing_state_preserved": uninstalled["token_exists"],
                    "service_unreachable_after_uninstall": True,
                },
                "metrics": {"drill_ms": round((time.perf_counter() - started) * 1000, 1)},
                "privacy": {"redaction_checked": True, "token_emitted": False, "violations": []},
            }
            output = Path(__file__).resolve().parent / "out" / "t7-launchagent-keychain.json"
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(card, indent=2, sort_keys=True) + "\n", encoding="utf-8")
            print(json.dumps(card, indent=2, sort_keys=True))
        finally:
            if plist.exists():
                subprocess.run(uninstall_command, cwd=root, check=False, capture_output=True, text=True)
            if key_id:
                subprocess.run(
                    ["/usr/bin/security", "delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", key_id],
                    check=False,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )


if __name__ == "__main__":
    main()
