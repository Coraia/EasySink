"""L0 词汇层：词典候选，不读取读者模型。

白名单、词频阈值、密度截断全部交给 L2，这样改密度/反馈不必重跑词典。
"""

from __future__ import annotations

from wise_reader.lexicon import Lexicon
from wise_reader.models import Annotation, Kind
from wise_reader.tokenize import Document, Token

ZERO_RANK_FALLBACK = 60_000

# 封闭词类永不标注。ECDICT 常把 is/taken 做成「生僻」独立词条，词频阈值挡不住。
_FUNCTION = frozenset(
    """a an the to of in on for with at by from as or and but not no if so than
    is are was were be been being am do does did have has had
    i you he she it we they me him her us them my your his its our their
    this that these those there here then than too very just
    can could will would shall should may might must cannot
    what which who whom whose when where why how
    up out over into about after before between through during without
    also only even still already yet""".split()
)


def _is_sentence_start(doc: Document, token: Token) -> bool:
    sent = doc.sentences[token.sent_id]
    return token.id == sent.first_token


def _is_acronym(token: Token) -> bool:
    return token.text.isupper() and len(token.text) > 1 and token.text.isalpha()


def _has_authority(entry) -> bool:
    return bool(entry.collins or entry.oxford or entry.tags)


def candidates(doc: Document, lexicon: Lexicon) -> list[Annotation]:
    """产出全部词汇候选。不含密度截断、不含读者阈值。"""
    out: list[Annotation] = []
    keys = [token.key for token in doc.tokens]
    lexicon.prefetch(keys)
    # Glosses and ranks are content-derived; compute once per distinct surface.
    entries = {}
    for key in set(keys):
        entry = lexicon.lookup(key)
        entries[key] = (
            entry,
            lexicon.lemma(key),
            entry.gloss() if entry else "",
            entry.rank if entry else 0,
            entry.full_gloss() if entry else "",
            entry.focus_domain if entry else None,
        )
    for token, key in zip(doc.tokens, keys):
        suppressed = _is_acronym(token)

        entry, lemma, gloss, rank, detail, domain = entries[key]

        if key in _FUNCTION or lemma in _FUNCTION:
            suppressed = True

        capitalized = token.text[:1].isupper()
        if capitalized and not _is_sentence_start(doc, token):
            suppressed = True

        if entry is None or not entry.has_definition:
            continue

        if capitalized and not entry.pos and not _has_authority(entry):
            # 句首人名地名：BNC 可能有词频，但无词性/考纲/柯林斯标记
            continue

        if rank == 0 and not _has_authority(entry):
            continue

        if not gloss or "姓氏" in gloss:
            continue

        rarity = rank if rank > 0 else ZERO_RANK_FALLBACK
        start, end = doc.slice(token.id, token.id)
        out.append(
            Annotation(
                first_token=token.id,
                last_token=token.id,
                kind=Kind.WORD,
                note=gloss,
                surface=doc.text[start:end],
                rarity=rarity,
                suppressed=suppressed,
                lemma=lemma,
                domain=domain,
                detail=detail,
            )
        )
    return out
