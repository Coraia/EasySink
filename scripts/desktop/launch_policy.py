"""Fail-closed validation for desktop data directories before any runtime writes."""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path

MARKER = ".easysink-diagnostic-data.json"
PROTECTED_NAMES = ("EasySink Candidate", "EasySink Paragraph Preview Data 002")


class LaunchPolicyError(ValueError):
    pass


def protected_directories(home: Path | None = None) -> tuple[Path, ...]:
    support = (home or Path.home()).expanduser() / "Library/Application Support"
    return tuple((support / name).resolve(strict=False) for name in PROTECTED_NAMES)


def _contains(root: Path, candidate: Path) -> bool:
    return candidate == root or root in candidate.parents


def validate_data_dir(data_dir: Path, purpose: str, *, home: Path | None = None) -> Path:
    protected = protected_directories(home)
    if purpose == "normal":
        candidate = data_dir.expanduser().resolve(strict=False)
        if candidate != protected[0]:
            raise LaunchPolicyError("Normal launch must use the formal EasySink Candidate library.")
        return candidate
    if purpose != "diagnostic":
        raise LaunchPolicyError("Unknown desktop launch purpose.")
    try:
        candidate = data_dir.expanduser().resolve(strict=True)
    except OSError as exc:
        raise LaunchPolicyError("Diagnostic data directory must already exist.") from exc
    if not candidate.is_dir():
        raise LaunchPolicyError("Diagnostic data directory must be a directory.")
    if any(_contains(root, candidate) for root in protected):
        raise LaunchPolicyError("Protected EasySink libraries cannot be used for diagnostics.")
    if not os.access(candidate, os.W_OK):
        raise LaunchPolicyError("Diagnostic data directory must be writable.")
    marker = candidate / MARKER
    try:
        information = marker.lstat()
        if not stat.S_ISREG(information.st_mode) or stat.S_ISLNK(information.st_mode) or information.st_size > 4096:
            raise LaunchPolicyError("Diagnostic marker must be a small regular file, not a symlink.")
        payload = json.loads(marker.read_text(encoding="utf-8"))
    except LaunchPolicyError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise LaunchPolicyError("Diagnostic marker is missing or invalid.") from exc
    if not isinstance(payload, dict) or payload.get("schema") != 1 or payload.get("role") != "diagnostic":
        raise LaunchPolicyError("Diagnostic marker has the wrong schema or role.")
    return candidate
