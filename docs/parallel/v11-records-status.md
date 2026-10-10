# V1.1 records backend — ready for parent integration

Assigned: #40, backend portions of #43–44. Changes restricted to new collections Python modules and this handoff. Frozen API names in docs/73-v11-development-control.md remain unchanged. Parent owns registration, integration, browser walkthrough and client delivery.

## Failure classes recorded before implementation / isolated API checks

- UTF-16 split-surrogate, out-of-range/reversed/empty/forged quote, inconsistent root/segments, skipped paragraphs, image selections, stale or absent PDF revisions, forged client book/source fields.
- Duplicate same-kind occurrence versus same spelling at distinct positions; independent word/excerpt identities; strict intersection versus touching ranges; transitive bridge unions; original subrange meaning/explanation attribution and independent notes lost during merge/delete.
- Partial feedback accidentally resetting omitted fields, understood clearing retained, old global feedback modified; undo lost at restart, duplicate token use, stale revision and delete/recreate ABA, later overlapping saves overwritten.
- Source deletion/recycling/revision, repeated quotes, identical content in distinct books; imported IDs binding unrelated documents, hostile/malformed/oversized imports, partial import commits, repeated import duplication, history/notes lost, imported provenance pretending to be local AI.
- Explanation adoption from a different doc/version/range, failed or unknown assist; source snapshot rewritten; old explanation discarded.
- Export wrong book/selection, silently truncated records, unselected personal data; cleanup clearing another type/book or source, unscoped permanent deletion, undo resurrecting explicitly purged data.
- Resurfacing changing on refresh/restart, duplicate daily picks, seven-day avoidance and insufficient eligible data, snooze/off not persisting, deleted records resurfacing, paid/provider calls.
- Route precedence for static names versus IDs, plugin-off data mutation, access-lock integration, missing optional tables, unbounded list/state/import/source matching and large book work on page turns.

## Verification method and evidence boundary

Use production FastAPI routes and Store against an explicitly temporary database, with synthetic source text only. No real user DB/config writes, service restarts, providers, new unit tests or full E2E. Preserve the first failure and raw API transcript in this handoff; a reproducible temporary-DB smoke helper will remain in an assigned collections_* module. This does not establish browser/device/real-model acceptance.

## Scope details for parent

- `ids` on export/cleanup denotes collection record IDs; with `notes`/`feedback`, only records anchored within those selected ranges are included. `book_id` scopes all selected record types by that book. Combined book and IDs intersect. Unscoped cleanup is refused; global export is allowed with a hard explicit size limit.
- Ordinary removal uses persistent tombstones, retaining personal meaning and explanation subranges for undo/re-save. Explicit collections cleanup removes collection material; independent notes/feedback require their own flags.


## Delivered code and integration

- `src/wise_reader/collections.py`: additive schema/indexes, verified per-kind persistence, strict/transitive whole-excerpt union, preserved subrange explanation/history/meaning, independent contextual feedback, revision-guarded persistent undo, list/state/source, and local daily resurfacing.
- `src/wise_reader/collections_source.py`: read-only UTF-16 anchor verification, server-owned book/source/PDF metadata, bounded context snapshots, retained PDF revision reads, conservative unique-source/quote matching. No content/progress writes and no model calls.
- `src/wise_reader/collections_transfer.py`: Markdown and schema-v1 JSON exports, bounded atomic/idempotent restore, independent explicitly scoped cleanup, unresolved snapshot/notes preservation. Imported assist IDs remain provenance under `imported_assist_id`, never local adoption targets.
- `src/wise_reader/plugins/collections.py`: all frozen `/api/collections` endpoints. Runtime exports `migrate(store)` and `register(app, ctx)`; plugin ID is `collections`, default flag is on. Parent adds the catalog entry/backend plus frontend hooks. Existing app access-lock middleware must continue protecting these routes; the module checks the collections flag on every request.
- `src/wise_reader/collections_smoke.py`: repeatable API walkthrough, creates all SQLite files under a fresh temporary directory, mounts the actual route module and uses actual Store/content/notes/assist schemas. Does not load personal settings, launch a server, call any provider or use a browser.

