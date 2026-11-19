---
name: code-quality-review
description: Run a strict maintainability review focused on structural simplification ("code judo"), preventing giant files, eliminating spaghetti branching, and keeping boundaries clean.
---

# Code Quality Review

Use this skill for a strict implementation review focused on maintainability, abstraction quality, and structural simplicity.

Actively look for **code judo** moves: restructurings that preserve behavior while making the implementation dramatically smaller, simpler, and more direct—so entire branches, flags, wrappers, or compatibility layers disappear.

## Non-Negotiable Standards

0. **Be ambitious about structural simplification.**
   - Do not settle for cosmetic tweaks when a reframing deletes whole classes of branching, modes, or helper layers.
   - Prefer deleting complexity over rearranging it across files.
1. **Guard file-size boundaries (~1k lines).**
   - Flag changes that push a file from under 1,000 lines to over 1,000 lines (or pile more code onto an already oversized file) without clear decomposition.
2. **Block spaghetti growth.**
   - Treat ad-hoc `if` statements, scattered special cases, or stacked booleans/epochs inserted into unrelated flows as design defects, not stylistic nits.
   - Push stateful coordination into an explicit state machine, policy object, or focused module.
3. **Bias toward cleaning the design over "it works".**
   - Do not rubber-stamp messy code merely because tests pass; require the cleaner shape when the path is clear.
4. **Prefer direct, boring, legible code.**
   - Reject brittle "magic", thin one-caller wrappers, pass-through adapters, and indirection that adds layers without removing complexity.
5. **Keep boundaries and types explicit.**
   - Validate untrusted external data at boundaries once; question internal `isinstance`/optionality/silent-fallback defensive guards that obscure the true invariant.
6. **Keep logic in its canonical layer.**
   - Flag feature logic leaking into shared paths, test/smoke helpers inside `src/`, or workflow gates embedded in product/build scripts.
7. **Eliminate partial updates and fragile sequencing.**
   - Flag non-atomic state updates that leave data half-applied, or unnecessary sequential chains where a clean single transition belongs.

## Primary Review Questions

- Is there a code-judo move that makes whole branches, flags, or counters disappear?
- Does this reduce or increase the number of concepts and mutable states a reader must hold in their head?
- Is logic living in the canonical layer, and are existing helpers reused?
- Does this add unnecessary defensive checks, swallowed exceptions, or thin wrappers?
- Did a file grow past a healthy size boundary without decomposition?

## Approval Bar

Do not approve merely because behavior works. Block on:
- Clear structural regressions or spaghetti branching growth
- Missed obvious simplifications that leave high incidental complexity
- Unjustified file-size bloat or thin pass-through abstractions
- Silent fallbacks / swallowed errors / redundant internal guards obscuring real invariants
- Workflow/agent governance or test harnesses leaking into production code

## Report Format

Return **one concise, prioritized markdown review**:
1. **Verdict**: Approve or Request Changes, with a 2–3 sentence summary.
2. **Findings (ordered by structural impact)**: Cite exact `file:line`, describe the concrete structural issue and reader/maintenance cost, and propose the specific **code-judo** remedy. Skip trivial cosmetic nits when larger structural issues exist.
3. **Verification status**: Note what was run/verified vs. inferred from reading.
