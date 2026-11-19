# Domain docs

Wise Reader uses a single context: root `GLOSSARY.md` for domain language and root `docs/adr/` for accepted decisions.

## Before exploring or proposing changes

- Read `GLOSSARY.md`; use its canonical terms in specs, tickets, hypotheses and acceptance scenarios.
- Read the ADRs relevant to the work. Surface conflicts explicitly rather than silently overriding an accepted decision.
- If domain documents are absent, proceed silently; use domain-modeling to create them only when concepts or decisions are resolved.

## Document roles

- The glossary contains domain definitions, without implementation details, metrics, plans or unresolved proposals.
- ADRs record consequential accepted tradeoffs. Product specs, development contracts and acceptance plans carry requirements and implementation details separately.
- Add or refine resolved terms through domain-modeling. Keep project-specific definitions and decisions in this repository when shared skills are updated.
