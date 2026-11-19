# V1.1 dictionary / ticket #41

Status: contributor implementation complete; parent integration, real AI quality and final Web/macOS acceptance remain. Scope: lexicon.py, l0.py, l2.py, semantics.py and dictionary-only helpers/resources. No engine/app/reader/reading_assist edits, user database/config writes, service operations, commits or issue mutations.

## Failure classes recorded before isolated verification

1. Multiline Chinese definitions lose later POS/domain senses; inline truncation splits words or silently chooses the first sense. Full lookup must retain raw fields and structured candidates.
2. English definition is omitted or lost when Chinese is empty; unrelated Chinese/English lines must not be paired as translations of the same sense. Empty entry must remain explicitly missing.
3. POS ratios, usage brackets and domain labels can be misparsed; unknown source labels must be retained without invented semantic classifications or stable upstream sense IDs.
4. Keyword contextual rules can confidently select the wrong meaning (bank/battery); dictionary output must remain candidates and never claim contextual disambiguation.
5. Phrase matching crosses punctuation, sentence, paragraph, numbers or substring boundaries; fabricated inflections, longest-prefix matches and overlapping matches misidentify spans. Lookup and matching must use attested dictionary entries and bounded literal source ranges.
6. Phrase matching scans the full dictionary or creates unbounded candidate/query sets, particularly in long books. Limits and raw timing/query observations must be recorded.
7. Automatic member glosses override phrases; forced/retained members vanish at zero density, known state, repeat suppression or overlap. Parent contextual-retention integration must be explicit.
8. Lemma precedence, case/ligature/apostrophe normalization, missing rows, row caching and legacy call signatures regress. Source caches can keep obsolete truncated/context-rule annotations after rollout.
9. Corpus samples are synthetic, misquoted, lack provenance or report a model's own grading as acceptance. Fixed raw source excerpts, source locators, expected boundaries, old/current outputs and unresolved quality gaps must be retained locally.
10. Frontend truncation, source labels, literal rendering, member lookup, stale caches, final Web/macOS rendering and real AI quality are outside this contributor's isolated verification and remain parent acceptance work.

## Evidence plan

Record baseline production API calls and source files under outputs/v11-dictionary-20261011 before implementation. Re-run the same reproduction against current production code; no new unit tests or full E2E. Prepare >=30 fixed authentic contexts, evenly split everyday/theology/technical. Actual AI requests and final walkthrough belong to parent.

## Changed files and behavior

- `src/wise_reader/lexicon.py`: load `definition` and `detail` in every lookup/batch/band query. `Entry.senses` and `full_gloss()` preserve independent Chinese and English lines. `gloss()` now defaults to a 48-character candidate preview, shows later domain groups before other POS groups and marks omission. Existing lemma precedence and rank rules remain; queries normalize NFKC, apostrophes and whitespace. Add `lookup_exact_many()` for bounded indexed phrase windows and `lookup_payload()` for Engine.
- `src/wise_reader/dictionary_payload.py` (new): plain-text source-line parsing, POS/domain/label metadata, local line IDs, full details, compact previews, ECDICT attribution and payload version. No Chinese/English line alignment or generated translation. Domain metadata is taken only from explicit source labels. Unknown labels remain visible. The `[网络]` source label is not a computing-domain assertion.
- `src/wise_reader/l0.py`: full detail instead of first line / 100 characters; allow existing English definitions when Chinese is missing. Existing proper-name/authority/rank suppression still governs automatic word candidates.
- `src/wise_reader/dictionary_phrases.py` (new): literal dictionary entries, 2–6 canonical tokens, at most 96 source characters. At most 256 start positions / 1,280 spans in a working window, 400 SQL parameters per batch and 20,000 cached rows. Sentence/paragraph/punctuation/number/identifier boundaries are enforced. Single LF or CRLF line wrapping is allowed. No full dictionary scan, fuzzy matching, inflection expansion, resource download or new dependency.
- `src/wise_reader/semantics.py`: delegate phrases to the supplied Lexicon; remove handwritten phrase translations and the bank/battery/redistricting keyword-based contextual guesses. `contextualize()` remains a compatibility no-op.
- `src/wise_reader/l2.py`: longer phrases precede overlapping automatic member glosses; offline dictionary phrases work when model L1 is disabled. Add verified occurrence `retained=` override before density, knowledge, repeat and overlap filtering.
- `docs/parallel/v11-dictionary-status.md`: this handoff. Scripts, raw book excerpts, preserved baseline, corpus and measurements exist only in ignored `outputs/v11-dictionary-20261011/`.

