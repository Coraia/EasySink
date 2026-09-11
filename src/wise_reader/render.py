"""按标注切分原文，不按词切分。节点数 ≈ 标注数 × 2 + 1。"""

from __future__ import annotations

from wise_reader.models import Annotation, Fragment
from wise_reader.tokenize import Document


def fragments(doc: Document, annos: list[Annotation]) -> list[Fragment]:
    ordered = sorted(annos, key=lambda a: a.first_token)
    out: list[Fragment] = []
    cursor = 0
    for i, a in enumerate(ordered):
        start, end = doc.slice(a.first_token, a.last_token)
        if start < cursor:
            continue
        if start > cursor:
            out.append(Fragment(type="plain", text=doc.text[cursor:start]))
        out.append(
            Fragment(
                type="anno",
                text=doc.text[start:end],
                note=a.note,
                detail=a.detail,
                lemma=a.lemma,
                kind=a.kind.value,
                anno_id=i,
                first_token=a.first_token,
                last_token=a.last_token,
            )
        )
        cursor = end
    if cursor < len(doc.text):
        out.append(Fragment(type="plain", text=doc.text[cursor:]))
    return out


def render_inline(doc: Document, annos: list[Annotation]) -> str:
    parts: list[str] = []
    for f in fragments(doc, annos):
        if f.type == "plain":
            parts.append(f.text)
        else:
            parts.append(f"{f.text}({f.note})")
    return "".join(parts)
