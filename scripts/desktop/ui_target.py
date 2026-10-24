#!/usr/bin/env python3
"""Verify an already-running UI target by PID; this module never launches an App."""

from __future__ import annotations

import argparse
import ctypes
from dataclasses import asdict, dataclass
from datetime import datetime
import hashlib
import json
from pathlib import Path
import plistlib
import subprocess
from typing import Callable


class UITargetError(ValueError):
    pass


@dataclass(frozen=True)
class ProcessIdentity:
    pid: int
    executable: Path
    started_at: str
    bundle_id: str


def file_sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def bundle_info(executable: Path) -> dict[str, object]:
    if executable.parent.name != "MacOS" or executable.parent.parent.name != "Contents":
        raise UITargetError("Process executable is not inside a macOS application bundle.")
    info_path = executable.parent.parent / "Info.plist"
    try:
        with info_path.open("rb") as stream:
            return plistlib.load(stream)
    except (OSError, plistlib.InvalidFileException) as exc:
        raise UITargetError("Process bundle has no valid Info.plist.") from exc


def inspect_process(pid: int) -> ProcessIdentity:
    if pid <= 0:
        raise UITargetError("A positive existing PID is required.")
    buffer = ctypes.create_string_buffer(4096)
    try:
        libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        libproc.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
        libproc.proc_pidpath.restype = ctypes.c_int
        length = libproc.proc_pidpath(pid, buffer, len(buffer))
        if length <= 0:
            raise OSError(ctypes.get_errno(), "proc_pidpath failed")
        executable = Path(buffer.value.decode("utf-8")).resolve(strict=True)
        result = subprocess.run(
            ["/bin/ps", "-p", str(pid), "-o", "lstart="], check=True,
            text=True, capture_output=True, timeout=5)
        started_at = result.stdout.strip()
        if not started_at:
            raise OSError("ps returned no start time")
        datetime.strptime(started_at, "%a %b %d %H:%M:%S %Y")
    except (OSError, subprocess.SubprocessError, UnicodeError, ValueError) as exc:
        raise UITargetError("The requested PID is not an inspectable running process.") from exc
    info = bundle_info(executable)
    bundle_id = info.get("CFBundleIdentifier")
    if not isinstance(bundle_id, str):
        raise UITargetError("The running process bundle has no identifier.")
    return ProcessIdentity(pid=pid, executable=executable, started_at=started_at, bundle_id=bundle_id)


def verify_existing_target(pid: int, expected_executable: Path, expected_sha256: str,
                           expected_bundle_id: str,
                           *, inspector: Callable[[int], ProcessIdentity] = inspect_process) -> ProcessIdentity:
    if pid <= 0:
        raise UITargetError("A positive existing PID is required; implicit launch is forbidden.")
    expected = expected_executable.expanduser().resolve(strict=True)
    if file_sha256(expected) != expected_sha256:
        raise UITargetError("Expected executable hash does not match the frozen test receipt.")
    identity = inspector(pid)
    if identity.pid != pid:
        raise UITargetError("Inspector returned a different PID.")
    if identity.executable.resolve(strict=True) != expected:
        raise UITargetError("Running PID executable does not match the frozen target.")
    if identity.bundle_id != expected_bundle_id:
        raise UITargetError("Running PID bundle identifier does not match the frozen target.")
    return identity


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pid", required=True, type=int)
    parser.add_argument("--executable", required=True, type=Path)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--bundle-id", required=True)
    args = parser.parse_args()
    try:
        identity = verify_existing_target(
            args.pid, args.executable, args.sha256, args.bundle_id)
    except (OSError, UITargetError) as exc:
        parser.error(str(exc))
    print(json.dumps({**asdict(identity), "executable": str(identity.executable)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