## Formal Engine lookup contract

`Lexicon.lookup_payload(word: str) -> dict` is the integration API. Engine.lookup should return it directly. Legacy `word`, `lemma`, `found`, `phonetic`, `note`, `detail`, `rank` are retained. A missing entry returns empty strings, rank 0, an empty candidate list, `found=false`, and explicit missing flags.

```text
dictionary = {
  senses: [{id, language: "zh"|"en", pos, domains: [], labels: [],
            text, raw, field: "translation"|"definition", line, source: "ecdict"}],
  source: {id, name, url, license, version, revision},
  sources: [{id, name, url, license, version, revision}],
  language: "zh"|"en"|null,
  chinese_missing: bool,
  definition_missing: bool,
  contextual: false,
  version: "ecdict-candidates-v2",
  revision: <local snapshot fingerprint>,
  pos: <original ECDICT POS frequency string>,
  headword: string|null
}
```

Top-level fields also expose `translation`, `definition`, `raw_detail`, `senses`, `sources`, `kind="dictionary-candidates"`, `contextual=false`, `payload_version` and `dictionary_revision`. The original entry's `pos` may contain ratios (e.g. `v:28/n:72`); per-line POS is separate. Candidate lines may contain several unseparated meanings in ECDICT: line IDs are presentation IDs, **not** upstream semantic IDs, nor cross-language equivalence or contextual sense classifications. Frontend must escape all strings and should not truncate `detail` or omit the full candidate expansion. No HTML from dictionary content is trusted.

The dictionary revision fingerprints payload version and local data/lemma file metadata; it is a cache identity, not a claim that this DB matches an upstream release. Existing data is labeled `local snapshot` and credited to the ECDICT repository; no external licensed corpus was bundled.

## Integration requirements

1. `Engine.lookup(word) -> self.lexicon.lookup_payload(word)`; parent reported this integrated.
2. Both Engine analysis/preparation paths call `semantics.phrases(doc, self.lexicon)`; parent reported this integrated. The legacy omitted-lexicon call deliberately yields no phrases instead of opening a hidden DB or returning canned rules.
3. SourceCache must fingerprint **both new helpers** `dictionary_payload.py` and `dictionary_phrases.py`, in addition to current lexicon/l0/semantics inputs. Parent reported both added. Existing process-local analysis must be recreated on controlled candidate rollout; no manual deletion or rewriting of original/paid/user records is necessary.
4. For contextual retained records, resolve anchors against the exact current doc into `Annotation` objects and pass `l2.filter_candidates(..., retained=[...])`, or perform an equivalent parent merge that removes an enclosing automatic phrase before inserting retained members. Do not map retained state to global `known`/`unknown`. Retained occurrences bypass density=0, known state and same-spelling repeat suppression. If explicit retained records themselves overlap, narrower spans win in this helper; parent must preserve all records and decide how its renderer presents the remaining overlapping retained content.
5. Word-card member lookup uses the original selected member span, with its own anchor. Dictionary phrase membership does not establish a contextual sense. The new 48-character maximum preview needs the parent's actual narrow-window and macOS layout walkthrough.
6. Parent must review automatic phrase quality/density in the complete reading flow and run real AI on the fixed corpus. Runtime/provider settings were not read or changed here; no model-selection or provider acceptance is claimed.

## Authentic fixed corpus and parent replay

Primary artifact: `outputs/v11-dictionary-20261011/corpus-30.json`.

