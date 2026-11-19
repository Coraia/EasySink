---
name: blast-radius
description: "Find what a change could break somewhere else before it ships, beyond what grep shows, and prove the key safety invariant by running real code. Use before cross-boundary refactors or when reviewing risky diffs."
---

# Blast Radius

Find what a change could break outside its immediate diff before it ships. Run this before designing a refactor when a plan asserts something about existing callers or implicit contracts.

Listing direct callers is not the job—grep finds those in a second. The job is finding the breakage grep misses across language, storage, network, and UI boundaries.

## Do not trust your own writeup

A persuasive writeup can sound right even when it is wrong. Find the one or two facts the change's safety depends on, and prove them by running real code.

### Proof Ladder

Push each critical safety fact as far down this list as is cheap, and state explicitly where verification stopped:

1. You asserted it from reading the diff (weakest—insufficient on its own).
2. You cited the exact `file:line` or dependency source.
3. You traced the failure mode step by step and showed why it cannot reach.
4. You ran a real script or focused test importing the actual module/bundle and failing loudly if wrong.
5. You reproduced and verified it in the running app / browser / macOS build.

## Steps

1. **Read the change.** Inspect the branch diff and commits: what symbols, data shapes, timings, or side effects changed, including what the diff omits.
2. **Find the one fact it is safe because of.** Most changes that look risky depend on one central invariant (e.g., "every caller passes UTF-16 block offsets normalized at the API boundary"). Spend effort proving or falsifying that invariant rather than listing vague maybes.
3. **Look where grep stops.** Trace cross-boundary contracts grep cannot see:
   - FastAPI JSON request/response payloads and status codes
   - SQLite schema, columns, migrations, WAL assumptions, and `user.db` / `user-pdf/registry.sqlite3` coupling
   - Frontend UTF-16 code units vs. backend Python code points in source anchors
   - Swift `AppKit` / `WKWebView` / `ReadingStorage` / `NativeTrackpad` JS bridges and `localStorage` keys
   - CSS/DOM selectors, `data-*` attributes, microtask/rAF/teardown ordering
4. **Assess risks honestly.** Separate confirmed or unverified risks (with `file:line`, likelihood, impact, and how to check) from paths you checked and cleared. Cite real locations; never invent a caller or API.
5. **Prove the key fact.** Write and run a small `pytest`, Python probe, or Playwright check against the real code and record the observed result.

## What to Return

- **What it does:** Summary of the change, including non-obvious behavioral effects.
- **The one fact it is safe because of:** State the invariant, the proof-ladder level reached, and the exact command/output (or mark **unproven**).
- **Risks:** Concrete failure paths with `file:line`, likelihood/cost, and verification output.
- **Cleared:** Adjacent paths checked and why they are unaffected.
- **Before merging:** The cheapest test or repro that catches the real failure mode.
