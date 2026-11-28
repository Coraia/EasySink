"""Review-only prose projection over retained, checked PDF page results."""

import re
from collections import Counter
from dataclasses import dataclass
from statistics import median
from unicodedata import normalize


def utf16(text):
    return len(text.encode("utf-16-le")) // 2


def bounding(boxes):
    return [min(b[0] for b in boxes), min(b[1] for b in boxes),
            max(b[2] for b in boxes), max(b[3] for b in boxes)]


def height(box):
    return box[3] - box[1]


@dataclass(frozen=True)
class Line:
    text: str
    start: int
    box: list
    glyphs: dict


@dataclass(frozen=True)
class Block:
    id: str
    page: int
    text: str
    kind: str
    box: list
    lines: tuple
    doc: int
    revision: str
    hint: str = ""


def lines_for(raw):
    text = raw["text"]
    lines = raw.get("raw_text", "").splitlines()
    if not lines or " ".join(lines) != text:
        return ()
    source = raw["source"]
    glyphs = source.get("glyphs", [])
    if not glyphs:
        return tuple(Line(line["text"], sum(len(t) + 1 for t in lines[:i]), line["bbox"], {})
                     for i, line in enumerate(source.get("lines", []))
                     if i < len(lines) and line["text"] == lines[i])
    chars = [(c, glyph["bbox"]) for glyph in glyphs for c in normalize("NFKC", glyph["text"])
             if not c.isspace()]
    if "".join(c for c, _ in chars) != "".join(c for c in normalize("NFKC", text) if not c.isspace()):
        return ()
    result, offset, cursor = [], 0, 0
    for line in lines:
        boxes = {}
        for i, c in enumerate(line):
            if c.isspace():
                continue
            count = len(normalize("NFKC", c))
            boxes[i] = bounding([box for _, box in chars[cursor:cursor + count]])
            cursor += count
        if not boxes:
            return ()
        result.append(Line(line, offset, bounding(list(boxes.values())), boxes))
        offset += len(line) + 1
    return tuple(result)


def source_blocks(page, doc, revision):
    number = page["page_number"]
    blocks = []
    for i, raw in enumerate(page["blocks"] + page.get("non_content_objects", [])):
        if not raw.get("text", "").strip():
            continue
        key = raw.get("id", f"p{number:06d}-margin-{i}")
        blocks.append(Block("pdf-" + key, number, raw["text"], raw["type"],
                            raw["source"]["bbox"], lines_for(raw), doc, revision, raw.get("role", "")))
    return sorted(blocks, key=lambda block: (block.box[1], block.box[0]))


def signature(text):
    return re.sub(r"\s+", " ", text.casefold().strip())


def classify(pages, blocks):
    margin = {}
    for number, objects in blocks.items():
        page = pages[number]
        prose = [b for b in objects if .11 * page["height"] < b.box[1] < .87 * page["height"]]
        size = median([height(line.box) for b in prose for line in b.lines]) if any(b.lines for b in prose) else 0
        for block in objects:
            x, top, _, bottom = block.box
            y = top / page["height"]
            role = "header" if bottom / page["height"] < .075 else "footer" if y > .89 else None
            if role and not any(
                max(other.box[1] - bottom, top - other.box[3]) < height(block.box) * .65
                for other in objects if other is not block
            ):
                margin[block.id] = (block, role, y, x / page["width"], size)
    result = {}
    for objects in blocks.values():
        for block in objects:
            evidence = "未确认是非正文，保留原文"
            role = "body"
            candidate = margin.get(block.id)
            if block.hint == "printed_page_label":
                role, evidence = "number", "适配器识别：独立的底边页码"
            elif candidate:
                _, edge, y, x, size = candidate
                peers = [(other, yy, xx) for other, side, yy, xx, _ in margin.values()
                         if side == edge and other.page != block.page and abs(yy-y) <= .025 and abs(xx-x) <= .045]
                repeats = {other.page for other, _, _ in peers if signature(other.text) == signature(block.text)}
                numbered = block.text.isdecimal() and any(other.text.isdecimal() and
                    int(other.text) - int(block.text) == other.page - block.page for other, _, _ in peers)
                if edge == "footer" and numbered:
                    role, evidence = "number", "底边位置一致，印刷页码连续"
                elif repeats:
                    role, evidence = edge, f"边距位置相近；相同文字在 {len(repeats) + 1} 个原页重复"
                elif block.hint in {"running_title", "running_furniture"}:
                    role, evidence = edge, "引擎标签与独立边距一致"
                elif edge == "footer" and size and height(block.box) < .92 * size and (
                    block.kind == "footnote" or re.match(r"^(?:\d+[.)]|\[\d+\])\s+\S", block.text)
                ):
                    role, evidence = "footnote", "底边独立小字、带注释编号、未重复；单独保留"
            result[block.id] = (role, evidence)
    return result


