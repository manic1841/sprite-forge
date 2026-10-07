# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

Repository: `manic1841/sprite-forge` (inferred automatically by `gh` inside a clone).

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a body file for multi-line
  bodies.
- **Read an issue**: `gh issue view <number> --json number,title,body,labels,assignees,state`.
- **List issues**: `gh issue list --state open --json number,title,body,labels,assignees`.
- **Comment on an issue**: `gh issue comment <number> --body "..."`.
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`.
- **Close**: `gh issue close <number> --comment "..."`.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number>`.

## Wayfinding operations

Used by `/wayfinder`.

- **Map**: the single issue labelled `wayfinder:map` (#1). It holds the Notes / Decisions-so-far /
  Fog / Out-of-scope body.
- **Child ticket**: an issue carrying a `wayfinder:<type>` label (`research` / `prototype` /
  `grilling` / `task`), with `Part of #<map>` at the top of its body. **Sub-issues:** this repo's
  `gh` is v2.23, which lacks `--parent` / `--add-sub-issue`; children are therefore linked through
  the task list in the map's **Tickets** section (and `Part of #1` in each child). A newer `gh`
  (`2.94+`) can promote the list to real sub-issues later.
- **Blocking**: GitHub **native issue dependencies** (verified working on this repo). Add an edge:

  ```
  gh api --method POST repos/manic1841/sprite-forge/issues/<child>/dependencies/blocked_by \
    -F issue_id=<blocker-db-id>
  ```

  where `<blocker-db-id>` is the blocker's numeric **database id**
  (`gh api repos/manic1841/sprite-forge/issues/<n> --jq .id`, not the `#number`). A `Blocked by:`
  line is also written at the top of each child body as a readable fallback.
- **Frontier query**: open children with `issue_dependencies_summary.blocked_by == 0`, no assignee,
  not closed; first in map order wins.

  ```
  for n in <child numbers>; do
    gh api repos/manic1841/sprite-forge/issues/$n \
      --jq '"\(.number) \(.state) blocked_by=\(.issue_dependencies_summary.blocked_by) assignee=\(.assignee.login // "-")"'
  done
  ```
- **Claim**: `gh issue edit <n> --add-assignee @me` — the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a
  context pointer (gist + link) to the map's **Decisions so far** in issue #1.
