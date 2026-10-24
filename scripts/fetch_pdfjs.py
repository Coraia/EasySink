#!/usr/bin/env python3
"""Fetch the pinned official PDF.js display layer without installing packages."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import tempfile
import urllib.request
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / "web/prototypes/pdf-lab/vendor/pdfjs-6.4.299"
MANIFEST = VENDOR / "SOURCE.json"


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            value.update(chunk)
    return value.hexdigest()


def verified(path: Path, expected: dict) -> bool:
    return (path.is_file() and not path.is_symlink() and
            path.stat().st_size == expected["bytes"] and
            digest(path) == expected["sha256"])


def install_member(archive: zipfile.ZipFile, relative: str, expected: dict) -> str:
    destination = VENDOR / relative
    if destination.exists():
        if verified(destination, expected):
            return "already-present"
        raise RuntimeError(f"Refusing to overwrite mismatched PDF.js resource: {destination}")
    info = archive.getinfo(relative)
    if info.is_dir() or (info.external_attr >> 16) & 0o170000 == 0o120000:
        raise RuntimeError(f"PDF.js archive member is not a regular file: {relative}")
    data = archive.read(info)
    if len(data) != expected["bytes"] or hashlib.sha256(data).hexdigest() != expected["sha256"]:
        raise RuntimeError(f"PDF.js archive member failed verification: {relative}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    except BaseException:
        destination.unlink(missing_ok=True)
        raise
    return "installed"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path,
                        help="Use an existing official archive instead of downloading it")
    args = parser.parse_args()
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    archive_spec = manifest["archive"]

    with tempfile.TemporaryDirectory(prefix="easysink-pdfjs-") as temporary:
        archive_path = args.archive.resolve() if args.archive else Path(temporary) / archive_spec["name"]
        if not args.archive:
            request = urllib.request.Request(archive_spec["url"], headers={
                "User-Agent": "EasySink-PDFJS-resource-fetch/1",
            })
            with urllib.request.urlopen(request, timeout=60) as response, archive_path.open("wb") as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
        if (not archive_path.is_file() or archive_path.stat().st_size != archive_spec["bytes"] or
                digest(archive_path) != archive_spec["sha256"]):
            raise RuntimeError("Official PDF.js archive failed pinned size/SHA-256 verification")

        results = {}
        with zipfile.ZipFile(archive_path) as archive:
            for relative, expected in manifest["files"].items():
                results[relative] = install_member(archive, relative, expected)

    license_spec = manifest["license"]
    if not verified(VENDOR / license_spec["path"], license_spec):
        raise RuntimeError("Tracked PDF.js license does not match the pinned official archive")
    print(json.dumps({
        "version": manifest["version"],
        "source": archive_spec["url"],
        "archive_sha256": archive_spec["sha256"],
        "resources": results,
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
