"""Fail-closed build-flavor and fixed data-root validation before runtime writes."""

from __future__ import annotations

import json
import os
import plistlib
import stat
from pathlib import Path

MARKER = ".easysink-diagnostic-data.json"
BUILD_MANIFEST = "desktop-build-flavor.json"
PROTECTED_NAMES = ("EasySink Candidate", "EasySink Paragraph Preview Data 002")
PROFILES = {
    "production": {
        "bundle_id": "com.coraia.wisereader.candidate",
        "product_name": "EasySink",
        "data_directory_name": "EasySink Candidate",
        "root_id": "easysink-formal-candidate",
    },
    "preview": {
        "bundle_id": "com.coraia.wisereader.preview",
        "product_name": "EasySink Preview",
        "data_directory_name": "EasySink Paragraph Preview Data 002",
        "root_id": "easysink-preview-002",
    },
    "diagnostic": {
        "bundle_id": "com.coraia.wisereader.diagnostic",
        "product_name": "EasySink Diagnostic",
        "data_directory_name": "EasySink Diagnostic Data 001",
        "root_id": "easysink-diagnostic-001",
    },
}


class LaunchPolicyError(ValueError):
    pass


def protected_directories(home: Path | None = None) -> tuple[Path, ...]:
    support = (home or Path.home()).expanduser().resolve(strict=False) / "Library/Application Support"
    return tuple((support / name).resolve(strict=False) for name in PROTECTED_NAMES)


def fixed_directory(profile: dict[str, object], home: Path | None = None) -> Path:
    support = (home or Path.home()).expanduser().resolve(strict=False) / "Library/Application Support"
    return support / str(profile["data_directory_name"])


def _contains(root: Path, candidate: Path) -> bool:
    return candidate == root or root in candidate.parents


def _regular_json(path: Path, *, maximum: int = 4096) -> dict[str, object]:
    try:
        information = path.lstat()
        if not stat.S_ISREG(information.st_mode) or stat.S_ISLNK(information.st_mode) or information.st_size > maximum:
            raise LaunchPolicyError(f"{path.name} must be a small regular file, not a symlink.")
        payload = json.loads(path.read_text(encoding="utf-8"))
    except LaunchPolicyError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise LaunchPolicyError(f"{path.name} is missing or invalid.") from exc
    if not isinstance(payload, dict):
        raise LaunchPolicyError(f"{path.name} must contain a JSON object.")
    return payload


def load_packaged_profile(app_root: Path) -> dict[str, object]:
    app_root = app_root.resolve(strict=True)
    payload = _regular_json(app_root / BUILD_MANIFEST)
    flavor = payload.get("flavor")
    expected = PROFILES.get(flavor) if isinstance(flavor, str) else None
    required = {"schema": 1, "flavor": flavor, **(expected or {})}
    if expected is None or any(payload.get(key) != value for key, value in required.items()):
        raise LaunchPolicyError("Packaged desktop build profile is unknown or inconsistent.")

    info_plist = app_root.parents[1] / "Info.plist"
    if info_plist.exists():
        try:
            with info_plist.open("rb") as stream:
                info = plistlib.load(stream)
        except (OSError, plistlib.InvalidFileException) as exc:
            raise LaunchPolicyError("Packaged Info.plist is invalid.") from exc
        checks = {
            "CFBundleIdentifier": payload["bundle_id"],
            "CFBundleDisplayName": payload["product_name"],
            "EasySinkBuildFlavor": payload["flavor"],
            "EasySinkDataDirectoryName": payload["data_directory_name"],
            "EasySinkRootID": payload["root_id"],
        }
        if any(info.get(key) != value for key, value in checks.items()):
            raise LaunchPolicyError("Packaged Info.plist does not match the desktop build profile.")
    return payload


def _validate_owner_and_mode(path: Path, kind: str) -> None:
    information = path.lstat()
    if information.st_uid != os.getuid():
        raise LaunchPolicyError(f"{kind} must be owned by the current user.")
    if stat.S_IMODE(information.st_mode) & 0o077:
        raise LaunchPolicyError(f"{kind} must not be accessible by group or other users.")


def _validate_diagnostic_root(candidate: Path, profile: dict[str, object], home: Path | None) -> Path:
    if not candidate.exists() or not candidate.is_dir() or candidate.is_symlink():
        raise LaunchPolicyError("The fixed diagnostic data root must already be a real directory.")
    canonical = candidate.resolve(strict=True)
    if canonical != candidate:
        raise LaunchPolicyError("The fixed diagnostic data root contains a symlink.")
    if any(_contains(root, canonical) for root in protected_directories(home)):
        raise LaunchPolicyError("Protected EasySink libraries cannot be used for diagnostics.")
    _validate_owner_and_mode(canonical, "Diagnostic data root")
    marker = canonical / MARKER
    payload = _regular_json(marker)
    _validate_owner_and_mode(marker, "Diagnostic marker")
    expected = {
        "schema": 2,
        "role": "diagnostic",
        "root_id": profile["root_id"],
        "bundle_id": profile["bundle_id"],
    }
    if any(payload.get(key) != value for key, value in expected.items()):
        raise LaunchPolicyError("Diagnostic marker identity does not match this build.")
    return canonical


def validate_packaged_data_dir(data_dir: Path, flavor: str, bundle_id: str, root_id: str,
                               *, app_root: Path, home: Path | None = None) -> Path:
    profile = load_packaged_profile(app_root)
    supplied = {"flavor": flavor, "bundle_id": bundle_id, "root_id": root_id}
    if any(profile.get(key) != value for key, value in supplied.items()):
        raise LaunchPolicyError("Backend launch identity does not match the packaged build profile.")
    expected = fixed_directory(profile, home)
    requested = data_dir.expanduser().absolute()
    if requested != expected:
        raise LaunchPolicyError("Data directory does not match the fixed root for this build.")
    if flavor == "diagnostic":
        return _validate_diagnostic_root(expected, profile, home)
    return expected.resolve(strict=False)
