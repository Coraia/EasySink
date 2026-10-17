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
import os
import platform
import plistlib
import re
import shutil
import subprocess
import sys
import time
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PDF_PINS = {
    "pdfplumber": "0.11.10", "pdfminer-six": "20260107", "pypdfium2": "5.14.0",
    "pillow": "12.3.0", "charset-normalizer": "3.5.2", "cryptography": "50.0.2",
    "cffi": "2.1.1", "pycparser": "3.0", "psutil": "7.2.2",
}
DIRECT = ("fastapi", "uvicorn", "httpx", "pydantic", "pydantic-settings", "python-multipart", "markdown-it-py")
SCRIPTS = ("scripts/pdf_lab_convert.py", "scripts/formula_recognize.py",
           "scripts/setup_mineru_runtime.py", "scripts/desktop/backend.py",
           "scripts/desktop/runtime.py", "scripts/desktop/prepare_ocr.py")


def run(command, **kwargs):
    return subprocess.run([str(x) for x in command], check=True, **kwargs)


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def copy(source, destination):
    if source.is_symlink():
        raise ValueError(f"Source allowlist cannot contain symlinks: {source}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)


def source_files():
    """Include untracked production modules/UI, but never data or experiments."""
    for source in sorted((ROOT / "src").rglob("*.py")):
        if "__pycache__" not in source.parts:
            yield source
    for source in sorted((ROOT / "web").rglob("*")):
        relative = source.relative_to(ROOT / "web")
        if relative.parts[0] == "prototypes" and relative.parts[:3] != ("prototypes", "pdf-lab", "vendor"):
            continue
        if any(part.startswith(".") or part == "__pycache__" for part in relative.parts):
            continue
        if source.is_file():
            yield source
    yield from (ROOT / relative for relative in SCRIPTS)


def source_hashes():
    sources = [*source_files(), *(ROOT / "desktop").glob("*.swift"),
               Path(__file__), ROOT / "scripts/desktop/dependencies.lock", ROOT / "uv.lock"]
    return {str(p.relative_to(ROOT)): sha(p) for p in sorted(sources)}


def resources(app):
    # Rebuild just these generated trees. Never glob/copy the repository root.
    app.mkdir(parents=True, exist_ok=True)
    app.chmod(0o755)
    for name in ("src", "web", "scripts"):
        target = app / name
        if target.exists():
            target.chmod(0o755)
            for directory in target.rglob("*"):
                if directory.is_dir() and not directory.is_symlink():
                    directory.chmod(0o755)
            shutil.rmtree(target)
    for source in source_files():
        copy(source, app / source.relative_to(ROOT))
    for name in ("stardict.db", "lemma.en.txt"):
        source, target = ROOT / "data" / name, app / "data" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            if target.stat().st_size != source.stat().st_size or sha(target) != sha(source):
                raise RuntimeError("Bundled dictionary changed; use a new output directory.")
            continue
        # APFS clone-on-write: never hardlink mutable source files into a release.
        cloned = subprocess.run(["/bin/cp", "-c", str(source), str(target)], capture_output=True)
        if cloned.returncode:
            shutil.copyfile(source, target)
        target.chmod(0o444)


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


def inventory(bundle):
    entries = []
    for path in sorted(bundle.rglob("*")):
        relative = str(path.relative_to(bundle))
        if path.is_symlink():
            if not path.resolve().is_relative_to(bundle.resolve()):
                raise RuntimeError(f"Bundle symlink escapes application: {relative}")
            entries.append({"path": relative, "symlink": os.readlink(path)})
        elif path.is_file():
            entries.append({"path": relative, "bytes": path.stat().st_size, "sha256": sha(path)})
    return entries


def readonly_resources(root):
    # CPython can write encodings/sitecustomize bytecode before sitecustomize
    # executes. Deny resource writes at the filesystem boundary as well.
    for path in sorted(root.rglob("*"), reverse=True):
        if not path.is_symlink():
            path.chmod(0o555 if path.is_dir() or path.stat().st_mode & 0o111 else 0o444)
    root.chmod(0o555)


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
        changes, dependencies = [], []
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
                dependencies.append(name)
        if changes:
            path.chmod(0o755)
            directory_mode = path.parent.stat().st_mode & 0o777
            path.parent.chmod(0o755)
            try:
                run(["install_name_tool", *changes, path])
                run(["codesign", "--force", "--sign", "-", path])
            finally:
                path.parent.chmod(directory_mode)
        records.append({"path": str(path.relative_to(root)), "loads": dependencies, "adjustments": changes})
    (output / "desktop-native-dependencies.json").write_text(json.dumps(records, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", type=Path, help="Existing standalone CPython 3.12 root")
    parser.add_argument("--output", type=Path, default=ROOT / "dist")
    parser.add_argument("--dependency-lock", type=Path)
    parser.add_argument("--refresh-app", action="store_true")
    parser.add_argument("--archive", action="store_true", help="Also produce a compressed distributable ZIP")
    args = parser.parse_args()
    # The current canonical lock is authoritative even on a source-only refresh.
    # Otherwise newly added runtime dependencies would silently remain absent.
    args.dependency_lock = (args.dependency_lock or ROOT / "scripts/desktop/dependencies.lock").resolve()
    started = time.monotonic()
    if sys.platform != "darwin" or platform.machine() != "arm64":
        parser.error("This candidate build requires an Apple Silicon Mac.")
    uv = shutil.which("uv")
    if not uv:
        parser.error("uv is required only on the build machine")
    swift = sorted((ROOT / "desktop").glob("*.swift"))
    if not (ROOT / "desktop/App.swift").is_file():
        parser.error("Main must supply desktop/App.swift first")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    bundle = output / "Wise Reader.app"
    marker = output / "desktop-build-inputs.json"
    if bundle.exists() and not (args.refresh_app and marker.exists()):
        parser.error("Output exists; --refresh-app reuses this builder's runtime/dictionary, or choose --output DIR")
    frozen_sources = source_hashes()
    requested_lock_hash = sha(args.dependency_lock)
    contents = bundle / "Contents"
    macos = contents / "MacOS"
    macos.mkdir(parents=True, exist_ok=True)
    snapshot = output / "desktop-source"
    snapshot.mkdir(exist_ok=True)
    swift_inputs = []
    for source in swift:
        destination = snapshot / source.name
        shutil.copyfile(source, destination)
        if sha(destination) != frozen_sources[str(source.relative_to(ROOT))]:
            raise RuntimeError(f"Swift source changed during snapshot: {source.name}; freeze and rebuild.")
        swift_inputs.append(destination)
    run(["xcrun", "swiftc", "-parse-as-library", "-O", "-target", "arm64-apple-macos13.0",
         "-module-name", "WiseReader", *swift_inputs, "-o", macos / "WiseReader",
         "-framework", "AppKit", "-framework", "WebKit"])
    (contents / "Info.plist").write_bytes(plistlib.dumps({
        "CFBundleExecutable": "WiseReader", "CFBundleIdentifier": "com.coraia.wisereader.candidate",
        "CFBundleName": "Wise Reader", "CFBundleDisplayName": "Wise Reader",
        "CFBundlePackageType": "APPL", "CFBundleShortVersionString": "1.2.0",
        "CFBundleVersion": "12", "LSMinimumSystemVersion": "13.0",
        "NSHighResolutionCapable": True, "NSPrincipalClass": "NSApplication",
        "NSAppTransportSecurity": {"NSAllowsLocalNetworking": True},
    }, sort_keys=True))
    app = contents / "Resources/app"
    python_root = contents / "Resources/python"
    if args.refresh_app:
        original = json.loads(marker.read_text())
        info, runtime = original["runtime"], Path(original["runtime_source"])
        lock = output / "desktop-dependencies.lock"
        if not lock.exists() or sha(lock) != requested_lock_hash:
            # A source refresh can introduce parser/runtime dependencies too.
            # Only this generated runtime becomes writable; seal it again below.
            for path in [python_root, *python_root.rglob("*")]:
                if not path.is_symlink():
                    path.chmod(path.stat().st_mode | 0o200)
            lock = dependencies(uv, python_root / "bin/python3", output, args.dependency_lock)
    else:
        runtime, info = runtime_source(uv, args.runtime)
        shutil.copytree(runtime / "lib", python_root / "lib",
            ignore=shutil.ignore_patterns("site-packages", "__pycache__", "*.pyc"), symlinks=True)
        (python_root / "bin").mkdir(parents=True)
        shutil.copy2(runtime / "bin/python3.12", python_root / "bin/python3.12")
        (python_root / "bin/python3").symlink_to("python3.12")
        (python_root / "bin/python").symlink_to("python3.12")
        shutil.copyfile(runtime / "BUILD", python_root / "BUILD")
        if (runtime / "share").exists():
            shutil.copytree(runtime / "share", python_root / "share", symlinks=True)
        lock = dependencies(uv, python_root / "bin/python3", output, args.dependency_lock)
    resources(app)
    for relative, digest in frozen_sources.items():
        packaged = app / relative
        if relative.startswith(("src/", "web/", "scripts/")) and relative not in {
                "scripts/desktop/build.py", "scripts/desktop/dependencies.lock"}:
            if not packaged.is_file() or sha(packaged) != digest:
                raise RuntimeError(f"Packaged source changed during build: {relative}; freeze and rebuild.")
    audit_native_runtime(python_root, output)
    readonly_resources(contents / "Resources")
    inputs = {"runtime": info, "runtime_source": str(runtime), "runtime_build": (python_root / "BUILD").read_text().strip(),
              "dependency_lock_sha256": sha(lock), "swift_sources": {"desktop/" + p.name: sha(p) for p in swift_inputs},
              "builder_sha256": sha(Path(__file__)), "uv_lock_sha256": sha(ROOT / "uv.lock"),
              "source_sha256": frozen_sources}
    marker.write_text(json.dumps(inputs, indent=2) + "\n")
    # Native executable gets an ad-hoc local signature. Full app is an unsigned
    # development candidate: no notarization, hardened runtime, or Gatekeeper claim.
    run(["codesign", "--force", "--sign", "-", macos / "WiseReader"])
    files = inventory(bundle)
    costs = {"unpacked_bytes": sum(f.get("bytes", 0) for f in files),
             "dictionary_bytes": sum(f.get("bytes", 0) for f in files if "/app/data/" in f["path"]),
             "python_and_dependencies_bytes": sum(f.get("bytes", 0) for f in files if "/python/" in f["path"]),
             "optional_ocr_bundled_bytes": 0, "optional_ocr_download_bytes": None,
             "ocr_accuracy_passed": False, "build_elapsed_seconds": time.monotonic() - started}
    if args.archive:
        archive = output / "Wise Reader.zip"
        if archive.exists():
            archive.unlink()
        run(["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", bundle, archive])
        costs.update(archive_bytes=archive.stat().st_size, archive_sha256=sha(archive))
    costs["total_build_elapsed_seconds"] = time.monotonic() - started
    if source_hashes() != frozen_sources or sha(args.dependency_lock) != requested_lock_hash:
        raise RuntimeError("Source/dependency inputs changed during build. This is not a frozen candidate; rebuild.")
    manifest = output / "desktop-manifest.json"
    manifest.write_text(json.dumps({"schema_version": 1, "candidate": True, "notarized": False,
        "inputs": inputs, "costs": costs, "files": files}, indent=2) + "\n")
    (output / "desktop-manifest.sha256").write_text(sha(manifest) + "  desktop-manifest.json\n")
    print(f"APP READY: {bundle}", flush=True)
    print(json.dumps({"manifest": str(manifest), "costs": costs}, indent=2), flush=True)


if __name__ == "__main__":
    main()
