"""Synthetic 1.4M-character EPUB; reproducible, no user book text."""
import io
import sys
import zipfile
out = io.BytesIO()
paragraph = "Relationships help us understand how knowledge develops through careful attention. " * 6
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('mimetype', 'application/epub+zip')
    z.writestr('META-INF/container.xml', '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>')
    items = ''.join(f'<item id="c{i}" href="c{i}.xhtml"/>' for i in range(4))
    spine = ''.join(f'<itemref idref="c{i}"/>' for i in range(4))
    z.writestr('book.opf', f'<package><metadata><title>Performance synthetic book</title></metadata><manifest>{items}</manifest><spine>{spine}</spine></package>')
    for i in range(4):
        parts = ''.join(f'<p>Section {n}. {paragraph}</p>' for n in range(720))
        z.writestr(f'c{i}.xhtml', f'<html><body><h1>Performance chapter {i+1}</h1>{parts}<p>Destination marker {i+1} at the end.</p></body></html>')
sys.stdout.buffer.write(out.getvalue())
