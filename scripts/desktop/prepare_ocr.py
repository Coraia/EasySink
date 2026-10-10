#!/usr/bin/env python3
"""Prepare an optional local OCR installation using the app's standalone Python.

Explicit maintenance operation, never run at app launch. No download, package
resolver, shell activation, Xcode, Homebrew or model inference. Copy-on-write
copies preserve the source installation; actual installed bytes are reported.
Run with an existing application's standalone Python -I. Runtime preparation
can precede the final app freeze; use --no-register to leave active clients
unchanged. Source models/venv must be supplied. This is not a download service.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import struct
import sys
import time

APP = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from runtime import inspect, register


def clone(source, destination):
    result = subprocess.run(["/bin/cp", "-c", str(source), str(destination)],
                            capture_output=True, check=False)
    if result.returncode:
        shutil.copy2(source, destination)
    return destination


def copy_tree(source, destination):
    shutil.copytree(source, destination, symlinks=True, copy_function=clone,
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))


def prepare_supervisor(packages, python_root):
    """An older bootstrap app may predate the psutil supervisor dependency.

    Reuse the pinned supplied wheel content, never install or modify the source
    app. Current app bundles already have it and need no additional copy.
    """
    target = python_root / "lib/python3.12/site-packages"
    if (target / "psutil").is_dir():
        return
    metadata = packages / "psutil-7.2.2.dist-info"
    if not (packages / "psutil").is_dir() or not (metadata / "METADATA").is_file():
        raise RuntimeError("Supplied runtime must contain the pinned psutil 7.2.2 wheel.")
    if "\nVersion: 7.2.2\n" not in (metadata / "METADATA").read_text():
        raise RuntimeError("Supplied psutil package version differs from the desktop pin.")
    mode = target.stat().st_mode & 0o777
    target.chmod(mode | 0o200)
    try:
        copy_tree(packages / "psutil", target / "psutil")
        copy_tree(metadata, target / metadata.name)
    finally:
        target.chmod(mode)


def native_dependencies(path, *, repair_rpaths=False):
    """Read arm64 loads, optionally remove copied upstream build-only RPATHs.

    Keep segments/file offsets fixed by zero-padding the shortened command
    table. macOS codesign (an OS tool) renews the copied binary's ad-hoc signature.
    No original installation is changed, and no developer tool is needed.
    """
    with path.open("rb") as stream:
        magic = stream.read(4)
        offsets = [0]
        if magic in (b"\xca\xfe\xba\xbe", b"\xca\xfe\xba\xbf"):
            count = struct.unpack(">I", stream.read(4))[0]
            if count > 32:
                raise ValueError("Invalid universal binary")
            fmt = ">IIQQII" if magic[-1] == 0xbf else ">IIIII"
            records = [struct.unpack(fmt, stream.read(struct.calcsize(fmt))) for _ in range(count)]
            offsets = [row[2] for row in records if row[0] == 0x100000c]
        elif magic != b"\xcf\xfa\xed\xfe":
            return []
        loads = []
        changed = False
        for offset in offsets:
            stream.seek(offset)
            header = struct.unpack("<8I", stream.read(32))
            if header[0] != 0xfeedfacf or header[1] != 0x100000c:
                continue
            count, size = header[4], header[5]
            if count > 4096 or size > 4 * 1024**2:
                raise ValueError("Invalid Mach-O load table")
            commands = stream.read(size)
            position = 0
            kept = []
            for _ in range(count):
                kind, length = struct.unpack_from("<II", commands, position)
                if length < 8 or position + length > len(commands):
                    raise ValueError("Invalid Mach-O load command")
                remove = False
                if kind in (0xc, 0x80000018, 0x8000001f, 0x8000001c):
                    start = struct.unpack_from("<I", commands, position + 8)[0]
                    if not 12 <= start < length:
                        raise ValueError("Invalid Mach-O dependency name")
                    name = commands[position + start:position + length].split(b"\0", 1)[0].decode()
                    external = name.startswith("/") and not name.startswith(("/usr/lib/", "/System/Library/"))
                    remove = repair_rpaths and kind == 0x8000001c and external
                    if not remove:
                        loads.append(name)
                if not remove:
                    kept.append(commands[position:position + length])
                position += length
            if len(kept) != count:
                table = b"".join(kept)
                updated = list(header)
                updated[4], updated[5] = len(kept), len(table)
                mode = path.stat().st_mode & 0o777
                path.chmod(mode | 0o200)
                try:
                    with path.open("r+b") as writable:
                        writable.seek(offset)
                        writable.write(struct.pack("<8I", *updated))
                        writable.write(table + bytes(size - len(table)))
                finally:
                    path.chmod(mode)
                changed = True
        if changed:
            mode = path.stat().st_mode & 0o777
            directory_mode = path.parent.stat().st_mode & 0o777
            path.chmod(mode | 0o200)
            path.parent.chmod(directory_mode | 0o200)
            try:
                subprocess.run(["/usr/bin/codesign", "--force", "--sign", "-", str(path)],
                               check=True, capture_output=True)
            finally:
                path.chmod(mode)
                path.parent.chmod(directory_mode)
        return loads


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--venv", required=True, type=Path)
    parser.add_argument("--models", required=True, type=Path)
    parser.add_argument("--destination", required=True, type=Path, help="New external managed runtime directory")
    activation = parser.add_mutually_exclusive_group(required=True)
    activation.add_argument("--data-dir", type=Path, help="Desktop library to register after preparation")
    activation.add_argument("--no-register", action="store_true", help="Prepare only; preserve every existing library registration")
    args = parser.parse_args()
    source = Path(sys.base_prefix).resolve()
    destination = args.destination.expanduser().resolve()
    venv, models = args.venv.resolve(), args.models.resolve()
    if sys.version_info[:2] != (3, 12) or not (source / "BUILD").is_file():
        parser.error("Run with the application's bundled standalone Python 3.12, not a development Python.")
    development_evidence = ((APP / "scripts/desktop/build.py").is_file()
                            and destination.is_relative_to(APP / "outputs"))
    if destination.exists() or destination == APP or (APP in destination.parents and not development_evidence):
        parser.error("Choose a new managed directory outside the application; existing data is never replaced.")
    library = args.data_dir.expanduser().resolve() if args.data_dir else None
    if library is not None and (library == APP or APP in library.parents):
        parser.error("Desktop library must be outside application resources.")
    packages = venv / "lib/python3.12/site-packages"
    if not packages.is_dir() or models.name != "MinerU-4_models_onnx" or not models.is_dir():
        parser.error("Supply the prepared Python 3.12 packages and MinerU-4_models_onnx model directory.")
    if any(destination == root or root in destination.parents for root in (source, venv, models)):
        parser.error("Destination must be separate from its input installations.")
    began = time.monotonic()
    os.umask(0o077)
    destination.mkdir(parents=True)
    # Every copied Python symlink must remain inside this new managed root.
    # Do not reuse the source venv's Homebrew interpreter or old console scripts.
    python_root = destination / "python"
    copy_tree(source, python_root)
    prepare_supervisor(packages, python_root)
    python = python_root / "bin/python3"
    managed = destination / "venv"
    copy_tree(packages, managed / "lib/python3.12/site-packages")
    (managed / "bin").mkdir()
    (managed / "bin/python").symlink_to("../../python/bin/python3")
    (managed / "pyvenv.cfg").write_text(
        f"home = {python_root / 'bin'}\ninclude-system-site-packages = false\nversion = 3.12\n")
    target_models = destination / "models/MinerU-4_models_onnx"
    copy_tree(models, target_models)
    native = []
    for path in destination.rglob("*"):
        if path.is_symlink() and not path.resolve().is_relative_to(destination):
            raise RuntimeError(f"Prepared runtime has an external symlink: {path.relative_to(destination)}")
        if path.is_file() and not path.is_symlink():
            loads = native_dependencies(path, repair_rpaths=True)
            for name in loads:
                if name.startswith("/") and not name.startswith(("/usr/lib/", "/System/Library/")):
                    raise RuntimeError(f"Nonportable OCR library dependency: {path.relative_to(destination)} -> {name}")
            if loads:
                native.append({"path": str(path.relative_to(destination)), "loads": loads})
    (destination / "native-dependencies.json").write_text(json.dumps(native, indent=2) + "\n")
    # Registration validates package metadata and actual ORT/PDFium imports,
    # then fingerprints the complete installation; it does not load a model.
    environment = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(destination),
                   "LANG": "en_US.UTF-8", "PYTHONDONTWRITEBYTECODE": "1",
                   "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"}
    subprocess.run([str(python), "-I", "-B", str(APP / "scripts/setup_mineru_runtime.py"),
                    "--venv", str(managed), "--models", str(target_models),
                    "--destination", str(destination), "--register-only"],
                   env=environment, check=True)
    report = (register(library, destination / "runtime.json") if library is not None
              else inspect(destination / "runtime.json"))
    report.update(installed_bytes=sum(p.stat().st_size for p in destination.rglob("*")
                                     if p.is_file() and not p.is_symlink()),
                  preparation_seconds=round(time.monotonic() - began, 3),
                  python_base=str(python_root), source_preserved=True,
                  registered_library=str(library) if library is not None else None)
    (destination / "desktop-preparation.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
