---
name: correct
description: "Find the mistakes agents keep repeating in this repo and make each one impossible. Try architecture first, then types/lint, then behavioral tests, and write docs last. Prove each check fails on a real past mistake and keep the AGENTS.md rule table clean."
---

# Correct

When agents keep making the same mistake in this repository, change the repository so the next agent cannot repeat it.

Assume every contributor is an agent that sees only the files it opened, copies the nearest example, and takes the shortest path that works. Design the repository so a change that looks right from one file is right for the whole repo.

## Find the mistake classes

Read recent commits, reverts, review feedback, `AGENTS.md`, and comments that explain workarounds. Group recurring mistakes into classes. A class counts once it has happened twice (or when the user explicitly corrects a pattern).

## Fix each class at the highest level that works

1. **Eliminate it with architecture.** Give each piece of state one owner and each task one supported way. Hide internals so wrong imports or cross-layer shortcuts fail. Replace hand-synced lists with one source of truth. Delete old paths and dead code an agent would copy.
2. **Enforce it with types, lint, or scripts.** If bad code still runs, add a static check, type constraint, or repo script whose error names the file, type, or function to use instead. If a legacy pattern is already widespread, fail when a change adds new occurrences.
3. **Test the behavior.** Pin the observable contract with a focused test. Fix or delete any test that still passes when the behavior breaks, or that fails when only internals change.
4. **Write docs or agent rules last, only for judgment calls.** Rules without enforcement are only reminders; nothing mechanically stops an agent from skipping prose.

## Fix and prove

Fix the most frequent mistake classes in small, focused commits. Prove each new check fails on a real past mistake before keeping it. Run the same check locally. Any temporary exception belongs on the offending line with a reason, an expiry date, and explicit user approval.

## Keep the rule table in `AGENTS.md`

Maintain the `Rules ↔ Enforcers` table in `AGENTS.md` pairing each active rule with what enforces it. When corrected by the user, fix the mistake and update the table. If a rule was already listed and nothing enforced it, that is a repeat—promote the fix to a higher level in the same change. Drop a rule from `AGENTS.md` once architecture or tooling makes the mistake impossible.

**Reply with:** each mistake class and its evidence, the enforcement level chosen, and why a higher level was not practical (if below level 1).
