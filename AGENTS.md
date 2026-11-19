# EasySink (Wise Reader) Agent Instructions

## Project Context

- Local-first English reading app for Chinese readers (Web + macOS AppKit/WKWebView client).
- Product name: **EasySink** (Python package remains `wise_reader`).
- `main` is the single source of truth. Do not maintain long-lived `.patch` overlays or parallel dirty checkouts.
- Canonical domain concepts live in `GLOSSARY.md` and accepted tradeoffs in `docs/adr/`. Read relevant entries before changing domain behavior; do not silently redefine canonical terms.

## Engineering Principles (Anti-Bloat)

- **Validate at boundaries, trust internal invariants.**
  - Validate untrusted inputs at external boundaries only: HTTP/CLI inputs (via Pydantic), imported files/HTML (EPUB/PDF/URL), external AI/OCR/network responses, and DB migrations.
  - Inside the application, trust validated types, internal callers, and SQLite transactions. Do **not** re-parse JSON you just serialized, re-tokenize text you just parsed, re-read SQLite rows inside the same transaction to verify an `INSERT`/`UPDATE`, or repeat `isinstance`/schema checks across internal layers.
- **Fail visibly, never swallow errors.**
  - Do not catch broad `except Exception` (or empty `catch {}`) only to return fake success, invent ambiguous `"unknown"` states, or silently degrade core behavior. Let unexpected bugs surface to the central error handler and logs.
- **One state machine, one cancellation mechanism.**
  - Manage frontend async interactions (paging, reflow, word card, navigation) through explicit state transitions and `AbortController`. Do not patch race conditions by stacking additional `epoch` / `generation` / `revision` counters or boolean flags.
- **Keep workflow governance out of product code.**
  - Do not embed agent-safety gates (disk/RAM/CPU preflights, A/B work slots, PID verification, diagnostic marker files, or read-only `chmod` seals) into product runtime code or default build scripts.
- **Keep production packages clean.**
  - Never put smoke tests, diagnostic harnesses, or throwaway prototypes inside `src/wise_reader/` or ship them in production `web/` bundles. Tests live under `tests/`; standalone dev helpers live under `scripts/`.

## Fixing Repeated Mistakes (Escalation Ladder)

When the same mistake happens twice (or the user corrects a pattern), do not merely patch the symptom or append more prose. Fix it at the highest level that works (see `.agents/skills/correct/SKILL.md`):

1. **Architecture:** Give state one owner and each task one supported path; delete legacy/dead code so agents cannot copy bad patterns.
2. **Types / Lint / Scripts:** Make invalid states unrepresentable or catch them mechanically with an error that names the right API.
3. **Behavioral tests:** Pin the observable contract with a focused test that fails if the bug returns.
4. **Docs / Rules (last resort):** Only for judgment calls. Once a higher level prevents the mistake, delete the rule from the table below.

### Rules ↔ Enforcers

| Rule | Enforced by |
| --- | --- |
| Never touch personal Formal/Preview libraries in tests | `tests/conftest.py`, `scripts/test_server.py`, flavor bundle/root isolation |
| Never commit local DBs, `.env`, secrets, or build artifacts | `.gitignore` |
| Source anchors use UTF-16 on web ↔ Python code points on backend | `tests/test_tokenize.py`, `collections_smoke` (to move into `tests/`) |
| No unnecessary defensive code or swallowed exceptions | Review + `.agents/skills/deslop`, `.agents/skills/code-quality-review` (promote recurring patterns to lint/tests) |
| Frontend async paging/reflow uses one state machine + `AbortController` | Planned Step 4 refactor + Playwright regression net |

## Data & Product Safety Invariants

- **Never touch personal reading data in tests.** Formal (`~/Library/Application Support/EasySink Candidate`), Preview, and any installed `/Applications/EasySink.app` are off-limits to automated tests. Always use isolated temp directories (`tests/conftest.py`, `scripts/test_server.py`, or `--data-dir` in non-production builds).
- **Never commit local data or secrets.** Keep `data/*.db*`, `.env`, API keys, copyrighted books, `.runtime/`, build bundles, and diagnostic dumps out of Git.
- **Preserve core reading invariants:**
  - Source anchors use UTF-16 code units on the frontend and are converted accurately to Python code points on the backend; page numbers are layout state, never persistent identity.
  - Preserve user notes, collections, and originals; keep `InstanceLock` and flavor/data-directory separation (`production` / `preview` / `diagnostic`).
  - Never trigger full-chapter/full-book paid AI or external OCR calls without explicit user action, and never echo API keys back to the frontend.

## Local Models (Workstation-Specific, Optional)

- If a machine-local guide exists at `~/OMARCHY-LOCAL-MODELS-GUIDE.md`, read it before switching or calling local GPU models (for dev/test L1 prompt regression or explicit local testing).
- Respect shared-GPU coexistence rules documented there, and never copy host IPs, MAC addresses, credentials, or unrelated machine services into this repository.

## Testing & Verification

- **Write small, high-value automated tests.**
  - Cover backend invariants (anchors, storage/migrations, parsers, API contracts) with focused `pytest` tests.
  - Cover core reading UI loops with targeted Playwright specs in `tests/browser/`.
- **Protect refactors with a regression net.** Before deleting defensive code or refactoring a subsystem, run the targeted tests covering it; if a critical path has no test, add a minimal regression test first.
- **Run targeted checks during development.** Run only the relevant `pytest` / Playwright specs while iterating; run the full suite before merging significant changes to `main`.
- **Keep verification concise.** Report what commands ran and whether they passed/failed. Do not generate sprawling SHA-256 manifests, redundant failure-model essays, or boilerplate disclaimer logs unless the user explicitly asks for a formal audit.
- **Be honest about verification boundaries.** Do not claim browser/synthetic tests prove physical macOS trackpad feel or notarized distribution; simply note what still requires manual check.

## Git, Docs & Scope

- Work on short-lived branches off `main`; keep commits focused and reviewable.
- Do not create new numbered history docs or duplicate status ledgers. Update existing live docs only when behavior or setup actually changes.
- Only interact with GitHub Issues (`Coraia/EasySink`) when explicitly asked by the user.