@dataclass(frozen=True)
class Source:
    block: Block
    start: int
    end: int
    line: int
    box: list


@dataclass(frozen=True)
class Unit:
    text: str
    mapping: tuple
    notes: tuple = ()

    def join(self, other, separator=" ", trim=0, reason=""):
        end = len(self.text) - trim
        return Unit(self.text[:end] + separator + other.text,
                    self.mapping[:end] + (None,) * len(separator) + other.mapping,
                    self.notes + ((reason,) if reason else ()) + other.notes)

    def ranges(self, start=0, stop=None):
        segments = []
        last = None
        for item in self.mapping[start:stop]:
            if item is None:
                continue
            block = item.block
            if last and last.block.id == block.id and last.line == item.line and last.end == item.start:
                segment = segments[-1]
                segment["end"] = item.end
                segment["box"] = bounding([segment["box"], item.box])
            else:
                segments.append(dict(doc_id=block.doc, revision=block.revision, block_id=block.id,
                                     start=item.start, end=item.end, box=item.box, page=block.page))
            last = item
        return segments

    def repaired_words(self):
        for word in re.finditer(r"[A-Za-z]+", self.text):
            parts = self.ranges(*word.span())
            if len(parts) > 1:
                yield {"text": word[0], "ranges": parts}


def word_known(word, lookup):
    if len(word) <= 1:
        return word in {"a", "i"}
    return lookup(word) or (word.endswith("s") and len(word) > 3 and lookup(word[:-1]))


def lexical_join(left, right, lookup, witnesses, hyphen=False):
    a = re.search(r"(?<![A-Za-z'-])([a-zA-Z]+)" + ("-" if hyphen else "") + r"$", left)
    b = re.match(r"^([a-z]+)(?![A-Za-z'-])", right)
    if not a or not b or a[1].isupper() and len(a[1]) > 1:
        return False
    first, last = a[1].lower(), b[1]
    whole = first + last
    return (len(whole) >= 4 and (whole in witnesses or word_known(whole, lookup))
            and not (word_known(first, lookup) and word_known(last, lookup))
            and not (hyphen and lookup(first + "-" + last)))


def line_continues(left, right, left_edge, right_edge):
    h = height(left.box)
    return (.8 <= h / height(right.box) <= 1.25 and
            -.1 * h <= right.box[1] - left.box[3] <= .85 * h and
            abs(right.box[0] - left_edge) <= .6 * h and
            0 <= right_edge - left.box[2] <= 2.6 * h)


def project_block(block, lookup, witnesses, right_edge):
    if not block.lines or " ".join(line.text for line in block.lines) != block.text:
        lines = (Line(block.text, 0, block.box, {}),)
    else:
        lines = block.lines
    offsets = [0]
    for char in block.text:
        offsets.append(offsets[-1] + utf16(char))
    unit = Unit("", ())
    previous = None
    for index, line in enumerate(lines):
        removed = set()
        reasons = []
        text = line.text
        h = height(line.box)
        for match in re.finditer(r"(?<=[A-Za-z]) (?=[a-z])", text):
            pos = match.start()
            a, b = line.glyphs.get(pos-1), line.glyphs.get(pos+1)
            if (a and b and 0 <= b[0] - a[2] <= .23 * h and
                lexical_join(text[:pos], text[pos+1:], lookup, witnesses)):
                removed.add(pos)
                reasons.append("字形间距小于常见词间距，且拼接词有词法证据")
        fragment = Unit("".join(c for i, c in enumerate(text) if i not in removed),
                        tuple(Source(block, offsets[line.start+i], offsets[line.start+i+1],
                                     index, line.glyphs.get(i, line.box))
                              for i in range(len(text)) if i not in removed), tuple(reasons))
        if previous is None:
            unit = fragment
        else:
            hyphen = unit.text.endswith("-")
            if (previous.glyphs and line.glyphs and
                line_continues(previous, line, min(l.box[0] for l in lines), right_edge) and
                lexical_join(previous.text, text, lookup, witnesses, hyphen)):
                unit = unit.join(fragment, "", int(hyphen), "同栏行末与下一行首的片段拼成完整词")
            else:
                boundary = previous.start + len(previous.text)
                space = Source(block, offsets[boundary], offsets[boundary+1], index, line.box)
                unit = Unit(unit.text + " " + fragment.text, unit.mapping + (space,) + fragment.mapping,
                            unit.notes + fragment.notes)
        previous = line
    return unit


