# Issue tracker: GitHub

Specs and tickets for Wise Reader live in GitHub Issues at https://github.com/Coraia/EasySink. Use the `gh` CLI and explicitly select repository `Coraia/EasySink`.

## Conventions

- Create one issue per spec or approved ticket. Write the exact multiline body to a UTF-8 file and use `gh issue create --repo Coraia/EasySink --title "..." --body-file <body-file> --label ready-for-agent`.
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
