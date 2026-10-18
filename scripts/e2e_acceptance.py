#!/usr/bin/env python3
"""Run the final whole-product E2E once and retain a reproducible evidence bundle."""

import hashlib
import json
import os
import platform
import subprocess
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def run_text(*args):
    result = subprocess.run(args, cwd=ROOT, capture_output=True, text=True)
    return result.stdout.strip()


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for part in iter(lambda: f.read(1024 * 1024), b""):
            h.update(part)
    return h.hexdigest()


if __name__ == "__main__":
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    destination = ROOT / ".runtime" / "acceptance" / stamp
    destination.mkdir(parents=True, exist_ok=False)
    files = run_text(
        "git", "ls-files", "--cached", "--others", "--exclude-standard"
    ).splitlines()
    sources = [
        p
        for p in files
        if p.startswith(("src/", "web/", "tests/browser/", "scripts/"))
        or p
        in (
            "pyproject.toml",
            "uv.lock",
            "package.json",
            "package-lock.json",
            "playwright.config.js",
        )
    ]
    source_hashes = {p: digest(ROOT / p) for p in sources if (ROOT / p).is_file()}
    with zipfile.ZipFile(
        destination / "source.zip", "w", zipfile.ZIP_DEFLATED
    ) as archive:
        for p in source_hashes:
            archive.write(ROOT / p, p)
    (destination / "source.sha256.json").write_text(json.dumps(source_hashes, indent=2))
    (destination / "changes.diff").write_text(run_text("git", "diff"))
    versions = {
        name: run_text(*args)
        for name, args in {
            "python": (str(ROOT / ".venv/bin/python"), "--version"),
            "node": ("node", "--version"),
            "playwright": ("npx", "--no-install", "playwright", "--version"),
        }.items()
    }
    env = {**os.environ, "WR_E2E_EVIDENCE": str(destination)}
    command = ["npm", "run", "test:e2e"]
    print("Evidence: " + str(destination), flush=True)
    with (destination / "run.log").open("w") as log:
        process = subprocess.Popen(
            command,
            cwd=ROOT,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        for line in process.stdout:
            print(line, end="", flush=True)
            log.write(line)
            log.flush()
        code = process.wait()
    changed = [
        p
        for p, h in source_hashes.items()
        if not (ROOT / p).exists() or digest(ROOT / p) != h
    ]
    lexicon = ROOT / "data/stardict.db"
    manifest = {
        "started_utc": stamp,
        "finished_utc": datetime.now(timezone.utc).isoformat(),
        "command": command,
        "working_directory": str(ROOT),
        "exit_code": code,
        "source_changed_during_run": changed,
        "baseline_commit": run_text("git", "rev-parse", "HEAD"),
        "platform": platform.platform(),
        "versions": versions,
        "lexicon_sha256": digest(lexicon) if lexicon.exists() else None,
        "database": "disposable temporary SQLite; real data/user.db not used",
        "app_port": int(os.environ.get("WR_E2E_PORT", "18767")),
        "fixture_port": int(os.environ.get("WR_E2E_PROVIDER_PORT", "18768")),
        "ai_scope": "real HTTP and browser chain with deterministic fixture translations/annotations and WAV tone; not real model quality",
    }
    if (destination / "results.json").exists():
        manifest["stats"] = json.loads((destination / "results.json").read_text())[
            "stats"
        ]
    package = os.environ.get("WR_E2E_EPUB_PACKAGE")
    package_command = ""
    if package:
        package_path = Path(package).resolve()
        manifest["epub_package"] = {
            "path": str(package_path),
            "sha256": digest(package_path),
            "scope": "local browser import of the supplied book; no external model calls",
        }
        package_command = (
            f'\nThis run also requires the same local book archive: '
            f'`WR_E2E_EPUB_PACKAGE="{package_path}" .venv/bin/python scripts/e2e_acceptance.py`. '
            'The archive hash is in manifest; original package file hashes are attached '
            'to its browser scenario. The actual book is not included in source.zip.\n'
        )
    (destination / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False)
    )
    (destination / "README.md").write_text(f"""# Wise Reader final E2E evidence

Command: `.venv/bin/python scripts/e2e_acceptance.py` from `{ROOT}`.
Exit code: {code}. Source changes during run: {changed}.

- `report/index.html`: browser report, screenshots and attachments.
- `results/`: scenario attachments and final screenshots; traces where enabled. Rendering and performance scenarios disable tracing to avoid measurement interference.
- `results.json`, `run.log`, `manifest.json`: test outcomes and environment.
- `source.zip`, `source.sha256.json`: exact tested source snapshot and hashes.

Reproduce in this checkout, with the same lexicon hash from manifest:
1. Run `uv sync --extra dev`, `npm ci`, `npx playwright install chromium`. The GPU scenarios also require installed Google Chrome on macOS (they explicitly use the Chrome channel and Metal).
2. Ensure the manifest's app/provider ports are free (defaults: 18767/18768), or set `WR_E2E_PORT` and `WR_E2E_PROVIDER_PORT`. Run the command above.
3. Read the newly generated manifest and HTML report. No production database is used.

For a trace: `npx playwright show-trace <path-to-trace.zip>`.
AI fixture uses only dummy credentials. Its WAV tone does not evaluate voice naturalness.
Real-provider credentials, sound quality and translation quality are not accepted by this run.
{package_command}
""")
    hashes = {
        str(p.relative_to(destination)): digest(p)
        for p in destination.rglob("*")
        if p.is_file()
    }
    (destination / "SHA256SUMS").write_text(
        "".join(f"{h}  {p}\n" for p, h in sorted(hashes.items()))
    )
    print("Finished: " + str(destination / "README.md"), flush=True)
    sys.exit(code or (1 if changed else 0))
