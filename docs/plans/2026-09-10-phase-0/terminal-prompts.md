# Phase 0 — terminal prompts (paste one per terminal)

Setup once, from the main checkout (already done for you if `../meal-companion-p0-*` exist):

```bash
cd ~/projects/clients/Sasha/meal-companion && git checkout main && git pull --ff-only
for L in A:database B:auth C:sync D:data-ops E:theme; do n=${L%%:*}; b=${L##*:}; git worktree add ../meal-companion-p0-$n -b feat/p0-$b main; done
for n in A B C D E; do (cd ../meal-companion-p0-$n && pnpm install --frozen-lockfile && cp ../meal-companion/.env.local .env.local); done
```

Then in each terminal: `cd ~/projects/clients/Sasha/meal-companion-p0-<X> && claude` and paste the block.

---

## Terminal A — Database

```
ultracode. You are Lane A of Phase 0. Execute docs/plans/2026-09-10-phase-0/lane-A-database.md end to end with superpowers:subagent-driven-development. Read docs/plans/2026-09-10-phase-0/00-contracts.md first — it is frozen; if a task needs a contract change, stop and report instead of changing it. Touch only the files in Lane A's ownership row. TDD every task, conventional commits, no AI attribution. A Supabase branch costs $0.013/hour: create it with the script you write in Task 1, run the [needs branch] suites there, and delete it when the lane exit gate passes. When the gate passes, run ~/bin/zs-land and post the PR link. Report at the end: tasks done, tests run with counts, anything skipped and why.
```

## Terminal B — Auth + privileged boundary

```
ultracode. You are Lane B of Phase 0. Execute docs/plans/2026-09-10-phase-0/lane-B-auth.md end to end with superpowers:subagent-driven-development. Read docs/plans/2026-09-10-phase-0/00-contracts.md first — frozen; stop and report if a contract change is needed. Touch only Lane B's ownership row. Style the sign-in screen and AuthGate with the utility classes and tokens from DESIGN.md / app/globals.css (Lane E owns those files; use what exists, add nothing to them). TDD every task, conventional commits, no AI attribution. Tests marked [needs branch] are skipped when SUPABASE_TEST_URL is unset — list them in your report. When the lane exit gate passes, run ~/bin/zs-land and post the PR link.
```

## Terminal C — Sync engine

```
ultracode. You are Lane C of Phase 0. Execute docs/plans/2026-09-10-phase-0/lane-C-sync.md end to end with superpowers:subagent-driven-development. Read docs/plans/2026-09-10-phase-0/00-contracts.md first — frozen; stop and report if a contract change is needed. Touch only Lane C's ownership row. The entity_key encodings (§4) and the duplicate fingerprint bytes (§4.1) must match the contracts exactly; Lane A's SQL is written to the same spec. Style SyncStatus with the utility classes from app/globals.css; add no colours. TDD every task, conventional commits, no AI attribution. [needs branch] tests are skipped when SUPABASE_TEST_URL is unset — list them. When the lane exit gate passes, run ~/bin/zs-land and post the PR link.
```

## Terminal D — Data ops

```
ultracode. You are Lane D of Phase 0. Execute docs/plans/2026-09-10-phase-0/lane-D-data-ops.md end to end with superpowers:subagent-driven-development. Read docs/plans/2026-09-10-phase-0/00-contracts.md first — frozen; stop and report if a contract change is needed. Touch only Lane D's ownership row. @google/genai is major 2; use Zod 4's z.toJSONSchema; scripts run with pnpm exec tsx. scripts/ai-canary.ts makes ONE real Gemini call and ONE real Nous call using the keys in .env.local — run it once, record the result in docs/ai-data-handling.md, and do not loop it. Never run scripts/migrate-legacy.ts with --apply against production; the dry run only. TDD every task, conventional commits, no AI attribution. When the lane exit gate passes, run ~/bin/zs-land and post the PR link.
```

## Terminal E — Theme

```
ultracode. You are Lane E of Phase 0. Execute docs/plans/2026-09-10-phase-0/lane-E-theme.md end to end with superpowers:subagent-driven-development. DESIGN.md is the contract; the mockups' exact values are in the files under ~/Desktop/Sasha app/07-design/neuform-mockup/*.dc.html — copy values from them, do not invent. Keep every existing token name in app/globals.css (remap values, add names, remove nothing). No behavior or data-shape changes; every existing test stays green. Take a screenshot of each restyled screen with the dev server (preview_start) into docs/screenshots/theme/. Touch only Lane E's ownership row in 00-contracts.md. Conventional commits per screen, no AI attribution. When the lane exit gate passes, run ~/bin/zs-land and post the PR link.
```

---

## After all five land — Terminal 1, integration (Stage 2)

```
ultracode. All Phase 0 lanes have landed on main. Create branch feat/p0-integration from main and execute Stage 2 of docs/plans/2026-09-10-phase-0/README.md (Tasks I-1 to I-5) with superpowers:subagent-driven-development. Read every lane plan's "Hand-off to integration" section first. Do NOT include Task I-3 (legacy deletion) or supabase/migrations/20260911000800_drop_legacy.sql in release A — keep them on a separate commit for release B. Create a Supabase branch, run pnpm test:integration, pnpm ai:canary, and the backup round trip. When I-5's gate passes, run ~/bin/zs-land for release A and stop: Sasha's sign-in and Devin's manual gate come next, by hand.
```

## Watching from a sixth terminal (optional)

```
Use the watcher-orchestration skill. Watch the five Phase 0 lane sessions (worktrees ../meal-companion-p0-A..E). Session cron every 10 minutes running `bash scripts/watch-lanes.sh p0-A p0-B p0-C p0-D p0-E`; read CI from the API, verify MERGED via `gh pr view --json state,mergedAt`; nudge a stalled lane with its plan's next unchecked task; never edit their files or push their branches; pre-build only in scratch clones as format-patch series. Report one line per lane per tick; push-notify Devin on a dead lane or when all five have merged.
```
