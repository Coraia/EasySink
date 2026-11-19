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

from launch_policy import (  # noqa: E402
    BUILD_MANIFEST,
    PROFILES,
    LaunchPolicyError,
    fixed_directory,
    load_packaged_profile,
    validate_packaged_data_dir,
)


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


def profile(flavor: str) -> dict[str, object]:
    return {"schema": 1, "flavor": flavor, **PROFILES[flavor]}


def packaged_root(tmp_path: Path, flavor: str) -> Path:
    root = tmp_path / ("package-" + flavor)
    root.mkdir(mode=0o700)
    (root / BUILD_MANIFEST).write_text(json.dumps(profile(flavor)), encoding="utf-8")
    return root


def secure_directory(path: Path) -> None:
    path.mkdir(mode=0o700, parents=True)
    path.chmod(0o700)


def backend(*arguments: str, home: Path) -> subprocess.CompletedProcess[str]:
    environment = {**os.environ, "HOME": str(home)}
    return subprocess.run(
        [sys.executable, "-I", str(DESKTOP / "backend.py"), *arguments],
        cwd=ROOT, env=environment, text=True, capture_output=True, check=False,
    )


def test_source_profile_is_fixed_production_identity():
    loaded = load_packaged_profile(ROOT)
    assert loaded == profile("production")


def test_production_preview_and_diagnostic_roots_are_fixed(tmp_path: Path):
    formal = fixed_directory(profile("production"), tmp_path)
    preview = fixed_directory(profile("preview"), tmp_path)
    assert formal.name == "EasySink Candidate"
    assert preview.name == "EasySink Paragraph Preview Data 002"

    package = packaged_root(tmp_path, "diagnostic")
    diagnostic = fixed_directory(profile("diagnostic"), tmp_path)
    arguments = (
        "diagnostic",
        str(profile("diagnostic")["bundle_id"]),
        str(profile("diagnostic")["root_id"]),
    )
    # Resolves cleanly before the directory exists, as well as once created.
    assert validate_packaged_data_dir(diagnostic, *arguments, app_root=package, home=tmp_path) == diagnostic.resolve(strict=False)
    secure_directory(diagnostic)
    assert validate_packaged_data_dir(diagnostic, *arguments, app_root=package, home=tmp_path) == diagnostic.resolve()

    with pytest.raises(LaunchPolicyError, match="fixed root"):
        validate_packaged_data_dir(tmp_path / "caller-override", *arguments, app_root=package, home=tmp_path)


def test_diagnostic_rejects_symlinks_and_non_directories_without_touching_protected(tmp_path: Path):
    package = packaged_root(tmp_path, "diagnostic")
    diagnostic = fixed_directory(profile("diagnostic"), tmp_path)
    protected_formal = fixed_directory(profile("production"), tmp_path)
    protected_preview = fixed_directory(profile("preview"), tmp_path)
    secure_directory(protected_formal)
    secure_directory(protected_preview)
    protected_before = (snapshot(protected_formal), snapshot(protected_preview))
    arguments = (
        "diagnostic",
        str(profile("diagnostic")["bundle_id"]),
        str(profile("diagnostic")["root_id"]),
    )

    # Regular file at the fixed diagnostic path fails.
    diagnostic.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    diagnostic.write_text("not-a-dir", encoding="utf-8")
    with pytest.raises(LaunchPolicyError, match="directory"):
        validate_packaged_data_dir(diagnostic, *arguments, app_root=package, home=tmp_path)
    diagnostic.unlink()

    # Dangling symlink at the fixed diagnostic path fails.
    diagnostic.symlink_to(tmp_path / "nonexistent-target")
    with pytest.raises(LaunchPolicyError, match="symlink"):
        validate_packaged_data_dir(diagnostic, *arguments, app_root=package, home=tmp_path)
    diagnostic.unlink()

    # Symlink to an existing directory fails.
    target = tmp_path / "symlink-target"
    secure_directory(target)
    alias_home = tmp_path / "alias-home"
    alias_support = alias_home / "Library/Application Support"
    secure_directory(alias_support)
    alias = fixed_directory(profile("diagnostic"), alias_home)
    alias.symlink_to(target, target_is_directory=True)
    with pytest.raises(LaunchPolicyError, match="symlink"):
        validate_packaged_data_dir(alias, *arguments, app_root=package, home=alias_home)

    assert snapshot(protected_formal) == protected_before[0]
    assert snapshot(protected_preview) == protected_before[1]


def test_backend_help_unknown_missing_and_forged_identity_are_side_effect_free(tmp_path: Path):
    diagnostic = fixed_directory(profile("diagnostic"), tmp_path)
    before = snapshot(tmp_path)
    help_result = backend("--help", home=tmp_path)
    unknown_result = backend("--unknown", home=tmp_path)
    missing_result = backend("--launch-flavor", "diagnostic", home=tmp_path)
    forged_result = backend(
        "--data-dir", str(diagnostic), "--launch-flavor", "diagnostic",
        "--bundle-id", str(profile("diagnostic")["bundle_id"]),
        "--root-id", str(profile("diagnostic")["root_id"]),
        "--ready-file", str(diagnostic / "ready.json"), "--token", "A" * 32,
        home=tmp_path,
    )
    assert help_result.returncode == 0 and "--data-dir" in help_result.stdout
    assert unknown_result.returncode != 0
    assert missing_result.returncode != 0
    assert forged_result.returncode != 0
    assert "does not match the packaged build profile" in forged_result.stderr
    assert snapshot(tmp_path) == before
    assert not (diagnostic / "desktop.lock").exists()


def test_packaged_manifest_and_info_plist_must_agree(tmp_path: Path):
    app = tmp_path / "EasySink Diagnostic.app/Contents/Resources/app"
    app.mkdir(parents=True)
    (app / BUILD_MANIFEST).write_text(json.dumps(profile("diagnostic")), encoding="utf-8")
    info = app.parents[1] / "Info.plist"
    info.write_bytes(
        b'<?xml version="1.0"?><plist version="1.0"><dict>'
        b'<key>CFBundleIdentifier</key><string>com.coraia.wisereader.candidate</string>'
        b'</dict></plist>')
    with pytest.raises(LaunchPolicyError, match="Info.plist"):
        load_packaged_profile(app)
