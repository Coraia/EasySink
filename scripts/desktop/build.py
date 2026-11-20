#!/usr/bin/env python3
"""Build the local arm64 candidate; Swift and uv are build-only dependencies.

Rebuild with --dependency-lock dist/desktop-dependencies.lock to reuse exact
wheel hashes. --refresh-app updates only owned build resources/native binary,
reusing the already bundled Python/dependencies/dictionary without a second copy.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import platform
import plistlib
import re
import shutil
import subprocess
import sys
import time
import tomllib
from pathlib import Path
from launch_policy import PROFILES

ROOT = Path(__file__).resolve().parents[2]
ICON = ROOT / "desktop/Assets/EasySink.icns"
VERSION = "1.3.0"
BUILD = "39"
RELEASE_STATUS = "Step 0-4 cleanup complete; open-word-card horizontal swipe paging restored, double-spread spine-curl and reflow closePop races fixed, ReadingStorage simplified."
PDFJS_ROOT = ROOT / "web/vendor/pdfjs-6.4.299"
PDFJS_MANIFEST = PDFJS_ROOT / "SOURCE.json"
PDF_PINS = {
    "pdfplumber": "0.11.10", "pdfminer-six": "20260107", "pypdfium2": "5.14.0",
    "pillow": "12.3.0", "charset-normalizer": "3.5.2", "cryptography": "50.0.2",
    "cffi": "2.1.1", "pycparser": "3.0", "psutil": "7.2.2",
}
DIRECT = ("fastapi", "uvicorn", "httpx", "pydantic", "pydantic-settings", "python-multipart", "markdown-it-py")
SCRIPTS = ("scripts/pdf_lab_convert.py", "scripts/formula_recognize.py",
           "scripts/setup_mineru_runtime.py", "scripts/desktop/backend.py",
           "scripts/desktop/launch_policy.py", "scripts/desktop/runtime.py",
           "scripts/desktop/prepare_ocr.py")


def run(command, **kwargs):
    return subprocess.run([str(x) for x in command], check=True, **kwargs)


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def source_revision():
    revision = run(["git", "rev-parse", "HEAD"], cwd=ROOT,
                   capture_output=True, text=True).stdout.strip()
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise RuntimeError("Source checkout does not have a full Git commit identity.")
    if run(["git", "status", "--porcelain"], cwd=ROOT,
           capture_output=True, text=True).stdout:
        return f"{revision}-dirty"
    return revision


def copy(source, destination):
    if source.is_symlink():
        raise ValueError(f"Source allowlist cannot contain symlinks: {source}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)


def clone_file(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if subprocess.run(["cp", "-c", str(source), str(destination)], capture_output=True).returncode != 0:
        shutil.copyfile(source, destination)


def _make_writable(root: Path) -> None:
    if not root.exists() or root.is_symlink():
        return
    if root.is_dir():
        root.chmod(root.stat().st_mode | 0o700)
        for path in root.rglob("*"):
            if not path.is_symlink():
                path.chmod(path.stat().st_mode | (0o700 if path.is_dir() else 0o200))
    else:
        root.chmod(root.stat().st_mode | 0o200)


def require_pdfjs():
    manifest = json.loads(PDFJS_MANIFEST.read_text(encoding="utf-8"))
    if manifest.get("version") != "6.4.299":
        raise RuntimeError("PDF.js source manifest has an unexpected version")
    expected = dict(manifest["files"])
    license_spec = manifest["license"]
    expected[license_spec["path"]] = license_spec
    for relative, item in expected.items():
        path = PDFJS_ROOT / relative
        if (not path.is_file() or path.is_symlink() or path.stat().st_size != item["bytes"] or
                sha(path) != item["sha256"]):
            raise RuntimeError(
                f"Pinned PDF.js resource is missing or changed: {relative}; "
                "run `python3 scripts/fetch_pdfjs.py` and rebuild")


def source_files():
    """Include production modules, web assets, and desktop worker scripts."""
    for source in sorted((ROOT / "src").rglob("*.py")):
        if "__pycache__" not in source.parts:
            yield source
    for source in sorted((ROOT / "web").rglob("*")):
        relative = source.relative_to(ROOT / "web")
        if any(part.startswith(".") or part == "__pycache__" for part in relative.parts):
            continue
        if source.is_file():
            yield source
    yield from (ROOT / relative for relative in SCRIPTS)


def resources(app):
    app.mkdir(parents=True, exist_ok=True)
    for name in ("src", "web", "scripts"):
        target = app / name
        if target.exists():
            shutil.rmtree(target)
    for source in source_files():
        copy(source, app / source.relative_to(ROOT))
    for name in ("stardict.db", "lemma.en.txt"):
        source, target = ROOT / "data" / name, app / "data" / name
        if target.exists():
            if target.stat().st_size == source.stat().st_size and sha(target) == sha(source):
                continue
            target.unlink()
        clone_file(source, target)


def runtime_source(uv, supplied):
    if supplied:
        runtime = supplied.expanduser().resolve()
    else:
        executable = run([uv, "python", "find", "--managed-python", "--no-python-downloads", "3.12"],
                         capture_output=True, text=True).stdout.strip()
        runtime = Path(executable).resolve().parents[1]
    executable = runtime / "bin/python3.12"
    info = json.loads(run([executable, "-I", "-c",
        "import sys,platform,json; print(json.dumps({'version':platform.python_version(),'machine':platform.machine(),'prefix':sys.prefix,'base_prefix':sys.base_prefix}))"],
        capture_output=True, text=True).stdout)
    if info["machine"] != "arm64" or info["prefix"] != info["base_prefix"] or not (runtime / "BUILD").is_file():
        raise RuntimeError("Use a managed standalone arm64 CPython installation, not a venv/Homebrew Python.")
    return runtime, info


def dependencies(uv, python, output, supplied):
    lock = output / "desktop-dependencies.lock"
    if supplied:
        if supplied.resolve() != lock.resolve():
            shutil.copyfile(supplied, lock)
    elif not lock.exists():
        packages = tomllib.loads((ROOT / "uv.lock").read_text())["package"]
        pins = {p["name"]: p["version"] for p in packages if p["name"] != "wise-reader"}
        pins.update(PDF_PINS)
        constraints = output / "desktop-constraints.txt"
        constraints.write_text("\n".join(f"{name}=={value}" for name, value in sorted(pins.items())) + "\n")
        inputs = output / "desktop-dependencies.in"
        inputs.write_text("\n".join(f"{name}=={pins[name]}" for name in (*DIRECT, *PDF_PINS)) + "\n")
        run([uv, "pip", "compile", inputs, "--constraint", constraints, "--python", python,
             "--generate-hashes", "--only-binary", ":all:", "--output-file", lock, "--quiet"])
    target = python.parent.parent / "lib/python3.12/site-packages"
    run([uv, "pip", "install", "--python", python, "--target", target,
         "--require-hashes", "--only-binary", ":all:", "--link-mode", "copy", "-r", lock])
    # Also applies to conversion child Python processes that don't use -I/-B.
    (target / "sitecustomize.py").write_text("import sys\nsys.dont_write_bytecode = True\n")
    # Entry-point scripts are not used. They contain build-path shebangs.
    if (target / "bin").exists():
        shutil.rmtree(target / "bin")
    for path in target.rglob("*.pyc"):
        path.unlink()
    return lock


def audit_native_runtime(root, output):
    """Reject external dylib loads and remove upstream build-only search paths."""
    records = []
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.is_symlink():
            continue
        with path.open("rb") as stream:
            magic = stream.read(4)
        if magic not in (b"\xcf\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca"):
            continue
        raw = run(["otool", "-l", path], capture_output=True, text=True).stdout
        changes, dependencies_list = [], []
        for block in raw.split("Load command ")[1:]:
            command = re.search(r"\bcmd (LC_\w+)", block)
            name = re.search(r"\n\s+(?:name|path) (.+?) \(offset", block)
            if not command or not name:
                continue
            command, name = command.group(1), name.group(1)
            external = name.startswith("/") and not name.startswith(("/usr/lib/", "/System/Library/"))
            if command == "LC_RPATH" and external:
                changes.extend(["-delete_rpath", name])
            elif command == "LC_ID_DYLIB" and path.name == "libpython3.12.dylib" and external:
                changes.extend(["-id", "@rpath/libpython3.12.dylib"])
            elif command in {"LC_LOAD_DYLIB", "LC_LOAD_WEAK_DYLIB", "LC_REEXPORT_DYLIB"}:
                if external:
                    raise RuntimeError(f"Nonportable native dependency in {path.name}: {name}")
                dependencies_list.append(name)
        if changes:
            path.chmod(0o755)
            directory_mode = path.parent.stat().st_mode & 0o777
            path.parent.chmod(0o755)
            try:
                run(["install_name_tool", *changes, path])
                run(["codesign", "--force", "--sign", "-", path])
            finally:
                path.parent.chmod(directory_mode)
        records.append({"path": str(path.relative_to(root)), "loads": dependencies_list, "adjustments": changes})
    (output / "desktop-native-dependencies.json").write_text(json.dumps(records, indent=2) + "\n")


def _verify_refresh_flavor(bundle: Path, flavor: str, expected_bundle_id: str, parser: argparse.ArgumentParser) -> None:
    manifest = bundle / "Contents/Resources/app/desktop-build-flavor.json"
    if manifest.is_file():
        payload = json.loads(manifest.read_text(encoding="utf-8"))
        if payload.get("flavor") != flavor or payload.get("bundle_id") != expected_bundle_id:
            parser.error("--refresh-app cannot change the existing bundle's build flavor")
        return
    info_plist = bundle / "Contents/Info.plist"
    if info_plist.is_file():
        with info_plist.open("rb") as stream:
            info = plistlib.load(stream)
        if info.get("EasySinkBuildFlavor") != flavor or info.get("CFBundleIdentifier") != expected_bundle_id:
            parser.error("--refresh-app cannot change the existing bundle's build flavor")
        return
    parser.error("--refresh-app cannot verify the existing bundle's build flavor")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", type=Path, help="Existing standalone CPython 3.12 root")
    parser.add_argument("--output", type=Path, default=ROOT / "dist")
    parser.add_argument("--dependency-lock", type=Path)
    parser.add_argument("--flavor", choices=tuple(PROFILES), default="production")
    parser.add_argument("--refresh-app", action="store_true")
    parser.add_argument("--archive", action="store_true", help="Also produce a compressed distributable ZIP")
    args = parser.parse_args()
    started = time.monotonic()
    if sys.platform != "darwin" or platform.machine() != "arm64":
        parser.error("This candidate build requires an Apple Silicon Mac.")
    uv = shutil.which("uv")
    if not uv:
        parser.error("uv is required only on the build machine")
    require_pdfjs()
    if not ICON.is_file() or ICON.is_symlink():
        parser.error("desktop/Assets/EasySink.icns must be a regular checked-in build input")
    swift = sorted((ROOT / "desktop").glob("*.swift"))
    if not (ROOT / "desktop/App.swift").is_file():
        parser.error("Main must supply desktop/App.swift first")

    dependency_lock = (args.dependency_lock or ROOT / "scripts/desktop/dependencies.lock").resolve()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    profile = {"schema": 1, "flavor": args.flavor, **PROFILES[args.flavor]}
    bundle = output / (profile["product_name"] + ".app")
    if args.refresh_app:
        if not (bundle.is_dir()
                and (bundle / "Contents/Resources/python/bin/python3").is_file()
                and (bundle / "Contents/Resources/python/BUILD").is_file()):
            parser.error("--refresh-app requires this builder's existing EasySink.app and bundled Python runtime")
        _verify_refresh_flavor(bundle, args.flavor, profile["bundle_id"], parser)
    elif bundle.exists():
        parser.error("Output exists; --refresh-app reuses this builder's runtime/dictionary, or choose --output DIR")

    revision = source_revision()
    contents = bundle / "Contents"
    macos = contents / "MacOS"
    macos.mkdir(parents=True, exist_ok=True)
    resource_root = contents / "Resources"
    resource_root.mkdir(parents=True, exist_ok=True)

    defines = {"preview": ["-D", "EASYSINK_PREVIEW"],
               "diagnostic": ["-D", "EASYSINK_DIAGNOSTIC"]}.get(args.flavor, [])
    run(["xcrun", "swiftc", "-parse-as-library", "-O", "-target", "arm64-apple-macos13.0",
         *defines, "-module-name", "WiseReader", *swift, "-o", macos / "WiseReader",
         "-framework", "AppKit", "-framework", "WebKit"])
    (contents / "Info.plist").write_bytes(plistlib.dumps({
        "CFBundleExecutable": "WiseReader", "CFBundleIdentifier": profile["bundle_id"],
        "CFBundleName": profile["product_name"], "CFBundleDisplayName": profile["product_name"],
        "CFBundleIconFile": "EasySink.icns",
        "CFBundlePackageType": "APPL", "CFBundleShortVersionString": VERSION,
        "CFBundleVersion": BUILD, "LSMinimumSystemVersion": "13.0",
        "NSHighResolutionCapable": True, "NSPrincipalClass": "NSApplication",
        "EasySinkBuildFlavor": profile["flavor"],
        "EasySinkDataDirectoryName": profile["data_directory_name"],
        "EasySinkRootID": profile["root_id"],
        "EasySinkSourceRevision": revision,
        "EasySinkReleaseStatus": RELEASE_STATUS,
        "NSAppTransportSecurity": {"NSAllowsLocalNetworking": True},
    }, sort_keys=True))

    app = resource_root / "app"
    python_root = resource_root / "python"
    if args.refresh_app:
        _make_writable(resource_root)
        lock = output / "desktop-dependencies.lock"
        if not lock.exists() or sha(lock) != sha(dependency_lock):
            dependencies(uv, python_root / "bin/python3", output, dependency_lock)
    else:
        runtime, _ = runtime_source(uv, args.runtime)
        shutil.copytree(runtime / "lib", python_root / "lib",
            ignore=shutil.ignore_patterns("site-packages", "__pycache__", "*.pyc"), symlinks=True)
        (python_root / "bin").mkdir(parents=True)
        shutil.copy2(runtime / "bin/python3.12", python_root / "bin/python3.12")
        (python_root / "bin/python3").symlink_to("python3.12")
        (python_root / "bin/python").symlink_to("python3.12")
        shutil.copyfile(runtime / "BUILD", python_root / "BUILD")
        if (runtime / "share").exists():
            shutil.copytree(runtime / "share", python_root / "share", symlinks=True)
        dependencies(uv, python_root / "bin/python3", output, dependency_lock)

    copy(ICON, resource_root / "EasySink.icns")
    resources(app)
    (app / "desktop-build-flavor.json").write_text(json.dumps(profile, indent=2) + "\n")
    audit_native_runtime(python_root, output)
    # Native executable gets an ad-hoc local signature (no notarization or Gatekeeper claim).
    run(["codesign", "--force", "--sign", "-", macos / "WiseReader"])

    summary: dict[str, object] = {"flavor": args.flavor, "revision": revision}
    if args.archive:
        archive = output / (profile["product_name"] + ".zip")
        if archive.exists():
            archive.unlink()
        run(["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", bundle, archive])
        summary["archive"] = str(archive)
    summary["elapsed_seconds"] = round(time.monotonic() - started, 2)
    print(f"APP READY: {bundle}", flush=True)
    print(json.dumps(summary, indent=2), flush=True)


if __name__ == "__main__":
    main()
