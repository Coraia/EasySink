"""Static module-graph check for production web/ entry points and ES imports."""

from __future__ import annotations

import re
from pathlib import Path

from wise_reader.plugins.catalog import PLUGINS

WEB_ROOT = Path(__file__).resolve().parent.parent / "web"

_IMPORT_PATTERNS = (
    re.compile(r"""(?:import|export)\s+(?:[^'"{};]*?\bfrom\s*)?['"](\.[^'"]+)['"]""", re.DOTALL),
    re.compile(r"""\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)"""),
    re.compile(r"""\bnew\s+URL\s*\(\s*['"](\.[^'"]+)['"]\s*,\s*import\.meta\.url\s*,?\s*\)"""),
)


def _strip_js_comments(source: str) -> str:
    """Remove // and /* */ comments while preserving JS string literals."""
    out: list[str] = []
    i, n = 0, len(source)
    quote: str | None = None
    while i < n:
        ch = source[i]
        nxt = source[i + 1] if i + 1 < n else ""
        if quote is not None:
            out.append(ch)
            if ch == "\\" and i + 1 < n:
                out.append(nxt)
                i += 2
                continue
            if ch == quote:
                quote = None
            i += 1
        elif ch in ("'", '"', "`"):
            quote = ch
            out.append(ch)
            i += 1
        elif ch == "/" and nxt == "/":
            i += 2
            while i < n and source[i] != "\n":
                i += 1
        elif ch == "/" and nxt == "*":
            i += 2
            while i + 1 < n and not (source[i] == "*" and source[i + 1] == "/"):
                i += 1
            i += 2
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def _index_entrypoints() -> list[Path]:
    """Extract /static/... module scripts and preloads declared in web/index.html."""
    html = (WEB_ROOT / "index.html").read_text(encoding="utf-8")
    specs = re.findall(r"""<(?:script|link)\b[^>]+(?:src|href)=['"](/static/[^'"]+\.js(?:\?[^'"]*)?)['"]""", html)
    return [(WEB_ROOT / s.removeprefix("/static/").split("?", 1)[0].split("#", 1)[0]).resolve() for s in specs]


def _relative_refs(js_file: Path) -> list[tuple[str, Path]]:
    text = _strip_js_comments(js_file.read_text(encoding="utf-8"))
    refs: list[tuple[str, Path]] = []
    for pattern in _IMPORT_PATTERNS:
        for match in pattern.finditer(text):
            raw = match.group(1)
            clean = raw.split("?", 1)[0].split("#", 1)[0]
            refs.append((raw, (js_file.parent / clean).resolve()))
    return refs


def test_production_web_relative_imports_and_pdfjs_resolve():
    """All production entry points and plugins must resolve without touching dead prototypes."""
    queue = [*_index_entrypoints(), *[(WEB_ROOT / "plugins" / f"{p.id}.js").resolve() for p in PLUGINS]]
    visited: set[Path] = set()
    missing: list[str] = []
    prototype_leaks: list[str] = []
    pdfjs_dir: Path | None = None

    while queue:
        current = queue.pop(0)
        if current in visited:
            continue
        assert current.is_file(), f"Missing production JS entrypoint: {current}"
        visited.add(current)

        for raw, target in _relative_refs(current):
            rel_src = current.relative_to(WEB_ROOT)
            if not target.exists():
                missing.append(f"{rel_src} -> {raw} ({target})")
                continue
            try:
                rel_target = target.relative_to(WEB_ROOT)
            except ValueError:
                missing.append(f"{rel_src} escapes web/: {target}")
                continue

            if rel_target.parts and rel_target.parts[0] == "prototypes":
                prototype_leaks.append(f"{rel_src} -> {rel_target}")

            if rel_src.as_posix() == "plugins/pdf.js" and "pdfjs-" in rel_target.as_posix():
                pdfjs_dir = target
                continue

            if target.is_file() and target.suffix == ".js" and target not in visited:
                queue.append(target)

    assert not missing, f"Broken production JS references: {missing}"
    assert not prototype_leaks, f"Production modules import from web/prototypes/: {prototype_leaks}"
    assert pdfjs_dir is not None and pdfjs_dir.is_dir(), "Missing PDFJS directory reference in web/plugins/pdf.js"
    assert pdfjs_dir.relative_to(WEB_ROOT).parts[:2] == ("vendor", "pdfjs-6.4.299")
    assert (pdfjs_dir / "build" / "pdf.mjs").is_file()
    assert (pdfjs_dir / "build" / "pdf.worker.mjs").is_file()
