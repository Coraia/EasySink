"""Small synthetic PDFs for the real digital import path."""

BEFORE = [
    "The patient researchers examined the entire collection of samples",
    "and wrote careful notes before sending the remaining material",
]
AFTER = "to the laboratory for a second round of testing. The report arrived the following week."


def pdf_fixture(case):
    pages = []
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
            rows.extend([(72, y, 11, left), (72, y - 15, 11, right)])
        pages.append(rows)
    else:
        count = 9 if case == "range-edge" else 3
        for n in range(1, count + 1):
            rows = [(72, 760, 9, "ODD ARCHIVE" if n % 2 else "EVEN ARCHIVE")]
            if n > 1:
                rows.append((72, 727, 11, AFTER))
            if n < count:
                rows.extend([(72, 132, 11, BEFORE[0]), (72, 117, 11, BEFORE[1])])
            rows += [(72, 54, 9, "1. The original records are kept on site." if n == 1 else "RESEARCH DIVISION COPY"),
                     (302, 20, 9, str(n))]
            pages.append(rows)

    objects = [b"<< /Type /Catalog /Pages 2 0 R >>", b"",
               b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    kids = []
    for rows in pages:
        stream = "\n".join(f"BT /F1 {size} Tf 1 0 0 1 {x} {y} Tm ({s}) Tj ET" for x, y, size, s in rows).encode()
        index = len(objects) + 1
        kids.append(f"{index} 0 R")
        objects.extend([
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents {index + 1} 0 R >>".encode(),
            f"<< /Length {len(stream)} >>\nstream\n".encode() + stream + b"\nendstream",
        ])
    objects[1] = f'<< /Type /Pages /Count {len(pages)} /Kids [{" ".join(kids)}] >>'.encode()
    result, offsets = bytearray(b"%PDF-1.4\n"), []
    for i, obj in enumerate(objects, 1):
        offsets.append(len(result))
        result.extend(f"{i} 0 obj\n".encode() + obj + b"\nendobj\n")
    start = len(result)
    result.extend(f"xref\n0 {len(offsets) + 1}\n0000000000 65535 f \n".encode())
    result.extend(b"".join(f"{offset:010d} 00000 n \n".encode() for offset in offsets))
    result.extend(f"trailer\n<< /Size {len(offsets) + 1} /Root 1 0 R >>\nstartxref\n{start}\n%%EOF\n".encode())
    return bytes(result)