- Exactly 10 everyday contexts from the existing imported *Federal Plain Language Guidelines*, 10 theology contexts from *The Mission of God*, 10 technical contexts from *Python Pocket Reference*.
- Every row has `id`, `category`, `query`, `quote`, actual `doc_id`, stored-content `anchor` (`version`, `block_id`, **UTF-16** `start/end`, prefix/suffix/quote), raw paragraph, book/title/author/chapter provenance, whole-document and block SHA-256, content version and absolute codepoint range.
- Original stored text is retained unchanged, including OCR peculiarities and the technical book's historical Python-version qualifiers. `raw-samples-30.json` preserves the selected blocks and provenance; `corpus-review.md` gives the comparison and review boundaries in readable form.
- Each sample has actual old lookup output from the preserved production Lexicon and current `lookup_payload` plus overlapping production L0/phrase candidates. `corpus-final-readback.json` confirms all 30 anchors and lookup/overlap outputs against final code and records source file hashes.
- `expected_contextual_boundary` is a review instruction tied to the actual passage, not a golden translation or AI/self-awarded correctness score. `ai_evaluation.status="not_run"`, model calls 0, reviewer decision null throughout. Parent should supply each row's `doc_id` and `anchor` to the actual context endpoint in its acceptance DB copy; verify content versions/hashes first and preserve model/request/result evidence separately.
- Explicit gaps: `in Christ` has no local entry; `piece of clothing` and `killing it` have English-only entries. The technical use of `killing it` refers to terminating a process, while the dictionary entry is slang about performing well: it remains a manual candidate and is excluded from automatic phrase coverage. The theological book's `justification` sample is a rationale for mission strategy, so a theological-book keyword must not force the doctrinal sense. These are deliberate review cases, not claimed semantic passes.
- All quoted book material stays local in ignored outputs, not published or included in the source handoff. No user DB writes were made.

Reproduction from repo root (each evidence name must be new):

```sh
.venv/bin/python3 outputs/v11-dictionary-20261011/replay_dictionary.py replay-new-name
.venv/bin/python3 -m pytest -q tests/test_lexicon.py tests/test_l0.py
```

`prepare_corpus.py` freezes the fixed selections, compares the preserved baseline, and refuses to overwrite existing corpus evidence. It uses only read-only DB connections. `measure_dictionary.py` captures production in-process measurements; keep the initial measurement artifact when rerunning it.

## Actual verification and preserved failures

- Before implementation: `first-failure.json`, original four source files in `baseline-src/`, and `baseline-replay.json` captured truncation, missing `say grace`, boundary overmatching, missing English fallback and keyword guesses. Baseline replay: 5/23 checks. The final replay has one additional conditional observation once the real English-only payload exists, so do not compare those totals as an accuracy metric.
- `current-replay-1.json` retained the first repair failure: pure `[网络]` dictionary row `the ice` appeared as an automatic phrase after a retained member displaced `break the ice`. Pure web-only entries, and English-only entries without source POS structure, are now manual-only. `current-replay-after-cache-repair.json`: 24/24 deterministic contract/boundary observations on actual dictionary APIs. Short input/timing cases here are explicitly synthetic and not corpus quality evidence.
- `identifier-boundary-first-failure.json` captured partial matching inside digit/underscore identifiers. `identifier-boundary-current.json` confirms the same calls no longer produce those matches and that one CRLF wrap can match.
- `measurements.json` preserves the first real long-book measurements, including unstable cold/warm phrase counts. `cache-working-set-first-failure.json` captured affected spans and ruled out duplicate case-insensitive DB headwords. Cause: adding misses could evict still-needed hits from the same batch. A <=400-row working copy fixes this without increasing the persistent cache bound.
- `cache-working-set-current.json`: cold/warm serialized phrase outputs are identical for both real documents: 54,789 tokens / 5,548 phrases and 22,289 tokens / 3,210 phrases. Measured phrase scans were 0.272/0.270 seconds and 0.269/0.164 seconds respectively on this run, with row LRU capped at 20,000. These are CPU/process measurements with uncontrolled OS file cache, **not** reader opening latency, device performance or a V1 performance pass.
- Existing targeted checks: 14/14 in `existing-targeted-final.txt`; no new unit tests and no full E2E. Python syntax compilation completed for all six owned modules.
- `corpus-first-failure.txt` preserves a tooling failure: the copied baseline inferred the wrong default DATA directory; it was corrected by explicitly supplying existing data paths. `corpus-final-readback-first.json` preserves a Python tuple-vs-JSON-list comparison mismatch; `Sense.to_dict()` now returns JSON arrays directly, without changing the HTTP schema, and final readback is 30/30 consistent.

