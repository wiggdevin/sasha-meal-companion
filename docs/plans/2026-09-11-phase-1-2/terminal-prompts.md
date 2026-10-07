# Phase 1 + 2 — terminal prompts (wave 2)

**Start condition:** Phase 0 release A has landed on `main` (all five lanes + integration Task I-5). Do not start
these while a Phase 0 lane is still open — the contracts assume its tables and helpers exist.

Setup once, from the main checkout:

```bash
cd ~/projects/clients/Sasha/meal-companion && git checkout main && git pull --ff-only
for L in F:p1-catalog-data G:p1-search H:p2-logging-server I:p2-client; do n=${L%%:*}; b=${L##*:}; git worktree add ../meal-companion-$n -b feat/$b main; done
for n in F G H I; do (cd ../meal-companion-$n && pnpm install --frozen-lockfile && cp ../meal-companion/.env.local .env.local); done
```

Then in each terminal: `cd ~/projects/clients/Sasha/meal-companion-<X> && claude` and paste.

## Terminal F — Catalog data (Phase 1)

```
ultracode. You are Lane F of Phases 1–2. Execute docs/plans/2026-09-11-phase-1-2/lane-F-catalog-data.md end to end with superpowers:subagent-driven-development. Read docs/plans/2026-09-11-phase-1-2/00-contracts.md and docs/plans/2026-09-10-phase-0/00-contracts.md first — both frozen; stop and report if a contract change is needed. Touch only Lane F's ownership row. The FDC downloads go to ~/Backups/usda/fdc/ (never into git); the dry run uses a local Postgres via scripts/catalog-dry-run.sh; the real import runs against a Supabase branch first and only against production after Devin reads docs/catalog/sizing.md. Write docs/catalog/her-foods-mapping.csv but never apply it — Devin reviews it. TDD every task, conventional commits, no AI attribution. When the lane exit gate passes, run ~/bin/zs-land and post the PR link, then tell Devin the two things waiting on him: the sizing sign-off and the mapping CSV.
```

## Terminal G — Search (Phase 1)

```
ultracode. You are Lane G of Phases 1–2. Execute docs/plans/2026-09-11-phase-1-2/lane-G-search.md end to end with superpowers:subagent-driven-development. Read docs/plans/2026-09-11-phase-1-2/00-contracts.md and docs/plans/2026-09-10-phase-0/00-contracts.md first — frozen; stop and report if a contract change is needed. Touch only Lane G's ownership row. The score formula in contracts §2 must be identical in SQL and in lib/search/features.ts; the parity test is the gate. The relevance gate (top-1 ≥ 85 %, top-3 ≥ 95 %) needs Lane F's import active on a branch — if it is not there yet, land everything else, leave lib/search/thresholds.ts at its provisional values with the TODO comment the plan specifies, and say so. TDD every task, conventional commits, no AI attribution. When the lane exit gate passes, run ~/bin/zs-land and post the PR link.
```

## Terminal H — Logging server (Phase 2)

```
ultracode. You are Lane H of Phases 1–2. Execute docs/plans/2026-09-11-phase-1-2/lane-H-logging-server.md end to end with superpowers:subagent-driven-development. Read docs/plans/2026-09-11-phase-1-2/00-contracts.md and docs/plans/2026-09-10-phase-0/00-contracts.md first — frozen; stop and report if a contract change is needed. Touch only Lane H's ownership row. compute_item_snapshot in SQL and computeSnapshot in TypeScript must agree to 4 decimal places on the fixture rows — that parity test is the gate. Null means "not measured", zero means "measured zero"; never coerce one into the other. applyLogEntry is the only writer of log_entries/log_items. TDD every task, conventional commits, no AI attribution. When the lane exit gate passes, run ~/bin/zs-land and post the PR link.
```

## Terminal I — Client (Phases 1 + 2)

```
ultracode. You are Lane I of Phases 1–2. Execute docs/plans/2026-09-11-phase-1-2/lane-I-client.md end to end with superpowers:subagent-driven-development. Read docs/plans/2026-09-11-phase-1-2/00-contracts.md, docs/plans/2026-09-10-phase-0/00-contracts.md and DESIGN.md first — all frozen. Style only with the utilities in app/globals.css and DESIGN.md tokens; copy exact values from ~/Desktop/Sasha app/07-design/neuform-mockup/LogMeal.dc.html and Main.dc.html; add no colours and no dependencies. Touch only Lane I's ownership row. NEXT_PUBLIC_CATALOG_SEARCH unset must leave the app exactly as Phase 0 left it — test both states. Offline: a cached food logs at once with a client snapshot; an uncached food with no network is blocked with a message, never zeroed. Take screenshots of the log sheet, Today with DayNutrients, and Settings export into docs/screenshots/phase-2/. TDD where a pure helper exists, conventional commits, no AI attribution. When the lane exit gate passes, run ~/bin/zs-land and post the PR link.
```

## After all four land — integration (Stage 2 of wave 2)

