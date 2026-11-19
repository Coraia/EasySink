---
name: refactor
description: Safe, subtraction-first refactoring workflow for EasySink. Pin behavior first, simplify the domain model, delete dead code and legacy paths in one wave, fix root causes rather than adding guards, and verify unchanged behavior.
---

# Refactoring Workflow

**Structure changes; intended behavior does not.** Keep structural refactors distinct from new features or unrelated behavior changes. If a cleanup uncovers a real bug or missing capability, isolate the bug fix or ship the structural simplification against a pinned contract first.

## Workflow

1. **Pin the behavior contract first.**
   - Trace the subsystem and its cross-boundary consumers (`blast-radius`).
   - Before moving code or deleting defensive paths, ensure a focused `pytest` or Playwright characterization test pins the observable behavior. Type/syntax checks alone are not a behavior pin.
2. **Model the domain and name the target shape.**
   - Replace scattered booleans, stacked `epoch`/`generation`/`revision` counters, or multi-file shape assumptions with one explicit structure (e.g., a single state machine + `AbortController`, a typed Pydantic/dataclass model, or a direct table/mapping).
   - Keep boring local code boring; distrust abstractions that add layers without deleting branches or invalid states.
3. **Subtract before you add.**
   - Delete dead code, unused branches, one-caller pass-through wrappers, speculative validators, and redundant readback checks *before* introducing the cleaner shape.
   - Make the smallest structural move that reaches the target design. Revert speculative cleanups that do not pay for themselves.
4. **Migrate callers and delete legacy APIs in the same wave.**
   - Update every caller and delete the old API/path together. Do not leave compatibility shims or parallel old-and-new code paths.
   - Verify non-symbol references manually: strings, JSON keys, SQL columns, DOM selectors, `data-*` attributes, and Swift/JS bridge names.
5. **Fix root causes, never mask symptoms.**
   - Validate external inputs at boundaries; inside trusted boundaries, do not hide invalid states with defensive guards, retries, clamped values, or swallowed `except Exception` / `catch {}`. A guard is only a fix when the state it handles is genuinely legitimate.
6. **Minimize reader load.**
   - Collapse indirection and shrink mutable scope (locals over object fields, derived values over synchronized copies, globals avoided).
   - Test: can a new reader answer *"where does X come from?"* and *"what can change X?"* in under 30 seconds? If not, cut layers or state.
7. **Prove behavior unchanged in small verifiable steps.**
   - Run the pinned tests (and an equivalence script or browser smoke when reshaping serialization/layout/paging) after each step.
   - Keep commits small and ordered (subtraction → reshape → cleanup), each passing its checks.

**Summary:** state what structure changed, the pin/tests that held behavior steady, what complexity/code was deleted, and what verification ran.
