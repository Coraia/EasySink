CASES = {
    "running": ("跑眉、页脚与页码", 3, 1),
    "footnote": ("脚注式页脚", 3, 1),
    "number-only": ("只有页码（对照）", 3, 1),
    "range-edge": ("第 8 → 9 页接缝", 9, 8),
    "line-break": ("同页无连字符断词", 1, 1),
}

BEFORE = (
    "The patient researchers examined the entire collection of samples",
    "and wrote careful notes before sending the remaining material",
)
AFTER = "to the laboratory for a second round of testing. The report arrived the following week."


def rows_for(case, page, count):
    if case == "line-break":
        rows = []
        for i, (left, right) in enumerate((
            ("Before the next trial the researchers carefully p", "repared the instruments."),
            ("For the next trial the researchers noted where the locatio", "n was marked on the map."),
            ("Before the next trial the researchers checked that diffe", "rent samples were collected."),
            ("Before the next trial the researchers said all the record", "s were reviewed."),
            ("The research team stored the small instruments in", "side pockets, not in the main compartment."),
        )):
            y = 650 - i * 70
            rows += [(72, y, 11, left), (72, y - 15, 11, right)]
        rows += [(72, 290, 11, "p"), (80.35, 290, 11, "repared for a tight-gap control."),
                 (72, 240, 11, "in"), (94, 240, 11, "side pockets with a real gap.")]
        return rows
    rows = []
    if case in {"running", "footnote"}:
        rows.append((72, 760, 9, "FIELD STUDY ARCHIVE"))
    if page > 1:
        rows.append((72, 727, 11, AFTER))
    if page < count:
        rows.extend([(72, 132, 11, BEFORE[0]), (72, 117, 11, BEFORE[1])])
    if case == "running":
        rows.append((72, 54, 9, "RESEARCH DIVISION COPY"))
    if case == "footnote" and page == 1:
        rows.append((72, 54, 9, "1. The original records are kept on site."))
    rows.append((302, 20, 9, str(page)))
    return rows


def make_pdf(path, case):
    _, count, _ = CASES[case]
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>", b"",
               b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    kids = []
    for page in range(1, count + 1):
        stream = "\n".join(f"BT /F1 {size} Tf 1 0 0 1 {x} {y} Tm ({s}) Tj ET"
                           for x, y, size, s in rows_for(case, page, count)).encode()
        index = len(objects) + 1
        kids.append(f"{index} 0 R")
        objects.extend([
            (f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
             f"/Resources << /Font << /F1 3 0 R >> >> /Contents {index + 1} 0 R >>").encode(),
            f"<< /Length {len(stream)} >>\nstream\n".encode() + stream + b"\nendstream",
        ])
    objects[1] = f'<< /Type /Pages /Count {count} /Kids [{" ".join(kids)}] >>'.encode()
    pdf, offsets = bytearray(b"%PDF-1.4\n"), []
    for i, obj in enumerate(objects, 1):
        offsets.append(len(pdf))
        pdf.extend(f"{i} 0 obj\n".encode() + obj + b"\nendobj\n")
    start = len(pdf)
    pdf.extend(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode())
    for offset in offsets:
        pdf.extend(f"{offset:010d} 00000 n \n".encode())
    pdf.extend(f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{start}\n%%EOF\n".encode())
    path.write_bytes(pdf)
