#!/usr/bin/env python3
"""Connect an already prepared local MinerU runtime without copying or downloading it.

Run with bundled Python -I. Keep the original manifest location so conversion
and formula recognition in every client continue to share its inference lock.
This registration does not make a Homebrew/checkout installation portable.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import tempfile

APP = Path(__file__).resolve().parents[2]


def configured_manifest(data: Path) -> Path:
    pointer = data / "desktop-mineru.json"
    default = data / "ocr/mineru/runtime.json"
    if not pointer.exists() and not pointer.is_symlink():
        return default
    try:
        if pointer.stat().st_size > 16 * 1024:
            raise ValueError("Oversized runtime registration")
        value = json.loads(pointer.read_text())
        path = Path(value["manifest"])
        if value["schema_version"] != 1 or not path.is_absolute():
            raise ValueError("Invalid runtime registration")
        return path
    except (OSError, ValueError, KeyError, TypeError):
        # A broken explicit registration must not silently choose another engine.
        return data / "ocr/invalid-registration/runtime.json"


def inspect(manifest: Path) -> dict:
    sys.path.insert(0, str(APP / "src"))
    from wise_reader.pdf_lab.adapters.mineru_runtime import discover_mineru_runtime
    previous = os.environ.get("WISE_READER_MINERU_MANIFEST")
    os.environ["WISE_READER_MINERU_MANIFEST"] = str(manifest)
    try:
        runtime = discover_mineru_runtime()  # Stats/identity only, no model imports.
        metadata = json.loads(runtime.manifest.read_text())
        return {"available": True, "version": metadata["version"],
                "identity": runtime.identity, "manifest": str(runtime.manifest),
                "python": str(runtime.python.resolve()),
                "models_bytes": sum(row["bytes"] for row in metadata["files"] if row["root"] == "models"),
                "downloads": 0, "model_calls": 0,
                "portable_installation_verified": False}
    finally:
        if previous is None:
            os.environ.pop("WISE_READER_MINERU_MANIFEST", None)
        else:
            os.environ["WISE_READER_MINERU_MANIFEST"] = previous


def register(data: Path, manifest: Path) -> dict:
    if data == APP or APP in data.parents:
        raise ValueError("Runtime registration must be outside application resources.")
    report = inspect(manifest)
    data.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".desktop-mineru-", dir=data)
    try:
        with os.fdopen(descriptor, "w") as stream:
            json.dump({"schema_version": 1, "manifest": str(manifest),
                       "identity_at_registration": report["identity"]}, stream)
            stream.write("\n"); stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, data / "desktop-mineru.json")
    finally:
        Path(temporary).unlink(missing_ok=True)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", required=True, type=Path)
    parser.add_argument("--register", type=Path, help="Existing prepared runtime.json")
    args = parser.parse_args()
    data = args.data_dir.expanduser().resolve()
    if data == APP or APP in data.parents:
        parser.error("Runtime registration must be outside application resources.")
    try:
        result = (register(data, args.register.expanduser().resolve()) if args.register
                  else inspect(configured_manifest(data)))
    except (OSError, ValueError, RuntimeError, KeyError, TypeError) as error:
        print(json.dumps({"available": False, "error": str(error), "model_calls": 0}))
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