```
ultracode. Lanes F, G, H and I have landed on main. Create branch feat/p1-2-integration and: (1) read every lane plan's "Hand-off to integration" in docs/plans/2026-09-11-phase-1-2/; (2) create a Supabase branch, run the real FDC import against it with scripts/import-fdc.py, run pnpm test:integration including the search relevance gate and the snapshot parity suite; (3) if the relevance gate fails, run scripts/search-eval.ts, commit the calibrated thresholds, and re-run; (4) after Devin signs docs/catalog/her-foods-mapping.csv, run scripts/apply-food-mapping.ts against the branch and verify all 53 foods map; (5) set NEXT_PUBLIC_CATALOG_SEARCH=1 in Vercel preview only and post the preview URL for Devin's phone check. Do not run the import against production and do not flip the production flag — Devin does both after the check. Run ~/bin/zs-land for the integration branch when its tests are green.
```

## Watcher terminal — wave 2 (one terminal, from the main checkout; runs the whole wave)

```bash
cd ~/projects/clients/Sasha/meal-companion && git checkout main && git pull --ff-only && caffeinate -dimsu -t 43200 & claude
```

```
Use the watcher-orchestration skill. You are the WATCHDOG for wave 2 of Sasha's Meal Companion: four builder sessions, one per worktree — ../meal-companion-F (feat/p1-catalog-data), ../meal-companion-G (feat/p1-search), ../meal-companion-H (feat/p2-logging-server), ../meal-companion-I (feat/p2-client) — plus, once all four have MERGED, the integration builder on feat/p1-2-integration. Owner's order: this wave GETS DONE — unstick it, pre-build for it, never lower the bar. Repo wiggdevin/sasha-meal-companion; plans in docs/plans/2026-09-11-phase-1-2/ (README.md = stages and gates, 00-contracts.md = frozen interfaces, lane-*.md = the task lists, terminal-prompts.md = what each builder was told).

SINGLE-WRITER CONTRACT: builders own their worktrees, pushes and landings. You never edit a file under ../meal-companion-F/G/H/I, never push their branches, never run zs-land for them. Pre-build only in isolated clones under the scratchpad (git clone --local, branch from the builder's exact head sha), deliver git format-patch series + NOTES.md to ~/Inbox/notes/sasha-wave2-patches/<lane>/, and SendMessage the builder before starting so nothing is built twice.

LOOP: create a session cron every 10 minutes (3,13,23,33,43,53 * * * *) that runs `bash scripts/watch-lanes.sh F G H I` from this checkout and ListAgents, then applies:
- HEALTHY = a lane's last commit < 15 min old, or its claude process busy → one-line report per lane.
- STALLED = no commit and no visible activity for 2 ticks with unchecked tasks left → SendMessage that builder: its branch, last commit, the next unchecked task in its lane plan, "resume from your last completed step; do not stop to ask permission". One nudge per condition; repeat only after two more quiet ticks.
- DEAD = no claude process for the worktree and work remaining → push-notify Devin with the exact terminal line and prompt from terminal-prompts.md to restart that lane; keep the cron.
- CI: read conclusions from the API (`gh api repos/wiggdevin/sasha-meal-companion/actions/runs/<id>/jobs`), never from `gh pr checks` colours; a cancelled run is not a failure; read the failing job log before you tell anyone a fix is needed. A PR with mergeStateStatus DIRTY has no CI — tell its builder to merge main INTO the branch (never force-push).
- MERGED means `gh pr view <n> --json state,mergedAt` says MERGED — not a script's exit 0.
- CONTEXT: if a builder reports ≥ 35 % context, tell it to write PROGRESS.md in its worktree, then ask Devin to /compact that terminal.
- MACHINE: verify caffeinate is alive each tick (re-arm `caffeinate -dimsu -t 43200` if not); if the battery is discharging below 20 %, push-notify Devin to plug in.

WAVE-2 SPECIFICS:
- Lane F is the long pole (FDC download, dry-run import). Its `docs/catalog/sizing.md` and `docs/catalog/her-foods-mapping.csv` are DECISION REQUIRED items for Devin — surface them the tick they appear; never fill in the CSV decisions yourself.
- Lane G's relevance gate needs F's import on a Supabase branch; if G is otherwise green, tell it to land with provisional thresholds (its plan allows this) and log "calibration pending F".
- Lane H's parity suite (SQL compute_item_snapshot vs TS computeSnapshot, 4 dp) and Lane I's flag-off regression test are hard gates — do not let either land red.
- Supabase branches cost $0.013/hour: a lane that leaves one running after landing gets a nudge to delete it (`pnpm db:branch delete <name>`).
- Pre-build candidates when a lane is behind: Lane G's labelled-queries.jsonl expansion, Lane H's DRI seed rows, Lane I's screenshot pass. Claim first.
- When all four PRs are MERGED: push-notify Devin, then start the integration prompt from terminal-prompts.md in THIS session or hand Devin the line — Devin's call; default is to start it here and keep watching it as a fifth builder.
- COMPLETE = integration branch MERGED and Devin has the preview URL + the three decisions listed in README.md "Decisions Devin owes". Then push-notify a summary (wall-clock, working time, what landed, what is parked and why) and delete the cron.

First tick now: run the probe, report one line per lane, arm the cron, confirm caffeinate.
```
