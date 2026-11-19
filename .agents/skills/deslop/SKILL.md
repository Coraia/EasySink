---
name: deslop
description: Remove AI-generated code slop, unnecessary defensive checks, swallowed exceptions, and redundant comments from branch diffs and uncommitted changes.
---

# Remove AI Code Slop

Check the diff against the branch base (typically `main`) plus any uncommitted changes, and strip AI-generated slop introduced in the change.

## Focus Areas

- Extra comments that narrate obvious code, restate the diff, or clash with local style
- Abnormal defensive checks on trusted internal paths: redundant `isinstance`, repetitive `.get(default)` / `?.` on guaranteed shapes, write-then-readback self-verification inside the same transaction, or broad `try/except Exception` / `catch {}` blocks that swallow failures into fake success or `"unknown"` states
- Unnecessary type casts or escape hatches used only to paper over a broken contract
- Deeply nested conditionals that should be flattened with early returns
- One-off helpers or patterns inconsistent with the surrounding codebase

## Guardrails

- Keep intended behavior unchanged unless removing an obvious bug or silent error swallow.
- Prefer minimal, focused edits over broad unrelated rewrites.
- Preserve boundary validation (HTTP/Pydantic inputs, file/HTML/URL/PDF parsers, external AI/OCR responses, DB migrations, `InstanceLock`, and flavor/library isolation).
- After editing, rerun the checks that verify the change (`pytest`, syntax/type checks, and targeted Playwright specs for UI work) and report their results.
- Revert any edit whose check fails.
- Keep the final summary concise (1–3 sentences).