## Remaining acceptance limits

This restores available dictionary information; it cannot create missing theology/computing senses or establish the meaning in a particular sentence. Automatic phrase eligibility is conservative and incomplete: phrases longer than six tokens/96 characters, unrecorded inflections, punctuation-separated phrases, pure web-only and unstructured English-only entries remain manual or unavailable. No Eudic, bulk dictionary download, handcrafted contextual translations, fake provider run, model self-grading, browser/device pass, final candidate build or production rollout was performed by this contributor.

## Read-only parent integration review · 2026-10-11

Requested review completed against the working diff from HEAD `023936a1d9df72715fc6794dbe64e3c38352eacb` plus untracked `web/dictionary-card.js`. Only this handoff was appended. No UI, model, service, database write, new test or modification to the parent's files. Read-only call-path inspection also covered `reading-interactions.js`, `assist-popup.js`, source selection/pagination and collections hooks to check consumers and reachability; these were not edited. No sub-agent tools were available, so standards and spec were reviewed directly.

### Standards/interface axis

No additional documented-standard violation identified within the requested four-file integration scope. User-data writes are not introduced by lookup (`mark_unknown:false` at the UI entry points); dictionary strings are escaped. `git diff --check` on tracked review files returned clean. This is a static conclusion, not a security or runtime acceptance claim.

### Spec axis: two actionable findings

1. **[P2] Dictionary expansion hides retained/model explanation details.** `web/dictionary-card.js:20–21` unconditionally hides the popup's direct `p.muted`. At `web/reader.js:486` that element contains `item.detail`; it is not necessarily duplicate dictionary text. For a `source="model"` annotation with a short `note` and nonempty contextual `detail` (actual L1 contract at `src/wise_reader/l1.py:126–142`), opening its card causes `reading-interactions.js:482–497` to fetch dictionary candidates and render this helper. The helper preserves `.meaning` for model/retained sources at lines 17–19, but still hides the accompanying explanation, leaving only the short note and generic dictionary candidates. The independent context panel only renders separately stored context records; it does not restore the L1/retained `item.detail`. The same loss applies to a saved retained annotation's nonempty detail. This violates Q16's separation/preservation of available contextual explanations. **Repair:** hide only the superseded dictionary detail, or move it into a separately labeled original annotation section; retain non-dictionary details and source labels. Also ensure any dictionary `raw_detail` beyond parsed sense lines remains reachable rather than blanket-hidden.

2. **[P2] Empty `segments` suppresses the phrase-member entry for a valid single-block anchor.** `web/dictionary-card.js:29–30` accepts missing `segments` or exactly one segment, but rejects `segments: []` because arrays are truthy and length 0 is not 1. Empty segments is the normal single-block representation returned by `web/source-selection.js:8–12` and serialized backend `Anchor`; `anchorSegments()` at lines 2–3 explicitly treats it as `[anchor]`. Passing such an otherwise valid multiword anchor to the card yields no member buttons, so `web/reader.js:566–571` cannot be reached for its members. This is a Q20/anchor-contract gap; ordinary auto-phrase clicks currently use `anchorFor()` with no segments and are unaffected. **Repair:** use the shared `anchorSegments()` normalization and permit exactly one resolved part (or accept `!anchor.segments?.length` for canonical single-block anchors), then compute member offsets within that resolved part. Do not accept cross-block joined quotes as one offset range.

### Checked paths without an additional finding

