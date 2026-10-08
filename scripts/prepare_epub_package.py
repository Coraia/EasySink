"""Create a local browser-acceptance archive from an existing Mac EPUB package.

Failure cases: missing source, non-package directory, symlinks, input changes,
or overwriting existing evidence. This never changes the original package.
"""

import hashlib
import json
import sys
import zipfile
from pathlib import Path


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


if __name__ == "__main__":
    source = Path(sys.argv[1]).resolve()
    destination = Path(sys.argv[2]).resolve()
    if not source.is_dir() or not (source / "META-INF/container.xml").is_file():
        raise SystemExit("Source must be an unpacked EPUB package with its container")
    files = sorted(p for p in source.rglob("*") if p.is_file())
    if any(p.is_symlink() for p in source.rglob("*")):
        raise SystemExit("Package symlinks are not supported")
    before = {str(p.relative_to(source)): digest(p) for p in files}
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destination, "x", zipfile.ZIP_DEFLATED) as archive:
        for path in files:
            archive.write(path, source.name + "/" + str(path.relative_to(source)))
    if before != {str(p.relative_to(source)): digest(p) for p in files}:
        raise SystemExit("Source changed while preparing the archive")
    receipt = {
        "source": str(source),
        "archive": str(destination),
        "archive_sha256": digest(destination),
        "files": before,
        "source_unchanged": True,
    }
    destination.with_suffix(".receipt.json").write_text(
        json.dumps(receipt, ensure_ascii=False, indent=2)
    )
    print(json.dumps({"archive": str(destination), "files": len(files)}, ensure_ascii=False))
