"""Bounded, literal multiword ECDICT matches in canonical token coordinates.

At most five n-grams per start; at most 256 starts and 400 SQL parameters
per working batch. No full lexicon scan, morphology, fuzzy matching or guessed
translations. Automatic admission requires independently attested expression
status AND an unchanged reviewed local dictionary row. Existence/POS/Chinese
text alone is not phrase evidence. All other rows remain manual candidates.
"""

import hashlib
import re
import unicodedata

from wise_reader.models import Annotation, Kind

MAX_PHRASE_TOKENS = 6
MAX_PHRASE_CHARACTERS = 96
WINDOW_STARTS = 256
_PARAGRAPH = re.compile(r"\n[^\S\n]*\n|[\r\u2028\u2029\f\v]")

# Reviewed 2026-10-11: Cambridge/Oxford expression entries; per-headword primary
# references and local raw rows are recorded in docs/parallel/v11-dictionary-status.md.
# This small admission resource contains no translations or contextual rules.
# Values hash the exact ECDICT translation/definition/detail joined with NUL;
# changed/missing rows fail closed, including new entity/web/unknown-POS senses.
# Do not auto-expand this set from POS, frequency, null fields or lemma forms:
# ECDICT has ordinary fragments, abbreviations, names and titles in those groups.
_REVIEWED_ROWS = {
    "break the ice": "47f1cf233c15840fa2105768d12496944027b75454a3854988bab0f8b5b920aa",
    "in light of": "e18dbc0c67f1cd0653e3f1a7f98a5d6aaf11788d8d5fd40f58ad4c5f93816244",
    "in the light of": "dab920a0ffebbf2dc8dcc9ef226db605f1bd91f797b03e8dcdc097ac66ec1bf0",
    "used to": "a808319b45aa9756e28e66a86343558e71a4d0c28fc79275cc2ac40caaa41837",
    "say grace": "1d80d260df39b08b7e171516ef28bee1830e52682a8b179184c2927dcc0976cc",
    "once in a blue moon": "5ab7f76a0301ce5e34bf2d5b9c24a28d0d674b1fa8333623cb7e5ef3438f58bb",
    "with a grain of salt": "ea59ffb9f6890a199ea3276827602ed4686ede2f03ea9e63b069da7f987cd1f4",
    "in place of": "bdf665b88f3fe9fcbc418749652b6e5b8701e826f519510f848af104f3716147",
    "leave out": "f2c62be6fc58bc1dab4ecf69efad83b13dbb8acfbdee9457f6290f2a30e6fa86",
    "watch out": "f1415642a122a1a853af21485d3835432eff55b7ac6548015fa2f1c427834c0b",
    "watch out for": "dfb02f909bb5b3b0e523e81c2b5c7efda6f763fd9cc8de1b986f9843e5b8ff2b",
    "figure out": "3a1af4c87661d3a04700b84d53c9d3f8cf2dbf352d93df10f1a7b2906c135385",
    "common sense": "6b0ade92d83a89c82d4d34b4f95d18bdb670e0ae30ba3a0f516d7871b11096c2",
    "find out": "f1628119652a2ad65ccd01b58c489b9d2ccec5971cbd5f5a8c9ab37cf1aaa8b0",
    "point out": "e917471814b0b62d014a88df8891a1dfa52e2d9fa68aabe9bff7c7e90763cb4c",
    "look up": "e99f3760f850caf098a4b06e836a1c2a81063b8ac93807d893dd1985998fb3f0",
    "check out": "18f279f236bf4e9c53cbd4a0d6b72b538df293e32fc26a353dacf833cdd8866f",
    "turn out": "f2a617961ad2a5a5beb10a2cc320b398c779257cdeccb7e01c8a505f89000aef",
    "work out": "138e30e36cd7db4bb83918507535d5137d95b72339770dd41f4431c45a38926d",
}


def _automatic_entry(entry):
    reviewed = _REVIEWED_ROWS.get(entry.word.casefold())
    if not reviewed or not entry.has_definition:
        return False
    contents = "\0".join((entry.translation, entry.definition, entry.detail))
    return hashlib.sha256(contents.encode()).hexdigest() == reviewed


def _identifier_character(char):
    return char.isalnum() or char == "_" or unicodedata.category(char).startswith("M")


def candidates(doc, lexicon):
    out = []
    tokens = doc.tokens
    for offset in range(0, len(tokens), WINDOW_STARTS):
        spans = []
        for first in range(offset, min(offset + WINDOW_STARTS, len(tokens))):
            head = tokens[first]
            if head.start and _identifier_character(doc.text[head.start - 1]):
                continue
            key = head.key
            for last in range(first + 1, min(first + MAX_PHRASE_TOKENS, len(tokens))):
                token, previous = tokens[last], tokens[last - 1]
                gap = doc.text[previous.end:token.start]
                if (token.sent_id != head.sent_id or not gap or not gap.isspace()
                        or _PARAGRAPH.search(gap.replace("\r\n", "\n"))
                        or token.end - head.start > MAX_PHRASE_CHARACTERS):
                    break
                key += " " + token.key
                if token.end < len(doc.text) and _identifier_character(doc.text[token.end]):
                    continue
                if key in _REVIEWED_ROWS:
                    spans.append((first, last, key))
        entries = lexicon.lookup_exact_many(key for _, _, key in spans)
        presentations = {
            key: (entry.gloss(), entry.full_gloss(), entry.rank)
            for key, entry in entries.items() if _automatic_entry(entry)
        }
        for first, last, key in spans:
            if key not in presentations:
                continue
            note, detail, rank = presentations[key]
            if not note:
                continue
            out.append(Annotation(
                first, last, Kind.PHRASE, note,
                doc.text[tokens[first].start:tokens[last].end],
                rank or 50_000, lemma=key, detail=detail, source="dictionary-phrase",
            ))
    return out