- `src/wise_reader/engine.py:271–272` returns `lookup_payload` unchanged; both phrase callers at lines 71 and 144 supply the same Lexicon. `source_cache.py:23` fingerprints both new helpers, so a new candidate process invalidates obsolete analysis.
- `web/dictionary-card.js:14–16,26–34` separates Chinese and English candidate lines. Two-line preview is supplemented with all lines whenever there are >2 senses or both languages. POS/labels/domains are retained and escaped; English fallback explains missing Chinese. No additional first-line-only loss was found in the `senses` rendering path.
- `web/reader.js:479–486` and `dictionary-card.js:31–34` label dictionary candidates as generic and preserve model/retained source captions. `Engine.present:215–217` preserves the new `dictionary-phrase` source instead of relabeling it as model output. Note length does not select a contextual/model label. The actual context explanation is in a separate `.word-context` section (`assist-popup.js:35–78`), outside the dictionary replacement subtree. Finding 1 concerns the original annotation's detail, not an overwrite of this separate saved-context section.
- For ordinary single-block auto phrases, member `matchAll().index` and `.length` use the original, unnormalized quote's UTF-16 offsets; `reader.js:568–571` adds the parent block-local start and recreates quote/version/prefix/suffix with `anchorFor()`. `pagination.js:345–358` likewise derives annotation offsets from JS text length. No additional member-offset error was found for astral prefixes, ligatures or whitespace normalization. Cross-block quotes are not flattened into member offsets. Finding 2 is the empty-segments eligibility error.
- `reader.js:321–325` applies collections' occurrence annotations before indexing. The linked `collections-marks.js` path removes an overlapping whole automatic phrase before inserting retained members and checks content version, so lack of `retained=` at Engine's L2 call is not by itself a defect in this frontend integration.

Snapshot SHA-256 at review (line numbers refer to these contents; parent may subsequently edit):

```text
src/wise_reader/engine.py       351563ac76025c9b892831b0da4f367b059a705911a05476670afdf7a8b3b24b
src/wise_reader/source_cache.py 2c98549d90dc0e2d29ab2d291dcef84ec1d0d3f0a82bbdb75945e6c313a8aa3c
web/dictionary-card.js         ca6322bc5ce434e4a430aa70662ba9cdedec5c3c6b8b97ba3557ea9930384948
web/reader.js                  82fbe2f9d25809e3c5acc4cd62877b66f4976a1da3b8ad346d3f8b5a10025637
```

Result: standards/interface 0 additional findings; spec 2 P2 findings. Final UI layout, actual events, provider quality and device acceptance remain with parent; this review does not mark those passed.

## P0 automatic phrase admission repair · first failure 2026-10-11

Parent's actual candidate walkthrough on port 18772 reported *The quiet art of paying attention*: `The quiet → [电影]沉默`, `the river → [电影]大河`, `The bank → [电影]银行`, and `stood in → na. 加入；〈口〉使花费`. Parent preserves DOM/screenshots; those UI artifacts are not reproduced or claimed here. The prior dictionary replay passing was insufficient to establish automatic phrase quality. The current predicate wrongly treats any non-web Chinese line as sufficient evidence of a fixed expression.

Failure classes recorded **before** the new isolated production replay/repair:

1. Film/work/person/place/entity senses can match ordinary lowercase prose and suppress useful member annotations; checking dictionary existence, Chinese availability or POS alone is insufficient.
2. `na.`/unknown POS, web-derived and otherwise unstructured fragments or inflections can be admitted as phrases without reliable phrase evidence; mixed rows can hide such evidence behind another admissible line.
3. Blanket rejection of untagged rows also loses genuine legacy expressions (`break the ice`, `in light of`, `used to`, `say grace`, `once in a blue moon`). Any exception must identify an actual dictionary expression and its admission provenance, never supply a handcrafted contextual translation.
4. A new policy may fix the four reported strings but still admit other spurious spans in the same full document or in the fixed 30 real-book contexts; capture all candidates and L2 selections, not only named matches.
5. Admission changes may accidentally alter full/manual lookup payloads, English fallback, phrase boundaries, longest precedence or retained member overrides; rerun the already-existing targeted replay/checks after repair.
6. Headword normalization, missing local entries, mixed-language/POS metadata and cold/warm row-cache eviction may make results inconsistent. Preserve actual raw rows and code hashes; do not infer source trust from incidental SQLite ID ranges/null formatting.
7. A running parent process may retain prior analysis; helper hashes already included in SourceCache only take effect through the parent's controlled candidate refresh. No contributor service restart or cache/database mutation is authorized.

