"""Small auditable offline rules. General semantic understanding remains model-backed."""

import re

from wise_reader.models import Annotation, Kind

PHRASES = {
    "a grain of salt": ("持保留态度", "不要全盘相信。"),
    "break the ice": ("打破尴尬", "让初次见面或拘谨的谈话轻松起来。"),
    "the elephant in the room": (
        "被回避的明显问题",
        "大家都知道，却不愿公开讨论的问题。",
    ),
    "a double edged sword": ("有利也有弊", "带来好处的同时，也会造成问题。"),
    "moving the goalposts": ("临时改变标准", "在别人接近要求时，又改变评判条件。"),
    "on the same page": ("达成共识", "对情况或行动方向有共同的理解。"),
    "once in a blue moon": ("极少发生", "英语习语，形容非常罕见。"),
}


def contextualize(doc, candidates):
    for a in candidates:
        if a.lemma not in {"redistricting", "bank", "battery"}:
            continue
        sent = doc.sentences[doc.tokens[a.first_token].sent_id]
        context = doc.text[sent.start : sent.end].lower()
        senses = {
            "redistricting": [
                (r"elect|vot|congress|politic|district lines", "重划选区"),
                (r"school|student", "重划学区"),
            ],
            "bank": [
                (r"river|stream|water|shore", "河岸"),
                (r"money|loan|account|deposit|financ", "银行"),
            ],
            "battery": [
                (r"charg|phone|power|electric|volt", "电池"),
                (r"assault|convict|court|criminal", "殴打罪"),
            ],
        }
        for pattern, note in senses.get(a.lemma, []):
            if re.search(pattern, context):
                a.note = note
                a.detail = "依据本句关键词选择的释义，可展开词典核对。"
                a.source = "context-rule"
                break
    return candidates


def phrases(doc):
    tokens = [t.key.replace("-", " ") for t in doc.tokens]
    out = []
    for surface, (note, detail) in PHRASES.items():
        words = surface.split()
        for start in range(len(tokens)):
            if tokens[start].split()[0] != words[0]:
                continue
            for width in range(max(1, len(words) - 2), len(words) + 1):
                end = start + width - 1
                if end >= len(tokens):
                    break
                if (
                    " ".join(tokens[start : end + 1]) == surface
                    and doc.tokens[start].sent_id == doc.tokens[end].sent_id
                ):
                    out.append(
                        Annotation(
                            start,
                            end,
                            Kind.PHRASE,
                            note,
                            doc.text[doc.tokens[start].start : doc.tokens[end].end],
                            50000,
                            detail=detail,
                            source="phrase-rule",
                        )
                    )
    return out


def target(a):
    if a.kind == Kind.WORD:
        return a.lemma or a.surface.lower()
    return a.kind.value + ":" + re.sub(r"\s+", " ", a.surface.lower()).strip()
