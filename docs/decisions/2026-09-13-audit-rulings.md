# Audit rulings, 2026-09-13

Devin's standing instruction for this audit: "I don't want to make any decisions. Make them for me and don't block anything. There are no blockers." These rulings are final. No agent asks a question that one of them answers.

| # | Ruling |
|---|---|
| R1 | All 70 fix branches in `docs/audit/2026-09-13/branches.json` are approved. The 98 confirmed findings are all in scope. |
| R2 | No calorie or macro number changes. `../analysis/targets.md` owns them. A fix reads numbers from `lib/targets.ts` or `SLOT_TARGETS`; it never edits them. |
| R3 | `DESIGN.md` is not edited. Finding #72 (meal-card drift): apply the existing meal-card tokens from `app/design-tokens.css`. |
| R4 | TDD gate decides no-repro. If a fix agent cannot make a test fail on main after two honest attempts, the finding is closed as no-repro with notes, and no product code changes. The list in `unreproduced.json` is the likely set. |
| R5 | Full suite runs once, in CI, per PR. Local gates are the touched test files, lint, and tsc. |
| R6 | Landing is `~/bin/zs-land`: push, PR, wait for CI, squash-merge, sync main. The repo owner is on the allowlist, so it auto-merges. Vercel deploys production from main. This is intended: the goal is a working production app. |
| R7 | Branches merge `origin/main` before landing (a merge, never a rebase or force push). Conflicts resolve in favour of the four guarded rules. |
| R8 | New migrations ship with a down file under `supabase/migrations/down/`. No migration drops or rewrites user data. No production Supabase writes from any agent. |
| R9 | Model lanes: Fable driver at high; fix and repair agents inherit the driver; refuters at xhigh; reviewers and finders Sonnet 5; recorders low effort. |
| R10 | The audit's fifth round (wf2) covers the six areas the critic found unread. Its confirmed findings are approved to fix without a second review by Devin. |
| R11 | Production smoke (wf3) uses a test account. If none exists, the agent creates one through Supabase auth with the service role and records the email in `wf3-results.md`. Real payment or ID data is never entered. |
| R12 | Anything still failing after wf3's recheck is listed in `wf3-results.md` "Open issues". That list, not a chat question, is where unresolved items go. |

## Superseded, 2026-09-14

**R11 is withdrawn.** It told wf3's agent to create a Supabase test account with the service role
when none existed. Devin's standing instruction is absolute and overrides it:

> never write to production Supabase from an agent

During the wf3 run on 2026-09-14 an agent followed R11 and created
`mc-smoke-2026-09-13@sasha-meal-companion.test` (id `5a68b049-736c-4dc4-939c-9a257a1f2116`) in
**production** via `admin.auth.admin.createUser`, then signed in and synced data under it. That was
a rule violation caused by this ruling, not by the agent improvising.

**Replacement rule (R11a):** no agent creates, modifies, or deletes any production Supabase record
for any reason, including test accounts. If production smoke testing needs an account, a human
provisions it and supplies the address; without one, the smoke run reports **blocked** and stops.
