# Issue tracker: GitHub

Specs and tickets for Wise Reader live in GitHub Issues at https://github.com/Coraia/EasySink. Use the `gh` CLI and explicitly select repository `Coraia/EasySink`.

## Conventions

- For `to-spec` and `to-tickets`, create one issue per spec or approved development ticket. Write the exact multiline body to a UTF-8 file and use `gh issue create --repo Coraia/EasySink --title "..." --body-file <body-file> --label ready-for-agent`. Wayfinder decisions use the labels in **Wayfinding operations** instead.
- Read an issue and its comments with `gh issue view <number> --repo Coraia/EasySink --json number,title,body,labels,comments` before continuing existing work.
- List issues with appropriate state/label filters. Check for an existing matching spec or ticket before creating a duplicate.
- Read back title, full body and labels after publication. Keep the returned issue number and URL in the relevant local handoff record.
- `to-spec` and `to-tickets` publish with `ready-for-agent`. Create this label if missing when performing an authorized publication. No five-role triage mapping is configured because the `triage` skill is not installed.
- For tickets from a spec issue, use the tracker's native sub-issue relationship when available. Otherwise include `Part of #<parent>` in each child. Publish blockers before dependants; use native blocking relationships when available, otherwise explicit `Blocked by` issue references.
- Follow the invoked skill's confirmation steps. Ticket granularity and blocking edges require user approval before publishing tickets. Creating child tickets does not authorize closing or modifying the parent.
- Use body files for authorized comments and updates as well. This configuration alone does not authorize contacting other people or arbitrary issue changes.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Publishing and fetching

When a skill says “publish to the issue tracker”, create a GitHub issue in Coraia/EasySink. When it says “fetch the relevant ticket”, read that issue's full body and comments through `gh`.

Keep private source documents, local sample paths, access tokens and raw paid responses in local evidence rather than public issue bodies. Public reports describe the acceptance scope and link to permitted artifacts.

## Wayfinding operations

When charting or continuing a Wayfinder map, use GitHub Issues in this repository. A planning map does not authorize implementation or change existing release acceptance.

- **Map**: one issue labelled only `wayfinder:map`, with Destination, Notes, Decisions so far, Not yet specified and Out of scope. Open decisions live in its native sub-issues, not a duplicated list in the map body.
- **Decision ticket**: one child issue labelled only `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling` or `wayfinder:task`. Its body states the question; the answer is a resolution comment. Refer to issues by linked title in human-facing text.
- **Publication**: present ticket granularity and blocking edges for approval under the existing convention. Create all approved issues first, then wire native sub-issue and dependency relationships using their real identifiers. Read back bodies, labels, parents and edges; store the publication manifest with the local handoff.
- **Sub-issues**: attach an existing issue with `gh issue edit <map-number> --repo Coraia/EasySink --add-sub-issue <child-number>`. The REST equivalent is `POST repos/Coraia/EasySink/issues/<map-number>/sub_issues` with numeric `sub_issue_id` from the child's `.id`.
- **Blocking**: use `POST repos/Coraia/EasySink/issues/<child-number>/dependencies/blocked_by` with `issue_id` equal to the blocker's numeric database `.id`, not its issue number or GraphQL node ID. Read back via the same endpoint with GET. Native sub-issues and dependencies were read successfully in this repository on 2026-10-09; use them unless a later capability check proves unavailable.
- **Frontier**: GET the map's `sub_issues` with pagination; retain open, unassigned children whose `issue_dependencies_summary.blocked_by` is zero. Verify blocker states through `dependencies/blocked_by` if the summary is absent. Respect native sub-issue order when selecting the next ticket.
- **Claim**: before working a ticket, assign it to the driving dev with `gh issue edit <number> --repo Coraia/EasySink --add-assignee @me`; reread the issue to detect concurrent claims.
- **Resolve**: publish the answer with `gh issue comment <number> --repo Coraia/EasySink --body-file <file>`, close the decision, then reread the map and append only its linked title and a one-line gist to Decisions so far. Preserve concurrent edits. Charting creates the map; it does not hand-resolve decision tickets. Resolve at most one non-research ticket per later session.
- **Research**: claim research children before delegating them. Keep permitted findings on separate, disposable research branches with a context pointer from the ticket; push without a PR or merge. Keep private books, raw responses and credentials local. Human-in-the-loop tickets require the user's actual response or prototype acceptance.
- **Fallback**: only if native relationships become unavailable, record the capability failure, use a map task list plus `Part of` on each child, and explicit `Blocked by` references. Never mix an available native dependency graph with a competing body-only graph.
