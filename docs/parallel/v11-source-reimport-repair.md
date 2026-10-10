# Exact-source reimport fallback repair

Ownership: only `src/wise_reader/collections_source.py`. The original `v11-review-spec.md` remains unchanged. Main owns note/original deletion; Epicurus owns adoption/null-ID and subrange import repairs. This handoff covers neither of those repairs.

## Failure classes and replay plan — recorded before implementation

1. A deleted saved document ID can prevent an identical reimported EPUB/TXT from being located despite its stable source identity. Exercise real import → collection save → book delete → identical import → collection source API, with different local IDs.
2. A stale ID may point to another document with identical text/anchors but a different original fingerprint. Reject that numeric-ID collision; only resolve a uniquely verified stable original. A same-title/text different EPUB must not qualify.
3. Zero matches, two reliable candidates, and more than the existing 32-candidate ceiling must fail closed. Do not select the first match, raise the ceiling, or weaken archive/lifecycle checks. An existing valid local binding must retain its fast path.
4. Source revisions require the existing exact quote/edge-context match. A unique relocated quote may resolve; multiple equally reliable quote occurrences and changed raw source characters must not. Partial-word, UTF-16 and cross-paragraph anchors must survive exact reimport unchanged.
5. Source lookup must not rewrite the saved snapshot, local binding, revision, personal content, feedback, or reading position. Compare the entire temporary database's logical digest before/after every source GET. Null-ID/import resolution must retain its existing behavior.
6. Verification must not touch user databases, configuration, running services or providers. Use fresh temporary SQLite databases, a deterministic synthetic EPUB/TXT, the real Store/Engine and production FastAPI importer/library/collections routes through TestClient. Only adversarial stale-ID, duplicate-source, archive and content-revision boundary states may be seeded directly in those temporary databases and must be identified in the transcript. This is an actual API replay, not browser/device/PDF-engine or performance acceptance.

Create the replay script before source changes. Keep its bytes identical for before/after runs; capture all requests/responses, fixture operations, source hashes, database paths, checks and the first failing assertion in separate immutable run directories under `.runtime/v11-source-reimport-evidence-20261011/`. Never replace the baseline failure with the repaired result. Run only this targeted replay, not the full E2E suite or new post-implementation unit tests.

## Result

Assigned P2 repaired in `collections_source.py:239–244` with four added lines. When the saved local-ID attempt fails, `resolve` makes one fallback call through its existing `imported=True` stable-origin path. That path ignores the stale ID, retains the 32-candidate bound, checks source identity/content/visibility, and accepts exactly one reliable match. Valid local bindings retain their existing fast path. No snapshot or binding is written; no adoption/import contract changed.

Baseline and repeat both reproduced the same first failure: request 12, `GET /api/collections/1/source`, returned `available:false, doc_id:null` after identical EPUB reimport had created document 3. Both runs passed 32/43 checks and failed the same 11. Three hypotheses were checked against the replay: stale-ID short circuit, changed package fingerprint, changed anchors. The valid-current-ID and null-ID controls resolved correctly, distinguishing the stale-ID short circuit from the other two. The source repair then passed **43/43 checks** using the identical pre-fix replay script. Each of 20 source GETs left the complete temporary database logical digest unchanged.

The primary trigger uses actual production importer/library/collections API routes, including real deterministic EPUB parsing and real Engine/Store persistence. Duplicate-source, recycled-number, archive and revision boundaries are explicitly labelled synthetic fixture writes in the transcript. This does not claim browser/device acceptance, real OCR/model quality, PDF lifecycle acceptance, or measured reading performance. Only the assigned source module changed among the dependencies fingerprinted in the before/after run manifests. Other agents have since continued editing the shared checkout; these results apply to the captured dependency hashes, not an unverified later integration state.

## Preserved evidence and reproduction

Repository root: `/Users/fish/projects/Personal/APP/wise_reader`.

- Evidence root: `.runtime/v11-source-reimport-evidence-20261011/` (ignored local evidence, preserved; not a committed test module).
- Original failing run: `before-zygakusi/`; deterministic repeat: `before-repeat-1r4e7twl/`; repaired run: `repaired-tc_dm2lz/`.
- Each run retains `manifest.json`, full `transcript.jsonl`, raw request/response files, synthetic EPUBs, `temporary-user.db`, resolver source copy, `summary.json` and `sha256.json`. First failures are separately retained in each baseline's `first-failure.json`. All 215 listed artifact hashes verified after the repaired run.
- Portable bundle: [source-reimport-api-evidence.tar.gz](../../.runtime/v11-source-reimport-evidence-20261011/source-reimport-api-evidence.tar.gz), 161978 bytes, SHA-256 `a5c886cb55406622ceb0d0b8e2545f4b631af2a95c4ea212cdc8f0f5e6eb5733`.

Run from the repository root; each invocation creates a new run directory and database, never overwriting earlier evidence:

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src .venv/bin/python .runtime/v11-source-reimport-evidence-20261011/replay.py --label reproduction
```

The recorded commands used labels `before`, `before-repeat`, and `repaired`. No new test code was written after the repair; no full E2E suite, existing service, user settings, formal database, provider, commit or deployment was used.

| Preserved object | SHA-256 |
| --- | --- |
| Pre-fix replay script, unchanged for repaired run | `3bfe60a7f9c4e9648098120b7a4eda2e1486f8980fad440339c5b4afc95fc38b` |
| Original first failure | `fe920de76c81e5b690aa084ee3274795d3313a239ff480a3a79eacf599b40ca1` |
| Resolver before repair | `003e1594bf362695abea7b501b7c77f65ca3e0c6adab13f56acf71327cf5dd98` |
| Resolver after repair | `3e31b324d54ff7ec3911a1b37e1f3298cacbf1f3a4e01e8d4393e714d24c80b7` |
| Original Spec review, unchanged | `953e5608e18004c5040ebe749927f5c97373ac775f4d65f8826d832fe7595389` |

No integration action is required from Epicurus for this fallback. Keep its verified binding/adoption changes separate; the resolver still returns a snapshot or `None` without mutating the saved record. Main should include the fallback in the final integrated walkthrough.