The API field names in control doc §收藏 API v1 are unchanged. Additional item fields are `uid`, `subranges`, `context_truncated`; explanations preserve their original payload/provenance. `POST` dedupe returns the existing item with `merged_ids: []`, `undo_token: null`. A union keeps one existing record ID and reports the absorbed IDs in `merged_ids`; returned `item.anchor` is the complete union. `PATCH adopt_assist_id` accepts the whole range or a verified contained subrange; the latter updates that subrange only. Canonical range comparison ignores display ratio/local PDF asset IDs.

Meaning text accepts up to 20,000 characters to match the current UI. Ordinary cancellation retains personal metadata in a tombstone and restores it on undo or same-range re-save. Explicit collections cleanup includes the collection's personal meaning/history, as the UI labels, and never implicitly clears legacy notes or contextual feedback. Cleanup removes associated undo receipts, preventing later resurrection. A failed undo returns 409; a reused receipt also returns 409.

Import does not trust document IDs, book IDs, record IDs or assist IDs from another database. Source identity uses exact content digest plus provenance/chapter identity; engine-normalized lookup hashes are used only for indexed candidate lookup, followed by exact verification. Duplicate/ambiguous sources remain unavailable. Existing local edits and tombstones are not overwritten by repeated restore. Conflicting local/imported feedback returns 409 and rolls back the entire batch. Same-range imported personal material is retained as a subrange rather than overwriting newer personal text. Unavailable restored notes are retained in the collections portability table and included in subsequent scoped/global exports; they do not become a legacy note attached to a guessed document. Unanchored notes may bind only by a unique exact whole-source identity.

## Actual verification

- Python compileall / AST parsing passed for the five assigned Python files.
- Final isolated production-route smoke: **94 HTTP checks passed**, plus explicit result/database assertions. Coverage includes UTF-16 surrogate rejection, spoofed quote/book fields, per-kind dedupe, strict touching versus bridging overlap, multi-paragraph selections, metadata preservation, stale/reused/overlap/ABA undo refusal, undo after Store reopen, nullable understood versus retained/legacy independence, whole/subrange persisted-assist adoption and history, source preview, Markdown/JSON, same-library note import dedupe, unrelated numeric ID collisions, exact-source rebinding, ambiguous-source refusal, all-or-nothing conflicting/malformed imports, unresolved record-scoped export/cleanup, retained/changed/ambiguous/recycled PDF source fixtures, plugin-off preservation, resurfacing stable refresh/reopen/hide/show/next/snooze, cleanup scopes, and source removal retaining collection snapshots.
- Persisted assist rows and PDF revision tables are explicitly synthetic fixtures. They exercise real repository APIs; they do not establish real-model explanation quality, OCR quality, browser selection/texture rendering, physical device behavior, lifecycle integration, user-library migration or performance acceptance.
- No unexpected smoke failure occurred in the recorded runs. Expected 400/404/409/422 rejection responses remain in the raw transcripts. Static review caught and corrected normalized-hash lookup, same-library note duplication, unresolved scoped cleanup, subrange adoption and display-ratio comparison before their corresponding smoke assertions. The environment emits the existing Starlette/httpx TestClient deprecation warning; no dependency was installed or changed.
- No commits, pushes, issue mutations, real user DB/config writes or service restarts. No full E2E suite or real provider call was run.

Reproduce from the shared checkout:

```sh
PYTHONPATH=src .venv/bin/python -m wise_reader.collections_smoke
```

The helper prints its new evidence path and preserves the full request/response transcript and temporary databases; it never accepts a user database path. First run (66 HTTP checks) and final run (94) remain available below. Parent should copy these transcripts into its final durable integration evidence bundle before OS temporary-file cleanup.

