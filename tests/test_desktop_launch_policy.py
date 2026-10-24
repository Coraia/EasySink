from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
DESKTOP = ROOT / "scripts/desktop"
sys.path.insert(0, str(DESKTOP))

from launch_policy import LaunchPolicyError, MARKER, validate_data_dir  # noqa: E402


def snapshot(root: Path) -> dict[str, tuple[str, int, str]]:
    result = {}
    if not root.exists():
        return result
    for path in sorted(root.rglob("*")):
        relative = str(path.relative_to(root))
        if path.is_symlink():
            result[relative] = ("symlink", 0, os.readlink(path))
        elif path.is_file():
            data = path.read_bytes()
            result[relative] = ("file", len(data), hashlib.sha256(data).hexdigest())
        else:
            result[relative] = ("directory", 0, "")
    return result


def mark(directory: Path) -> None:
    (directory / MARKER).write_text(json.dumps({"schema": 1, "role": "diagnostic"}))


def backend(*arguments: str, home: Path) -> subprocess.CompletedProcess[str]:
    environment = {**os.environ, "HOME": str(home)}
    return subprocess.run(
        [sys.executable, "-I", str(DESKTOP / "backend.py"), *arguments],
        cwd=ROOT, env=environment, text=True, capture_output=True, check=False,
    )


def test_python_policy_accepts_only_marked_isolated_directory(tmp_path: Path):
    formal = tmp_path / "Library/Application Support/EasySink Candidate"
    assert validate_data_dir(formal, "normal", home=tmp_path) == formal.resolve()
    with pytest.raises(LaunchPolicyError):
        validate_data_dir(tmp_path / "wrong-normal", "normal", home=tmp_path)
    isolated = tmp_path / "isolated"
    isolated.mkdir()
    with pytest.raises(LaunchPolicyError):
        validate_data_dir(isolated, "diagnostic", home=tmp_path)
    (isolated / MARKER).write_text(json.dumps({"schema": 1, "role": "formal"}))
    with pytest.raises(LaunchPolicyError):
        validate_data_dir(isolated, "diagnostic", home=tmp_path)
    mark(isolated)
    assert validate_data_dir(isolated, "diagnostic", home=tmp_path) == isolated.resolve()


@pytest.mark.parametrize("name", ["EasySink Candidate", "EasySink Paragraph Preview Data 002"])
def test_python_policy_rejects_protected_and_symlink_paths(tmp_path: Path, name: str):
    protected = tmp_path / "Library/Application Support" / name
    protected.mkdir(parents=True)
    mark(protected)
    alias = tmp_path / "alias"
    alias.symlink_to(protected, target_is_directory=True)
    child = protected / "child"
    child.mkdir()
    mark(child)
    before = snapshot(tmp_path)
    with pytest.raises(LaunchPolicyError):
        validate_data_dir(protected, "diagnostic", home=tmp_path)
    with pytest.raises(LaunchPolicyError):
        validate_data_dir(alias, "diagnostic", home=tmp_path)
    with pytest.raises(LaunchPolicyError):
        validate_data_dir(child, "diagnostic", home=tmp_path)
    assert snapshot(tmp_path) == before


def test_backend_help_unknown_and_missing_data_dir_are_side_effect_free(tmp_path: Path):
    before = snapshot(tmp_path)
    help_result = backend("--help", home=tmp_path)
    unknown_result = backend("--unknown", home=tmp_path)
    missing_result = backend("--launch-purpose", "diagnostic", home=tmp_path)
    assert help_result.returncode == 0 and "--data-dir" in help_result.stdout
    assert unknown_result.returncode != 0
    assert missing_result.returncode != 0
    assert snapshot(tmp_path) == before


def test_backend_rejects_protected_and_symlink_before_writes(tmp_path: Path):
    protected = tmp_path / "Library/Application Support/EasySink Candidate"
    protected.mkdir(parents=True)
    mark(protected)
    sentinel = protected / "sentinel"
    sentinel.write_text("unchanged")
    alias = tmp_path / "alias"
    alias.symlink_to(protected, target_is_directory=True)
    token = "A" * 32
    for candidate in (protected, alias):
        before = snapshot(tmp_path)
        result = backend(
            "--data-dir", str(candidate), "--launch-purpose", "diagnostic",
            "--ready-file", str(candidate / "ready.json"), "--token", token,
            home=tmp_path,
        )
        assert result.returncode != 0
        assert "Protected EasySink libraries" in result.stderr
        assert snapshot(tmp_path) == before
        assert not (protected / "desktop.lock").exists()
