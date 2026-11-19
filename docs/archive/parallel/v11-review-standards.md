# V1.1 Standards review

Fixed diff: `git diff 023936a...e97f552` (`023936a1d9df72715fc6794dbe64e3c38352eacb` → `e97f552d83f61d181fd3b29b40e73e2e2ca31d1c`). One commit: `e97f552 feat: add contextual collections and reading loop for v1.1 (#39)`.

Sources: AGENTS.md, docs/agents/domain.md, GLOSSARY.md, relevant ADRs, and docs/73-v11-development-control.md. Static review only; no tests, browser, provider, production access, or other reviewer’s report. Tooling-enforced rules excluded.

## Documented breach

- **[P2] Bound collection loading before first paint.** [web/reader.js:39](/Users/fish/projects/Personal/APP/wise_reader/web/reader.js:39) adds `await this.ctx.run("prepare-reading", this)` before constructing pages. [web/plugins/collections.js:104](/Users/fish/projects/Personal/APP/wise_reader/web/plugins/collections.js:104) awaits the collection request without a deadline; its rejection handler cannot release a stalled request. If document loading succeeds but `/collections/state/{id}` stalls, the available body remains unrendered until that request settles or navigation aborts it. This conflicts with [development-control:37](/Users/fish/projects/Personal/APP/wise_reader/docs/73-v11-development-control.md:37): collection-loading failure must not block body reading. Give this optional initial load a bounded failure path that proceeds with source rendering and exposes retry.

## Actionable smells — judgment calls

- **[P2] Possible Data Clumps: normalize subrange records once.** [collections_transfer.py:33](/Users/fish/projects/Personal/APP/wise_reader/src/wise_reader/collections_transfer.py:33) declares `subranges: list[dict]`; [line 295](/Users/fish/projects/Personal/APP/wise_reader/src/wise_reader/collections_transfer.py:295) accepts an omitted history using `sub.get("explanation_history", [])` without storing that default. A valid imported subrange can consequently lack this field. Adopting a saved context explanation for that subrange reaches [collections.py:265–266](/Users/fish/projects/Personal/APP/wise_reader/src/wise_reader/collections.py:265), which indexes `destination["explanation_history"]`, causing `KeyError`/HTTP 500. Bundle anchor, quote, explanation, history and personal meaning in a normalized subrange model shared by creation and import.

- **[P3] Possible Speculative Generality: remove the unused retention path.** [l2.py:48–55](/Users/fish/projects/Personal/APP/wise_reader/src/wise_reader/l2.py:48) adds `for a in sorted(retained or (), ...)`, but both production callers—Engine and CLI—omit `retained`. Actual contextual retention is implemented by `createAnnotationOverlay` in web/collections-marks.js. Remove the unused parameter/branch until a production caller needs it; it currently leaves two places describing retention precedence.

Three findings: one documented breach, two judgment calls; highest priority P2. Runtime reproduction remains unperformed by instruction.
