# Phases 5 + 6 + 7 — terminal prompts (wave 4)

**Start condition:** `main` includes the wave-3 integration PR. Same launcher as wave 3:

```bash
cd ~/projects/clients/Sasha/meal-companion && git checkout main && git pull --ff-only
for L in P:p5-body-data Q:p6-estimator R:p7-coach; do n=${L%%:*}; b=${L##*:}; git worktree add ../meal-companion-$n -b feat/$b main; done
for n in P Q R; do (cd ../meal-companion-$n && pnpm install --frozen-lockfile && cp ../meal-companion/.env.local .env.local); done
for n in P Q R; do scripts/lane-terminal.sh $n docs/plans/2026-09-11-phase-5-7/prompts/$n.txt; done
```

## Terminal P — Body data (Phase 5)

```
ultracode. You are Lane P of Phases 5–7 (wave 4). Execute docs/plans/2026-09-11-phase-5-7/lane-P-body-data.md end to end with superpowers:subagent-driven-development. Read docs/plans/2026-09-11-phase-5-7/00-contracts.md first, then the Phase 0, 1–2 and 3–4 contracts it extends — all frozen; stop and report if a contract change is needed. Touch only Lane P's ownership row; app/api/mcp/route.ts, vercel.json, app/settings/page.tsx, app/page.tsx and components/TabBar.tsx are integration-stage files — put your register call, cron line and mount diffs in "Hand-off to integration". Writes to health_samples and ingest_events go only through the two security-definer RPCs on the privileged boundary; the ingest token is matched constant-time on its hash; no plaintext Oura or ingest token ever reaches a column (sealOauth before every write). Null is an absent observation — never 0, never interpolated on a screen. A second oura-pull for the same day must change no row; the content-hash test is a hard gate. The Oura app registration, HEALTH_TOKEN_KEY and OURA_* values are Devin's (never print them; code against the env names). TDD every task, conventional commits, no AI attribution. When the lane exit gate passes, run ~/bin/zs-land and post the PR link, then tell Devin what waits on him: the Oura app registration, the env values, and the phone setup from docs/health-auto-export.md.
```

## Terminal Q — Estimator (Phase 6)

```
ultracode. You are Lane Q of Phases 5–7 (wave 4). Execute docs/plans/2026-09-11-phase-5-7/lane-Q-estimator.md end to end with superpowers:subagent-driven-development. Read docs/plans/2026-09-11-phase-5-7/00-contracts.md first, then docs/architecture.md §3.4 and §4.3 and /Users/zero-suminc./projects/clients/Sasha/analysis/targets.md — the engine is transcribed from §4.3, never re-derived; every constant is a named export with a test that fails when it changes. Touch only Lane Q's ownership row — you are the only lane allowed to edit lib/sync/** this wave (pull-only entities, DB_VERSION 4; every existing sync test stays green). The engine never writes a target; protein never moves in a proposal; a floor is never lowered; burn-in ends on 21 qualified days, never on calendar time; approve_target_proposal is one transaction and a second approve returns 409. The three §4.3 backtests and the committed backtest table are hard gates. Lane P's toCanonical/weighInsKg may not have landed — code against the contract signatures with a test double and say so. TDD every task, conventional commits, no AI attribution. When the lane exit gate passes, run ~/bin/zs-land and post the PR link, then list the DECISION REQUIRED items from README.md that touch you (approver, thresholds, second proposal).
```

## Terminal R — Coach (Phase 7)

```
ultracode. You are Lane R of Phases 5–7 (wave 4). Execute docs/plans/2026-09-11-phase-5-7/lane-R-coach.md end to end with superpowers:subagent-driven-development. Read docs/plans/2026-09-11-phase-5-7/00-contracts.md first, then docs/architecture.md §4.4 and §4.5, then the Phase 0, 1–2 and 3–4 contracts — all frozen; stop and report if a contract change is needed. Touch only Lane R's ownership row (lib/server/privileged.ts: the scope union only). Three invariants are hard gates with named tests: dispatch is a switch over the static REGISTRY (never dynamic property access); every executor takes userId first and no schema has a user or URL field; draft_log_entry writes nothing — the only path to a log entry is the capture sheet's commit. Every retrieved string enters the prompt inside the untrusted envelope; the policy runs after the model and before render via lib/policy/constraints.ts (never a second policy implementation); the medical deflection is byte-identical with zero model calls; avoid_allergens never drops below gluten, dairy, apple. Until docs/ai-data-handling.md records the Nous retention answer, gut/condition notes never reach a model and every turn runs on Gemini. The corpus (≥ 40 cases) runs against the stub in CI; the live canary runs once outside CI and its table goes on the PR. Lane Q's latestEstimate/activeTargets may not have landed — executors take ports with test doubles. Style with app/globals.css utilities and DESIGN.md tokens; no new colours, no new dependencies. TDD every task, conventional commits, no AI attribution. When the lane exit gate passes, run ~/bin/zs-land and post the PR link with the canary table.
```