class Projection:
    def __init__(self, pages, documents, lookup):
        self.pages = pages
        self.blocks = {n: source_blocks(page, *documents[n]) for n, page in pages.items()}
        self.roles = classify(pages, self.blocks)
        self.by_id = {b.id: b for objects in self.blocks.values() for b in objects}
        self.overrides = {}
        self.units = {}
        self.seams = {}
        self.changed = []
        self.hidden = None
        self.lookup = lookup
        for number in pages:
            self.refresh_page(number)
        for number in pages:
            self.refresh_seam(number)

    def role(self, block):
        role, evidence = self.roles[block.id]
        if block.id in self.overrides:
            return self.overrides[block.id], "手动覆盖；自动依据：" + evidence
        return role, evidence

    def refresh_page(self, number):
        blocks = [b for b in self.blocks[number] if self.role(b)[0] == "body"]
        witnesses = Counter(re.findall(r"(?<![A-Za-z'-])[A-Za-z]+(?![A-Za-z'-])",
                                       " ".join(b.text.lower() for b in blocks)))
        self.units[number] = [
            (b, project_block(b, self.lookup, witnesses,
                              max((l.box[2] for l in b.lines), default=b.box[2])))
            for b in blocks
        ]

    def refresh_seam(self, number):
        self.seams[number] = None
        left, right = self.units.get(number, []), self.units.get(number + 1, [])
        if not left or not right or self.hidden in {number, number + 1}:
            return
        a, u = left[-1]
        b, v = right[0]
        p, q = self.pages[number], self.pages[number + 1]
        if (p["checkpoint"]["source_sha256"] != q["checkpoint"]["source_sha256"] or
            p["rotation"] != q["rotation"] or p.get("crop_box") != q.get("crop_box") or
            a.kind != "paragraph" or b.kind != "paragraph" or not a.lines or not b.lines or
            not self.open_end(a, u) or b.box[1] > .2 * q["height"] or
            not re.match(r"[a-z]", v.text) or
            abs(a.lines[-1].box[0] / p["width"] - b.lines[0].box[0] / q["width"]) > .025 or
            not .8 <= height(a.lines[-1].box) / height(b.lines[0].box) <= 1.25):
            return
        hyphen = u.text.endswith("-")
        word = lexical_join(u.text, v.text, self.lookup, (), hyphen)
        if hyphen and not word:
            return
        self.seams[number] = (a.id, b.id, "" if word else " ", int(hyphen),
                              "跨原页断词" if word else "同栏跨原页续接")

    def open_end(self, block, unit):
        return (block.kind == "paragraph" and len(unit.text.split()) >= 10 and
                block.box[3] >= .76 * self.pages[block.page]["height"] and
                re.search(r"[a-z,-]$", unit.text))

    def override(self, key, action):
        number = self.by_id[key].page
        if action == "reset":
            self.overrides.pop(key, None)
        elif action == "body":
            self.overrides[key] = "body"
        else:
            original = self.roles[key][0]
            self.overrides[key] = "excluded" if original == "body" else original
        self.refresh_page(number)
        self.refresh_adjacent(number)

    def refresh_adjacent(self, number):
        self.changed = [n for n in (number - 1, number) if n in self.pages and n + 1 in self.pages]
        for n in self.changed:
            self.refresh_seam(n)

    def pending(self, number):
        if self.hidden == number:
            self.hidden = None
        else:
            self.hidden = number
        self.refresh_adjacent(number)

    def waiting_unit(self):
        previous = self.units.get(self.hidden - 1, []) if self.hidden else []
        if previous and self.open_end(*previous[-1]):
            return previous[-1][1]
        return None

    def paragraphs(self):
        links = {seam[1]: seam for seam in self.seams.values() if seam}
        result = []
        prev = None
        for number, units in self.units.items():
            if number == self.hidden:
                continue
            for block, unit in units:
                seam = links.get(block.id)
                if seam and prev == seam[0]:
                    result[-1] = result[-1].join(unit, *seam[2:])
                else:
                    result.append(unit)
                prev = block.id
        return result
