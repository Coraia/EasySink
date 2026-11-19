#!/usr/bin/env python3
"""Run the fast core regression safety net across backend, JS units, and core E2E."""

from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

CORE_E2E_SPECS = [
    "tests/browser/word-popover.spec.js",
    "tests/browser/collections-word.spec.js",
    "tests/browser/importer.spec.js",
    "tests/browser/reader.spec.js",
    "tests/browser/immersive-v3.spec.js",
    "tests/browser/feedback.spec.js",
    "tests/browser/reader-trackpad.spec.js",
]


def _run_stage(name: str, command: list[str]) -> float:
    """Run one regression stage, exit on failure, and return elapsed seconds."""
    print(f"\n=== [{name}] {' '.join(command)} ===", flush=True)
    started = time.monotonic()
    result = subprocess.run(command, cwd=ROOT)
    elapsed = time.monotonic() - started
    if result.returncode != 0:
        print(f"\n[{name}] FAILED in {elapsed:.1f}s (exit {result.returncode})", file=sys.stderr)
        sys.exit(result.returncode)
    return elapsed


def main() -> None:
    """Parse mode flags, run selected regression stages, and print timing summary."""
    parser = argparse.ArgumentParser(description="Run EasySink core regression checks.")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--backend-only", action="store_true", help="Run pytest and Node unit checks only.")
    mode.add_argument("--e2e-only", action="store_true", help="Run curated core Playwright specs only.")
    args = parser.parse_args()

    stages: list[tuple[str, list[str]]] = []
    if not args.e2e_only:
        stages.append(
            ("pytest", [str(ROOT / ".venv/bin/pytest"), "--ignore=tests/browser", "--ignore=tests/measurement", "-q"])
        )
        stages.append(("node-unit", ["node", "--test", "tests/page-curl-cache.test.js"]))
    if not args.backend_only:
        stages.append(("e2e-core", ["npx", "--no-install", "playwright", "test", *CORE_E2E_SPECS]))

    timings: list[tuple[str, float]] = []
    total_start = time.monotonic()
    for name, command in stages:
        timings.append((name, _run_stage(name, command)))
    total = time.monotonic() - total_start

    print("\n=== Regression Summary ===")
    for name, elapsed in timings:
        print(f"  {name:<10s} {elapsed:6.1f}s  PASS")
    print(f"Total: {total:.1f}s")


if __name__ == "__main__":
    main()