Repair evidence will be appended below; no model, provider, UI or contextual-quality pass is inferred from this replay.

### Additive nested raw-detail handoff · pre-check failure classes

Parent requested `lookup_payload(word)["dictionary"]["raw_detail"]` because the frontend forwards only the nested dictionary object. Before checking or changing it: the supplement can be lost at that transport boundary; NULL/missing entries can violate the expected string shape; whitespace/newlines or HTML-like characters can be altered; an additive field can unintentionally change legacy fields or independent sense lines. The helper must copy `Entry.detail` verbatim (or `""` for a missing entry), keep the existing top-level `raw_detail`, and never interpret supplement text as a contextual explanation. Parent owns escaped, collapsible rendering. This additive contract needs no new cache input because `lexicon.py` is already fingerprinted.

### P0 repair delivered

Changed production files in this follow-up: **`src/wise_reader/dictionary_phrases.py` and `src/wise_reader/lexicon.py` only**. This handoff and ignored evidence were also updated. No parent files, original DB/config, services, commits or issues were changed.

The initial complete-document replay reproduced all four reported errors and found more instances of the same failure class: movie entries `the bridge`/`the owner`, abbreviations `of a`/`us to`, and ordinary fragments with unrelated dictionary senses. The 30 book-context replay also admitted `be nested` as a person's name and numerous unrelated fragments. A POS blacklist or a few rejected headwords would leave this structural problem in place.

Automatic matching now uses **positive admission with 19 independently attested expressions** and SHA-256 of each reviewed local ECDICT row's exact translation, definition and supplement joined with NUL. A missing/changed row or an unreviewed headword is manual-only. Chinese availability, POS, dictionary existence, frequency, DB IDs/null conventions and inflection membership cannot independently grant admission. No per-sentence rules, rewritten translations or generated definitions are present. All displayed words and senses still come from the installed production Lexicon; primary references establish expression status only and are not runtime dependencies or new dictionary-content sources.

The admission data lives in `dictionary_phrases.py`, already included in the parent's SourceCache fingerprint. There is **no additional file to hash**, dependency, dictionary download or schema change for this phrase repair. Unreviewed n-grams are discarded before SQL lookup; the existing 2–6-token/96-character boundaries, working-window bound and literal matching remain. Phrase precedence and explicit retained member overrides continue through the existing L2 path.

Coverage is intentionally narrow: only these 19 exact headwords currently qualify. For example, `on the same page` and `the elephant in the room` have only local web-derived senses, while `moving the goalposts` is absent; these are not silently supplied with the removed handwritten translations. Technical/theological expressions outside the reviewed set remain available through manual lookup. This is an automatic-admission repair, not full dictionary coverage or contextual disambiguation. Reviewed expressions can still have literal/other uses; the UI must continue labeling them as candidates.

### Admission provenance (reviewed 2026-10-11)

Each admitted headword's actual local row, payload and fingerprint are retained in `phrase-admission-p0/final-readback.json`. References below were checked against publisher dictionary entries, including search-indexed publisher content where direct Cambridge opens returned HTTP 403. No publisher definitions/examples are bundled in the code or used to replace ECDICT translations.

