# Audit fix plan, 2026-09-13

Goal: take Sasha's Meal Companion from audited to a working, finished production app that testers can use, with every feature exercised. Devin has delegated all decisions (see `docs/decisions/2026-09-13-audit-rulings.md`). This plan is written so a fresh session on a new account can execute it without questions.

## Inputs (all in `docs/audit/2026-09-13/`)

| File | What |
|---|---|
| `report.md` | The full audit: 98 confirmed findings with evidence, 38 refuted, coverage critic, fix order. |
| `findings-full.json` | Machine-readable findings with refuter votes. Fix agents read by `n`. |
| `branches.json` | 70 ordered fix branches: slug, findings, files, risk area, severity. |
| `gaps.json` | Six areas the critic found unread. Input to wf2. |
| `unreproduced.json` | Findings whose truth was never demonstrated at runtime. |
| `wf1-fix-and-land.js` | Workflow 1 script. |
| `wf2-gap-round.js` | Workflow 2 script. |
| `wf3-verify-production.js` | Workflow 3 script. |
| `HANDOFF.md` | Paste-ready prompt for the new session. |

## Steps

| Step | Action | Verify |
|---|---|---|
| 1 | New session, ultracode on, effort high, in the repo root. Confirm `git status` clean on main and `cswap status` shows a fresh seat. | Clean tree, main at or after commit that added `docs/audit/2026-09-13`. |
| 2 | Run wf1 with `args: {repo, only: []}`. 70 branches: each gets a worktree agent (failing test, fix, targeted tests, lint, tsc, commit, push), a reviewer (security-reviewer on server-auth and sync), one repair pass if blockers, then a land agent (merge main, targeted tests, zs-land). | `docs/audit/2026-09-13/wf1-results.md` lands on main. Count landed vs no-repro vs failed. |
| 3 | If wf1 reports failed or blocked branches, resume wf1 with `only: [<those orders>]` after reading the notes. Two resumes maximum; then leave the remainder for wf3's open-issues list. | Same results file updated. |
| 4 | Run wf2. Six gap finders, three refuters each, then fix and land every confirmed finding the same way. | `wf2-results.md` lands. |
| 5 | Run wf3 with `args: {repo, url}`. One local full gate on main (test, tsc, lint, build, each once), Vercel production deployment READY at origin/main, then 15 browser smoke features on production, a fix-and-land for each failure, and a recheck. | `wf3-results.md` lands with the smoke table; "Open issues" is empty or short. |
| 6 | Update `AGENTS.md` phase table: add row "Audit 2026-09-13: landed, wf1/wf2/wf3 results in docs/audit/2026-09-13". Land via a chore branch. | Row present on main. |
| 7 | Handoff note to `~/Inbox/notes/handoffs/` with the production URL, the test account email, and the open-issues list. | File exists. |

## Cost and time expectation

wf1 is the big one: about 70 fix agents at Fable high, 70 Sonnet reviews, some repairs, 70 land agents, and 70 CI runs (each is the full suite plus build). Expect several hours of wall clock, dominated by CI. Landing is parallel; conflicts on shared files (`lib/foods.ts`, `lib/sync/*`, `components/LogFoodSheet.tsx`) are resolved by the land agent's merge step.

## Rules that never change

The four guarded rules (no apple, gluten, dairy; Avoid never planned; protein never moves; every date renders). `../analysis/targets.md` owns every number. `DESIGN.md` is the design contract. `vercel --prod` is retired. Never the full suite twice locally.
