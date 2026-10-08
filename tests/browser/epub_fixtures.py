"""Generate synthetic EPUB wrappers for browser E2E, never import user content."""

import io
import sys
import zipfile
from pathlib import Path


def wrapped(prefixes):
    out = io.BytesIO()
    sample = Path(__file__).resolve().parents[2] / "web/sample.epub"
    with zipfile.ZipFile(sample) as source, zipfile.ZipFile(
        out, "w", zipfile.ZIP_DEFLATED
    ) as target:
        for prefix in prefixes:
            for item in source.infolist():
                target.writestr(prefix + item.filename, source.read(item.filename))
        target.writestr("__MACOSX/._sample.epub", "Mac metadata, not a chapter")
    return out.getvalue()


def nested_semantic():
    html = '''<html><head><script>hidden script</script></head><body><h1>Semantic fixture</h1>
<blockquote><p>Quoted author statement.</p><p>Second quoted paragraph.</p></blockquote>
<ul><li><p>Nested list entry.</p><ul><li>Child entry.</li></ul><p>Parent continuation.</p></li></ul>
<table><tr><td><p>Column A value.</p></td><td><p>Column B value.</p></td></tr>
<tr><td>Empty neighbour</td><td></td></tr></table>
<pre><code>if ready:\n    proceed()</code></pre></body></html>'''
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("mimetype", "application/epub+zip")
        z.writestr("META-INF/container.xml", '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>')
        z.writestr("book.opf", '<package><metadata><title>Semantic fixture</title></metadata><manifest><item id="c" href="c.xhtml"/></manifest><spine><itemref idref="c"/></spine></package>')
        z.writestr("c.xhtml", html)
    return out.getvalue()


if __name__ == "__main__":
    if sys.argv[1] == "nested-semantic":
        sys.stdout.buffer.write(nested_semantic())
        sys.exit(0)
    modes = {
        "single": ["sample.epub/"],
        "nested": ["Export/Reading/sample.epub/"],
        "ambiguous": ["first.epub/", "second.epub/"],
        "unsafe": ["../sample.epub/"],
    }
    sys.stdout.buffer.write(wrapped(modes[sys.argv[1]]))
