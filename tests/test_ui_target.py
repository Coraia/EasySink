from __future__ import annotations

import hashlib
from pathlib import Path
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts/desktop"))

from ui_target import ProcessIdentity, UITargetError, verify_existing_target  # noqa: E402


def test_ui_target_requires_existing_matching_pid_hash_path_and_bundle(tmp_path: Path):
    executable = tmp_path / "EasySink Diagnostic.app/Contents/MacOS/WiseReader"
    executable.parent.mkdir(parents=True)
    executable.write_bytes(b"frozen diagnostic executable")
    digest = hashlib.sha256(executable.read_bytes()).hexdigest()
    identity = ProcessIdentity(8123, executable.resolve(), "Thu Oct 23 18:00:00 2026",
                               "com.coraia.wisereader.diagnostic")

    result = verify_existing_target(
        8123, executable, digest, identity.bundle_id, inspector=lambda pid: identity)
    assert result == identity

    with pytest.raises(UITargetError, match="positive existing PID"):
        verify_existing_target(0, executable, digest, identity.bundle_id, inspector=lambda pid: identity)
    with pytest.raises(UITargetError, match="different PID"):
        verify_existing_target(8124, executable, digest, identity.bundle_id, inspector=lambda pid: identity)
    with pytest.raises(UITargetError, match="executable"):
        other = tmp_path / "other"
        other.write_bytes(b"other")
        verify_existing_target(
            8123, other, hashlib.sha256(b"other").hexdigest(), identity.bundle_id,
            inspector=lambda pid: identity)
    with pytest.raises(UITargetError, match="bundle identifier"):
        verify_existing_target(
            8123, executable, digest, "com.coraia.wisereader.candidate",
            inspector=lambda pid: identity)
    with pytest.raises(UITargetError, match="hash"):
        verify_existing_target(8123, executable, "0" * 64, identity.bundle_id, inspector=lambda pid: identity)
