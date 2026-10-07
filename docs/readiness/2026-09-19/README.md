# Production readiness sweep: 2026-09-19

**Loop:** L2, Groundtruth loop #048 adapted

**Repository branch:** `feat/tidy-and-loops`

**Audit terminal:** `success`, all 12 areas have a direct outcome or owner step

**Readiness verdict:** **LAUNCHABLE WITH CAVEATS / 82 of 100**

The branch closes the two high-severity findings: all cron routes now have tested authenticated GET support, and the verified backup restored exactly 324,255 `public` rows into a disposable local target. Security and performance advisors both report zero ERRORs. The branch remains below a clean or strong verdict because production still runs the pre-fix cron code until landing, all six mobile screens emit repeatable console errors, and the live F10 provider turn remains unverified.

## Area table

| Area | Outcome | Severity | Evidence path | Fix or owner step |
|---|---|---|---|---|
| 1. Deploy state | proved | none | [01-deploy.md](01-deploy.md) | Track two framework deprecations; no release blocker. |
| 2. Routes | proved | none | [02-routes.md](02-routes.md) | None; only intentional `/api/warm` returns unauthenticated 200. |
| 3. Env | weak | low | [03-env.md](03-env.md) | Document or remove 3 production-only names; retain local/test variables outside production. |
| 4. Crons | proved-after-fix | release gate until landing | [04-crons.md](04-crons.md) | W1 added authenticated GET support; 24 focused tests pass. Production still has the old handlers until landing, then the next scheduled runs need a 2xx observation. |
| 5. Supabase advisors | proved, both endpoints | medium backlog debt | [05-supabase-advisors.md](05-supabase-advisors.md) | Security: 6 INFO, 15 WARN, 0 ERROR. Performance: 37 INFO, 0 WARN, 0 ERROR. |
| 6. RLS | proved | none | [06-rls.md](06-rls.md) | Branch-only test helpers repaired; 68/68 cross-user tests pass. |
| 7. 390 px screens | weak | medium | [07-mobile-ui.md](07-mobile-ui.md) | Make warm/disabled-health probes console-clean, check the branch sync result shape, then repeat all six screens. |
| 8. PWA | proved | none | [08-pwa.md](08-pwa.md) | None. |
| 9. Runtime errors | proved | none | [09-runtime-errors.md](09-runtime-errors.md) | Continue monitoring; 0 error/fatal rows in observed 24 h. |
| 10. AI spend | proved | none | [10-ai-spend.md](10-ai-spend.md) | None; $0.026454 / $2.00 (1.3227%). |
| 11. Backup/restore | proved on disposable local target | none | [11-backup-restore.md](11-backup-restore.md) | The 3-second data load restored 324,255 `public` rows, exactly matching the dump's public slice; use an unmigrated target for any future cloud branch rehearsal. |
| 12. F10 minimization | unverified / blocked | medium | [12-health-context.md](12-health-context.md) | Run one plain branch turn with a dedicated non-production provider key; focused tests are 21/21. |

## What changed the score

The same production-audit rubric moved the score from **68 to 82**. W1 removed the source-level high-severity cron defect on the branch, the disposable local restore removed the high-severity recovery unknown, and the performance advisor query closed the remaining evidence gap. The rubric uses readiness bands and blocker caps rather than additive points per table row.

The score stays in the 70 to 84 launchable-with-caveats band because the cron repair is not deployed, the six-screen console gate is still weak, and the live F10 turn is still missing. Those launch-path gaps keep the score below the rubric's 84 ceiling for incomplete end-to-end evidence. The existing environment drift and advisor backlog also remain.

The earlier bounded RLS harness repair remains valid: the first attempt lacked branch-only helpers, then the re-audit passed 68/68 tests in 24.50 seconds. No production object changed. This closeout also made no production write.

## Owner steps before a clean verdict

1. Land through `main`, then capture the next actual Vercel scheduled 2xx runs for the four repaired routes.
2. Remove warm/disabled-feature console noise and repeat the six-screen 390 px Playwright assertion with zero console errors.
3. Supply a non-production AI credential for the one live F10 branch turn.
4. Resolve the environment-name drift and triage the 15 security WARNs plus 37 performance INFO items.

## Branch and mutation ledger

- Supabase branches created: **none**.
- Supabase branches destroyed/reset: **none**.
- Existing `tidy-2026-09-19` remains persistent and shared for the driver.
- The disposable local Supabase stack was reset, populated for the restore proof, and reset clean again. No cloud branch was changed.
- Production writes, flag changes, purchases, deploys, and production AI-key use: **none**.
- Branch-only test changes: test helpers/schema-cache reload plus test-user/session data used for local screen coverage.

## Verification

Required closeout command:

```text
test -s docs/readiness/2026-09-19/README.md && grep -c 'performance' docs/readiness/2026-09-19/05-supabase-advisors.md
```

The attached screen evidence is in [`screenshots/`](screenshots/).