## Watcher terminal (main checkout)

```
You are the wave-4 watcher for Sasha's Meal Companion — three builder lanes P, Q, R in worktrees ../meal-companion-{P,Q,R}. Use the watcher-orchestration skill exactly. Read docs/plans/2026-09-11-phase-5-7/ (README.md = stages and gates, 00-contracts.md = frozen interfaces, lane-*.md = task lists, terminal-prompts.md = what each builder was told).

SINGLE-WRITER CONTRACT: builders own their worktrees, pushes and landings. You never edit a file under a builder worktree, never push their branches, never run zs-land for them. Pre-build only in isolated clones under the scratchpad (git clone --local, branch from the builder's exact head sha), deliver git format-patch series + NOTES.md to ~/Inbox/notes/sasha-wave4-patches/<lane>/, and SendMessage the builder before starting so nothing is built twice.

LOOP: session cron every 10 minutes (3,13,23,33,43,53 * * * *) running `bash scripts/watch-lanes.sh P Q R` from this checkout plus ListAgents; HEALTHY / STALLED / DEAD / CI / MERGED / CONTEXT / MACHINE rules exactly as the wave-3 watcher prompt in docs/plans/2026-09-11-phase-3-4/prompts/watcher.txt (restart line: `scripts/lane-terminal.sh <X> docs/plans/2026-09-11-phase-5-7/prompts/<X>.txt`).

WAVE-4 SPECIFICS: landing order P, Q, R — never block a green lane. Lane Q is the only lane allowed to touch lib/sync/**; Lane R the only one allowed to touch lib/server/privileged.ts (scope union only). Hard gates that never land red: P's oura-pull content-hash test and no-plaintext-token test; Q's three §4.3 backtests and the one-transaction approve test; R's registry/invariant tests and the ≥ 40-case corpus. The coach live canary and the Oura PKCE canary run outside CI — nudge the builder to attach the table to the PR, never run them yourself against production keys. DECISION REQUIRED items (README "Decisions Devin owes") surface to Devin the tick they appear; never answer them yourself; the Nous retention record and the Oura app registration are the two most likely to block. Supabase branches cost $0.013/hour. Pre-build candidates: R's injection corpus expansion, Q's expenditure fixtures, P's HAE recipe doc. Claim first. When P, Q and R are all MERGED: push-notify Devin and start the integration prompt from terminal-prompts.md in THIS session, watching it as a builder. COMPLETE = integration branch MERGED and Devin has the setup checklist plus the decision list; then push-notify a summary and delete the cron.

First tick now: run the probe, report one line per lane, arm the cron, confirm caffeinate.
```

## After P, Q, R land — integration (Stage 2)

```
ultracode. Lanes P, Q and R of wave 4 have landed on main. Create branch feat/p5-7-integration and execute docs/plans/2026-09-11-phase-5-7/00-contracts.md §8 in order: (1) restructure app/api/mcp/route.ts so the handler is built per request inside withTokenUser and tool bodies receive { userId, admin } (remove the SASHA_USER_ID pin), call registerHealthTools, registerExpenditureTools and registerCoachTools, and merge their scope maps into scopeForBody; keep every tests/mcp test green and add a test per new tool for cross-user denial. (2) Add the four cron lines from the lanes' hand-offs to vercel.json next to media-sweep. (3) Apply the mount diffs: Settings (Body-data row + HealthSourcesSheet, EstimatorCard, TargetModeSheet entry, WeightTrend, ConstraintsEditor), Today (ProposalCard, weight chip), TabBar (Coach tab, five columns, 44 px targets); add flag-off regression tests proving unset flags leave every screen as wave 3 left it. (4) Supabase branch: migrations 20260925–20261006, pnpm test:integration with the three suites; run the Oura PKCE canary and record the result in docs/architecture.md §5.2; run scripts/coach-injection-canary.ts and attach its table. (5) Push, Vercel preview, and hand Devin the setup checklist: issue an ingest token, install docs/health-auto-export.md, connect Oura, then seven days before the Phase 5 gate; ESTIMATOR_ENABLED on with the UI off for a week; COACH_ENABLED after the canary. (6) After his OK, ~/bin/zs-land and delete the Supabase branch; remove the unused HEALTH_INGEST_TOKEN env from Vercel. Report the DECISION REQUIRED list from README.md at the end. Conventional commits, no AI attribution.
```
