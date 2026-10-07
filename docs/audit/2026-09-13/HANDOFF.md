# Handoff: run the audit fix plan

Paste the block below as the first message of a fresh Claude Code session (Fable 5.1, effort high) opened at the repo root. Check `cswap status` first so the seat has headroom; wf1 is several hours.

```
ultracode

Execute docs/plans/2026-09-13-audit-fix-plan.md for this repo end to end. All decisions are already made in docs/decisions/2026-09-13-audit-rulings.md; do not ask me anything, and treat every ruling there as final. There are no blockers.

Order:
1. Workflow({ scriptPath: "docs/audit/2026-09-13/wf1-fix-and-land.js", args: { repo: "<absolute repo path>", only: [] } })
   When it returns, read docs/audit/2026-09-13/wf1-results.md. If any branch is failed or blocked, resume wf1 once with only: [<those order numbers>] after reading the notes. Two resumes maximum.
2. Workflow({ scriptPath: "docs/audit/2026-09-13/wf2-gap-round.js", args: { repo: "<absolute repo path>" } })
3. Workflow({ scriptPath: "docs/audit/2026-09-13/wf3-verify-production.js", args: { repo: "<absolute repo path>", url: "" } })
   (leave url empty; the Deploy agent finds it via the Vercel MCP)
4. Add a row to the AGENTS.md phase table: "Audit 2026-09-13 | full audit and fix | landed, results in docs/audit/2026-09-13". Land it with ~/bin/zs-land on a chore branch.
5. Write ~/Inbox/notes/handoffs/<date>-meal-companion-done.md with the production URL, the test account email from wf3-results.md, and the open-issues list.

Size every workflow by the work, not the 15-agent guideline. If a workflow is stopped or the session is compacted, resume with resumeFromRunId rather than restarting. Report progress in a few lines after each workflow; no questions.
```

Replace `<absolute repo path>` with the output of `pwd` at the repo root.

## If something goes wrong

- A land agent reports zs-land exit 3: the PR merged but cleanup did not finish. Do not re-run zs-land for that branch. Run `git fetch --prune && git checkout main && git pull` and remove the leftover worktree with `git worktree remove <path> --force`.
- CI is red on many PRs for the same reason: stop, fix the cause on one chore branch, land it, then resume wf1 with `only` set to the affected orders.
- Merge conflicts the land agent cannot resolve: it reports failed; resume with `only` after landing the branches it conflicts with.
- The Vercel deployment is ERROR: wf3's Deploy phase reads the build log and fixes it on a branch. If it cannot, `docs/audit/2026-09-13/wf3-results.md` says why.
