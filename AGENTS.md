# Wise Reader agent instructions

## Testing

- Never write unit tests after writing code.
- Prefer direct browser end-to-end walkthroughs and measured performance to new test code, per the user's 2026-10-08 instruction. Preserve reproducible steps, screenshots, raw measurements and the first failure. Distinguish real engine/device evidence from simulated states.
- If you must test a system in isolation, first document all the ways it could fail, then write the code.
- Do not run the full E2E suite during development. Final acceptance is a complete walkthrough; reuse targeted existing checks only where they add evidence.

## Parallel PDF development

Before PDF implementation or integration, read `docs/59-pdf-development-control.md` for current ownership, interface contracts and acceptance gates. Work only in the assigned files in the shared checkout.

## Agent skills

### Issue tracker

For specs, tickets and issue operations, use Coraia/EasySink GitHub Issues. Read `docs/agents/issue-tracker.md` before publishing or updating issues.

### Domain docs

Single-context: root `GLOSSARY.md` and `docs/adr/`. Read `docs/agents/domain.md` before exploring or proposing changes.