| Local headword(s) | Primary expression evidence |
| --- | --- |
| `break the ice` | [Cambridge: idiom](https://dictionary.cambridge.org/us/dictionary/english/break-the-ice) |
| `in light of`, `in the light of` | [Cambridge: idiom and US variant](https://dictionary.cambridge.org/dictionary/english/in-the-light-of?q=in-%28the%29-light-of) |
| `used to` | [Cambridge: phrase/modal verb](https://dictionary.cambridge.org/dictionary/english/used-to) |
| `say grace` | [Cambridge: prayer collocation under grace](https://dictionary.cambridge.org/dictionary/english/grace?q=grace_4) |
| `once in a blue moon` | [Cambridge: idiom](https://dictionary.cambridge.org/us/dictionary/english/once-in-a-blue-moon) |
| `with a grain of salt` | [Cambridge: fixed core of take something with a grain of salt](https://dictionary.cambridge.org/us/dictionary/english/take-with-a-grain-of-salt) |
| `in place of` | [Cambridge: phrase](https://dictionary.cambridge.org/dictionary/english/in-place-of) |
| `leave out` | [Cambridge: phrasal verb](https://dictionary.cambridge.org/dictionary/english/leave-out) |
| `watch out` | [Cambridge: phrasal verb](https://dictionary.cambridge.org/us/dictionary/english/watch-out) |
| `watch out for` | [Cambridge: phrasal verb](https://dictionary.cambridge.org/dictionary/english/watch-out-for) |
| `figure out` | [Oxford: phrasal verb](https://www.oxfordlearnersdictionaries.com/us/definition/english/figure-out) |
| `common sense` | [Cambridge: lexical noun expression](https://dictionary.cambridge.org/us/dictionary/english/common-sense) |
| `find out` | [Oxford: phrasal verb](https://www.oxfordlearnersdictionaries.com/us/definition/english/find-out) |
| `point out` | [Oxford: phrasal verb](https://www.oxfordlearnersdictionaries.com/us/definition/english/point-out) |
| `look up` | [Oxford: phrasal verb](https://www.oxfordlearnersdictionaries.com/us/definition/english/look-up) |
| `check out` | [Oxford: phrasal verb](https://www.oxfordlearnersdictionaries.com/us/definition/english/check-out) |
| `turn out` | [Oxford: phrasal verb](https://www.oxfordlearnersdictionaries.com/us/definition/english/turn-out) |
| `work out` | [Oxford: phrasal verb](https://www.oxfordlearnersdictionaries.com/definition/english/work-out?q=work+out) |

### Actual P0 verification and evidence

Evidence root: `outputs/v11-dictionary-20261011/phrase-admission-p0/`. All files are new; earlier failed/successful evidence remains unchanged.

- `before-*.py`, `raw-reported-document.json`, `first-failure.json`: preserve the broken implementation, the complete existing document 6 (title matching the reported sample, 2,788 characters, 15 stored blocks), version/hash/provenance, all phrase/word candidates and L2 selections. This is an imported demonstration text; it is not counted as one of the 30 real-book contexts, nor claimed to be the parent's UI capture.
- `replay.py` was written before the repair after documenting failure classes. It calls the real production tokenization/Lexicon/L0/phrase/L2 APIs with the existing read-only dictionary; there are no mocks or provider calls. `after-repair.json` captures the same complete sample and all 30 full stored source blocks, including anchors, provenance and expected contextual boundaries.
- Sample phrases: **82 → 3**, namely `used to`, `break the ice`, `with a grain of salt`. All four reported false positives are absent. In the captured L2 profile, the original `quiet`, `river`, `bank`, `stood`, `heron`, `water` word candidates are available again. Their generic dictionary alternatives are unchanged; no contextual translation was supplied.
- Thirty authentic source blocks: **219 → 6 phrase occurrences**, covering `leave out`, `watch out`, `watch out for`, `common sense`, `figure out`, `in place of`. These counts include overlapping candidates before L2 selection, not a coverage/accuracy metric. The removed candidates and raw lookup data remain in the first-failure artifact.
- All 19 admitted local rows produce the full exact span. All 269 manual lookup payloads captured in the first replay were unchanged by the admission repair. All 30 original anchors/provenance/raw contexts/review boundaries are unchanged (`final-readback.json`).
- Existing `current-replay-after-p0-admission.json`: **24/24** deterministic contract/boundary/precedence observations, including English fallback, full domain details and retained-member overrides. This also contains a clearly synthetic 9,000-token repeated-input timing case, not an actual book quality/performance pass.
- Existing targeted checks: **14 passed**, preserved in `existing-targeted-after-repair.txt`; rerun after the later additive nested field also **14 passed** in `existing-targeted-after-nested-detail.txt`. No new unit tests or full E2E. Six owned Python modules compiled in memory; tracked owned/integration diff whitespace check was clean.

### Final nested raw-detail contract and fixed-corpus revision

Formal helper remains **`Lexicon.lookup_payload(word: str) -> dict`**. Additive field now delivered:

```text
result.dictionary.raw_detail: str = entry.detail if entry else ""
```

This is the original unparsed supplement, not a new sense or context explanation. Top-level `raw_detail`, legacy found/lemma/phonetic/note/detail/rank and every existing nested field remain unchanged. No version bump is needed for the optional additive field; `lexicon.py` is already included in the parent's SourceCache fingerprint.

`nested-detail-first-failure.json` records the missing nested field before the change. The actual installed dictionary contains one nonempty supplement row (`a`); `nested-detail-current.json` verifies its content verbatim, plus empty-supplement `thread` and a genuinely missing query. After removing only the additive nested field, all 269 captured manual payloads compare identical to their pre-repair values. No fabricated entry was used to claim success.

Parent's current corpus artifact is **`outputs/v11-dictionary-20261011/corpus-30-after-p0-and-raw-detail.json`**. It preserves the original 10/10/10 selections, old dictionary outputs, anchors/doc/provenance/raw samples and expected contextual boundaries, and refreshes current lookup payloads/overlapping candidates against this repair. The original `corpus-30.json` and raw-sample artifact remain untouched. Every AI evaluation is still `not_run`, model calls 0, decision null.

### Final read-only integration re-review after parent's P2 repairs

The two previously reported P2 defects are now **resolved in the inspected source**:

- `web/dictionary-card.js:17–21`: both note and original detail remain visible for `model`/`context-retained`; dictionary rendering no longer hides those explanations. `:34` now always offers the complete senses/source section when any sense or supplement exists, and escapes `dictionary.raw_detail` inside its own collapsible section. The new nested helper field reaches it through `reader.js:628` and the existing enrichment path without frontend modifications by this contributor.
- `web/dictionary-card.js:29–30`: empty `segments: []` is accepted as a canonical single-block anchor, while multiple segments are excluded. `reader.js:570–573` still derives member bounds from the original quote's UTF-16 offsets and recreates the member's own source anchor. No new member-anchor defect found in this path.

`Engine.lookup` still returns the structured payload directly. Both phrase call sites and both helper hashes remain integrated. Chinese/English candidate lists, full POS/domain/labels, source captions and the independent context pane remain separate. Neither candidate length nor long supplement text changes source to model/context. The annotation's original `source` continues to control its label; `dictionary-phrase` is preserved by Engine. **No outstanding actionable defect found in the requested four-file static integration scope after these repairs.** UI events/layout, actual AI quality and final candidate/device acceptance remain parent-owned and were not run here.

Final inspected snapshot hashes (parent may continue editing):

```text
src/wise_reader/engine.py       351563ac76025c9b892831b0da4f367b059a705911a05476670afdf7a8b3b24b
src/wise_reader/source_cache.py 2c98549d90dc0e2d29ab2d291dcef84ec1d0d3f0a82bbdb75945e6c313a8aa3c
web/dictionary-card.js         3c22dc78e86d6b92553daf34b32266ae1a7ec1c665639c13b64d9f63b87db582
web/reader.js                  8cf925fc1000e4d1affa015c6bb219d6477d87eb8aee4f6234892445091ed026
```

Integration next step: parent refreshes the controlled candidate process/build so its existing SourceCache fingerprint and process-local analysis see these two changed dictionary files, then replays the preserved UI failure. No contributor restart/cache deletion was performed. The precise controlled process/build refresh and browser/macOS evidence belong to the parent's acceptance record.
