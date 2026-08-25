"""Versioned per-user macOS LaunchAgent packaging for the Scrollmark companion."""
from __future__ import annotations

import argparse
import json
import os
import plistlib
import secrets
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, Optional

DEFAULT_LABEL = "com.scrollmark.companion"


def _write_atomic(path: Path, payload: bytes, mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(".%s.%s.tmp" % (path.name, secrets.token_hex(6)))
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        os.write(descriptor, payload)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.replace(temporary, path)
    os.chmod(path, mode)


def _domain() -> str:
    return "gui/%d" % os.getuid()


def _bootout(label: str) -> None:
    subprocess.run(
        ["/bin/launchctl", "bootout", "%s/%s" % (_domain(), label)],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def _paths(label: str, state_root: Path, plist_path: Optional[Path]) -> Dict[str, Path]:
    launch_agents = Path.home() / "Library" / "LaunchAgents"
    return {
        "state_root": state_root,
        "database": state_root / "archive.sqlite",
        "snapshots": state_root / "snapshots",
        "token": state_root / "companion.token",
        "stdout": state_root / "companion.stdout.log",
        "stderr": state_root / "companion.stderr.log",
        "plist": plist_path or launch_agents / (label + ".plist"),
    }


def install(args: argparse.Namespace) -> Dict[str, Any]:
    label = args.label
    state_root = Path(args.state_root).expanduser().resolve()
    plist_path = Path(args.plist).expanduser().resolve() if args.plist else None
    paths = _paths(label, state_root, plist_path)
    state_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(state_root, 0o700)
    paths["snapshots"].mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(paths["snapshots"], 0o700)
    if not paths["token"].exists():
        _write_atomic(paths["token"], (secrets.token_urlsafe(48) + "\n").encode("ascii"), 0o600)
    else:
        os.chmod(paths["token"], 0o600)

    project_root = Path(__file__).resolve().parents[1]
    program_arguments = [
        sys.executable,
        "-m",
        "scrollmark_companion",
        "--db",
        str(paths["database"]),
        "--token-file",
        str(paths["token"]),
        "--snapshot-root",
        str(paths["snapshots"]),
        "--host",
        "127.0.0.1",
        "--port",
        str(args.port),
    ]
    for origin in args.origin:
        program_arguments.extend(["--origin", origin])
    plist = {
        "Label": label,
        "ProgramArguments": program_arguments,
        "WorkingDirectory": str(project_root),
        "EnvironmentVariables": {"PYTHONPATH": str(project_root)},
        "RunAtLoad": True,
        "KeepAlive": {"SuccessfulExit": False},
        "ProcessType": "Background",
        "StandardOutPath": str(paths["stdout"]),
        "StandardErrorPath": str(paths["stderr"]),
    }
    _write_atomic(paths["plist"], plistlib.dumps(plist, fmt=plistlib.FMT_XML, sort_keys=True), 0o600)
    if args.load:
        _bootout(label)
        subprocess.run(["/bin/launchctl", "bootstrap", _domain(), str(paths["plist"])], check=True)
    return {
        "status": "installed",
        "label": label,
        "loaded": bool(args.load),
        "plist": str(paths["plist"]),
        "state_root": str(state_root),
        "archive_preserved": True,
        "token_mode": oct(paths["token"].stat().st_mode & 0o777),
    }


def uninstall(args: argparse.Namespace) -> Dict[str, Any]:
    state_root = Path(args.state_root).expanduser().resolve()
    plist_path = Path(args.plist).expanduser().resolve() if args.plist else None
    paths = _paths(args.label, state_root, plist_path)
    _bootout(args.label)
    paths["plist"].unlink(missing_ok=True)
    return {
        "status": "uninstalled",
        "label": args.label,
        "plist_removed": not paths["plist"].exists(),
        "state_root": str(state_root),
        "archive_preserved": True,
        "database_exists": paths["database"].exists(),
        "token_exists": paths["token"].exists(),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Install or uninstall the Scrollmark per-user LaunchAgent")
    parser.add_argument("action", choices=("install", "uninstall"))
    parser.add_argument("--label", default=DEFAULT_LABEL)
    parser.add_argument(
        "--state-root",
        default=str(Path.home() / "Library" / "Application Support" / "Scrollmark"),
    )
    parser.add_argument("--plist", help="override the per-user LaunchAgent plist path")
    parser.add_argument("--port", type=int, default=8755)
    parser.add_argument(
        "--origin",
        action="append",
        default=["https://x.com", "https://twitter.com", "https://mobile.x.com"],
    )
    parser.add_argument("--load", action="store_true", help="bootstrap the LaunchAgent immediately")
    args = parser.parse_args()
    result = install(args) if args.action == "install" else uninstall(args)
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