- First run: `/var/folders/f4/gkwt98j97fj2vz13z5m54lxc0000gn/T/wise-collections-api-vok3cbxe/transcript.jsonl`
  - SHA-256: `89f13821776cc905f85dc019cac25ec91eb5e49a29e1273871d95674ef98a674`
- Final run: `/var/folders/f4/gkwt98j97fj2vz13z5m54lxc0000gn/T/wise-collections-api-izey3_o6/transcript.jsonl`
  - SHA-256: `26554dfcc710788132eb82f08b46b79848a439e81897aae1858fb2b0d438e706`

## Explicit bounds and final parent acceptance

- List: default 50, maximum 200 per request; one-document state: at most 2,000 records of each type, otherwise an explicit 413 (no silently missing highlights). No whole-book text fetch occurs in list/state.
- New selections and unions: at most 8,000 UTF-16 units and 256 segments; excessive unions fail atomically instead of clipping or partially merging. Snapshot context is at most 6,000 UTF-16 units, with `context_truncated` when needed. A single persisted record's JSON is at most 1 MiB.
- Export/import: at most 2,000 records total and 8 MiB JSON; `ids` at most 500. Export returns file responses. JSON root is `{schema:"wise-reader-collections",version:1,exported_at,collections:[],notes:[],feedback:[]}`. These are implementation limits, not frontend pagination assumptions.
- Source matching examines at most 32 indexed candidates and requires one reliable match. Missing/ambiguous/recycled sources return the saved quote/context with `available:false`. Successfully matching a changed PDF source returns `historical:true` and a current anchor while the saved quote/explanation stay historical. Source preview never updates resume position.
- Resurfacing uses the server's local calendar date, persists one daily choice and hidden/snooze state, prioritizes unseen then older eligible records, and returns an empty reason rather than forcing a repeat within seven days. Snooze lasts 30 days. Parent should validate the packaged host's local timezone, bookshelf refresh after deletion and native close/reopen.
- Old `word_verdict`, `wr_target`, independent notes behavior and existing core source deletion code were not edited. The only writes to legacy note tables are explicit notes import/cleanup requested through the new API. Collections/feedback snapshots survive the existing Store's document deletion sweep because their tables are independent.
- Required parent work: finish normal catalog/frontend integration; back up the user library before any production migration; validate actual access-lock/plugin-off routing, independent notes/cleanup UX, stale PDF feedback/highlight filtering by anchor version, source preview versus explicit continue, and all Web/macOS reading/selection/render/performance regressions. Final real-model samples, complete browser walkthrough, candidate build/install and human acceptance remain parent-owned.

## Subsequent integration review repairs — 2026-10-11

The original 94-request smoke did not exercise the R1–R3 failures later found in `docs/parallel/v11-records-integration-review.md`. Preserve that distinction: its earlier success did not prove lossless nested restore or transfer-boundary compatibility.

R1–R3 are now repaired in `collections_transfer.py` and `plugins/collections.py`. Local and incoming subrange meaning/explanation/history merge independently of root equality and deduplicate without replacing newer local root edits. Compact JSON uses the same 8 MiB representation for export and import data checks; requests allow an additional bounded 1 KiB envelope. API names/fields and PATCH revision semantics are unchanged; no expected_anchor was added. R4 belongs to Ohm's frontend repair.

Before changing production code, the new `collections_repair_smoke.py` recorded the actual temporary-DB production-route failures (76 requests, 10 passing/8 failing semantic checks). The same helper after repair completed 80 requests and all 19 applicable checks, including an exact 8,388,608-byte exported file restored by an 8,388,617-byte request; one-byte data overflow rejects atomically. No original/full suite rerun, browser, real provider, user DB/config write, service restart or commit occurred.

Durable synthetic evidence, raw request/response artifacts, temporary DB copies, before/after source, diff and SHA-256 manifest: `.runtime/evidence/v11-records-r1-r3/`. See the appended review report for exact measurements, evidence hashes, reproduction command and remaining UI/device acceptance boundaries.
