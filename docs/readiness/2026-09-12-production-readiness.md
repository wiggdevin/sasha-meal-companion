# Production readiness — 2026-09-12

Main sha: `ce0a7e648cdf07b9f71b7d9920f15d6c64a96b06`
Production deploy id: `dpl_FrqersVYnqWhgAuCtCHDh2NgQaHH` (ready 2026-09-12T17:30:49Z)
Production URL: https://sasha-meal-companion.vercel.app
Audit date: 2026-09-12

**Stale as of 2026-10-08: every `NOUS_*` name below (the env lists around lines 104 and 379-384) was removed from Vercel production on 2026-10-08.**
The Nous Portal transport left the codebase on 2026-10-01 (`docs/ai-data-handling.md`). This report is a point-in-time snapshot; see `docs/readiness/2026-09-19/03-env.md` for the same note.

This is the lane PROD readiness sweep (`~/.claude/goal-state/sasha-ship/readiness-loop.md`, adapted
from Loop Library #048). Every check below ran read-only against production; nothing on production
was written, no flag or env var was changed, no purchase was made, and no owner credential
(coach canary, Oura flow, real ingest token) was used. The one write in this sweep was a Supabase
preview branch (`readiness-2026-09-12`), created for the RLS/cross-user suite and destroyed at the
end of the run.

## Summary table

| # | Area | Status | Evidence |
|---|---|---|---|
| 1 | Deploy | PASS | `get_project`/`get_deployment` on `dpl_FrqersVYnqWhgAuCtCHDh2NgQaHH`: `target=production`, `readyState=READY`, `githubCommitSha=ce0a7e6…`. Build log (`errorsOnly`) shows one deprecation warning, no errors, "Build Completed in /vercel/output [18s]". |
| 2 | Routes | PASS | Every file under `app/api/**/route.ts` and every `app/**/page.tsx` enumerated and curled unauthenticated; all responses matched the expected class (401 auth-gated, 404 flag-off/dev-only, 405 wrong method, 503 feature-flag-off, 307 redirect-to-sign-in, 302 OAuth callback). Full table below. |
| 3 | Env | PASS | Closed in the addendum: the Vercel REST API (names only) lists 15 production variables; every flag-off-week name is unset; `SASHA_USER_ID` is unset. At sweep time no tool in the lane could list names, and flag presence was inferred from route behavior (section 3). |
| 4 | Crons | PASS | Closed in the addendum: the project's registered cron list has the same 5 definitions as `vercel.json`, enabled. Every one of the 5 job routes rejects an unauthenticated POST with 401 (secret gate proved). Last-run status was not read. |
| 5 | Database | PASS | Closed in the addendum: at sweep time production had only the legacy 3-table store and 1 baseline migration, none of the repo's 29 applied (the headline finding, section 5). Migrated 18:07 UTC (29 applied), then #51 (30 versions): 50 public tables, 0 with RLS off, security advisor ERROR 0. |
| 6 | RLS and cross-user | PASS | 66/66 tests pass (`tests/rls/*`, `tests/search/cross-user.test.ts`) on a fresh Supabase branch, after applying the full migration set to that branch (see caveat below). Branch destroyed after the run. |
| 7 | Mobile viewport | OWNER STEP | Anonymous-only checks at 390×844 pass (no horizontal scroll on any of 5 routes, sign-in tap targets 300×52, service worker registers). Every gated route (`/`, `/foods`, `/settings`, `/coach`) redirects anonymously to `/sign-in` before rendering, so the authenticated screens cannot be checked without signing in, which this audit is barred from doing. That check is the mobile test handoff. |
| 8 | PWA | PASS | `/manifest.webmanifest` is valid JSON: name "Sasha", `display: standalone`, `start_url: /`, 4 icon entries; `theme_color`/`background_color` `#F5F5F3` match DESIGN.md's documented ground. `/icon-192.png` and `/icon-512.png` both 200. `/sw.js` serves real content and registers (confirmed in a headless browser on all 5 test routes). |
| 9 | Runtime errors | PASS | `get_runtime_errors` (24h window): "No runtime errors found in the selected time range." Caveat: low/no traffic on the DB-touching endpoints, and the schema was applied only at 18:07 UTC (section 5), so this is not independent proof those endpoints are healthy — only that nothing has errored *yet*. |
| 10 | Rollback | PASS | Previous production deployment `dpl_3ftdkprgThf2XBFYJcTB6yFZwih4` (sha `4fabe72f9b60b91091d4ad0d226602907c825c6d`, "merge: bring in origin/main (PR #47…)"), READY, `isRollbackCandidate: true`, created 2026-09-12T16:58:54Z — one step behind current main. |

## 1. Deploy

- Project `prj_qOr6rQOZ5yfCd5VxB227apmg6pvF` (`sasha-meal-companion`), team `team_ZovXSbiQdKR8CvRpDYfAzbAr`.
- `get_project.latestDeployment` = `dpl_FrqersVYnqWhgAuCtCHDh2NgQaHH`, `readyState: READY`, `target: production`.
- `get_deployment` on that id: `githubCommitSha: ce0a7e648cdf07b9f71b7d9920f15d6c64a96b06`, `githubCommitRef: main`, `alias` includes `sasha-meal-companion.vercel.app` — the production alias is confirmed pointed at the sha this audit ran against.
- `get_deployment_build_logs(errorsOnly=true)`: only a Next.js "middleware deprecated, use proxy" warning; `Build Completed in /vercel/output [18s]`. No build errors.

## 2. Routes

Every `app/api/**/route.ts` and `app/**/page.tsx` was enumerated from the tree, then curled against
production with no cookies, no bearer token, and (for POST-capable routes) an empty `{}` body — this
never reaches a write, because every write route checks auth (or the feature flag) before touching
the database (verified by reading `requireUser`/flag-check ordering in each handler).

| Route | Method | Status | Why |
|---|---|---|---|
| `/api/constraints` | GET | 401 | auth-gated |
| `/api/constraints` | POST | 405 | GET/PUT only, wrong method |
| `/api/dev/sign-in` | GET | 404 | dev-only route, confirmed disabled in production |
| `/api/expenditure` | GET | 401 | auth-gated (read path is not flag-gated by design — see route comment) |
| `/api/export` | GET | 401 | auth-gated |
| `/api/foods/[id]` | GET | 401 | auth-gated |
| `/api/foods/barcode` | POST | 404 | `NEXT_PUBLIC_FEATURE_SCAN` unset |
| `/api/foods/search` | GET | 401 | auth-gated |
| `/api/health/daily` | GET | 503 | `HEALTH_INGEST_ENABLED` unset |
| `/api/health/ingest` | POST | 503 | `HEALTH_INGEST_ENABLED` unset |
| `/api/health/oura/callback` | GET | 302 | redirect (no OAuth state cookie) |
| `/api/health/oura/disconnect` | POST | 401 | auth-gated |
| `/api/health/oura/start` | GET | 503 | `HEALTH_INGEST_ENABLED` unset |
| `/api/health/tokens` | POST | 401 | auth-gated |
| `/api/health/tokens/[id]` | DELETE | 401 | auth-gated |
| `/api/jobs/backup` | POST | 401 | no cron secret |
| `/api/jobs/estimate` | POST | 401 | no cron secret |
| `/api/jobs/media-sweep` | GET/POST | 401 | no cron secret |
| `/api/jobs/oura-pull` | POST | 401 | no cron secret |
| `/api/jobs/weekly-proposal` | POST | 401 | no cron secret |
| `/api/jobs/weekly-review` | POST | 401 | no cron secret |
| `/api/coach` | POST | 404 | `COACH_ENABLED` unset (flag checked before auth, by design — "a 401 would tell an unauthenticated caller the route exists") |
| `/api/coach/threads` | GET/POST | 404 | `COACH_ENABLED` unset |
| `/api/coach/threads/[id]` | GET/DELETE | 404 | `COACH_ENABLED` unset |
| `/api/log/commit` | POST | 401 | auth-gated |
| `/api/log/propose` | POST | 401 | auth-gated |
| `/api/mcp` | GET/POST | 401 | auth-gated (bearer token) |
| `/api/media/sign` | POST | 401 | auth-gated |
| `/api/proposals` | GET | 401 | auth-gated |
| `/api/proposals/[id]/decide` | POST | 401 | auth-gated |
| `/api/sync` | GET/POST | 401 | auth-gated |
| `/api/sync/changes` | GET | 401 | auth-gated |
| `/api/sync/ops` | POST | 401 | auth-gated |
| `/api/targets` | GET/POST | 401 | auth-gated |
| `/` `/body` `/coach` `/foods` `/recipes` `/scan` `/settings` `/week` | GET | 307 | redirect to `/sign-in` (no session) |
| `/sign-in` | GET | 200 | public |

**Caveat that carries into every 401 row above**: none of these routes were tested past the auth
gate, because this audit never signs in or mints a real token. Given finding #5 (production's
database is missing the tables almost every one of these routes reads or writes), an authenticated
call to most of these would very likely 500 on production today — `foods/search`, `log/propose`,
`sync`, `proposals`, `targets`, `expenditure`, `media/sign` and the health/coach paths all touch
tables that do not exist yet on `fivatgdpuenszxxnijpc`. This audit proves the gate exists and answers
correctly when closed; it cannot prove what is behind the gate without an owner-provided session,
which is out of scope here.

## 3. Env

No tool available in this session lists Vercel environment variable names (the Vercel MCP connector
has no such endpoint; the `vercel` CLI is not installed; the ambient `VERCEL_TOKEN` was intentionally
not used — it is a live Vercel credential and using it was judged out of bounds for a read-only
audit that was not explicitly told to use it). What is confirmed indirectly, from route behavior:

- `COACH_ENABLED` / `NEXT_PUBLIC_COACH_ENABLED` — unset (coach routes 404 by design).
- `HEALTH_INGEST_ENABLED` — unset (health routes 503).
- `NEXT_PUBLIC_FEATURE_SCAN` — unset (barcode route 404).
- `ESTIMATOR_ENABLED` / `NEXT_PUBLIC_ESTIMATOR_UI` — not determinable from routes alone; `/api/expenditure` GET is deliberately not flag-gated (read-only path).
- `CAPTURE_METHODS` / `NEXT_PUBLIC_CAPTURE_METHODS` — not determinable from the routes tested.
- Every other `.env.example` name (`SUPABASE_*`, `SASHA_*`, `CRON_SECRET`, `FDC_API_KEY`, `GEMINI_API_KEY`, `NOUS_*`, `OURA_*`, `HEALTH_TOKEN_KEY`, `HEALTH_TZ`, `AI_DAILY_SPEND_CAP_USD`) — presence not directly checked; their absence would surface as a 500 wherever they're read, and no 500s were observed in the routes that were reachable, which is weak indirect evidence they're set, not proof.

**Owner step**: run `vercel env ls production` (or the Vercel dashboard → Settings → Environment
Variables) and confirm every `.env.example` name is present, and that the flag-off list matches this
week's intent (ruling 6, `docs/decisions/2026-09-12-wave4-rulings.md`).

## 4. Crons

`vercel.json` entries:

| Path | Schedule | Reject-without-secret confirmed |
|---|---|---|
| `/api/jobs/media-sweep` | `0 3 * * *` | yes (401) |
| `/api/jobs/oura-pull` | `0 10 * * *` | yes (401) |
| `/api/jobs/estimate` | `0 7 * * *` | yes (401) |
| `/api/jobs/weekly-proposal` | `0 1 * * 1` | yes (401) |
| `/api/jobs/weekly-review` | `30 1 * * 1` | yes (401) |

Whether Vercel has actually registered these 5 crons against the current production deployment, and
their last-run status, is not visible from any tool in this session (no MCP endpoint for it, no CLI
installed). **Owner step**: check Vercel dashboard → Project → Cron Jobs for registration and last
run.

**New, found while reviewing this section**: there are 6 job routes under `app/api/jobs/**`, not 5 —
`/api/jobs/backup` has no entry in `vercel.json` and so no cron ever calls it. Its own doc comment
says the Vercel-side backup is a secondary artifact (a JSON dump to private Storage) and that "the
real .sql dump under `~/Backups/supabase/meal-companion/`... is produced by `scripts/backup.sh` on
the Mac, which is what acceptance criterion 13 measures" — so this may be intentional (the Mac script
is the backup of record) rather than a missed cron line. **Owner step**: confirm whether
`/api/jobs/backup` is meant to run on a Vercel schedule at all; if yes, add it to `vercel.json`, if
no, say so somewhere the next reader won't re-flag it as missing.

## 5. Database — headline finding at sweep time (closed in the addendum)

`fivatgdpuenszxxnijpc` (org Zerosumsolutions-Projects) is the linked production Supabase project.
Direct evidence, all read-only:

- `list_tables` (public schema): `foods`, `days`, `settings` — 3 tables, 0 rows each.
- `execute_sql`: `select table_schema, table_name from information_schema.tables where table_schema = 'public'` returns the same 3 rows.
- `list_migrations`: one entry, `{"version":"20260911070347","name":"remote_schema"}`.
- `execute_sql`: `select version from supabase_migrations.schema_migrations` — the same single version.
- The repo's `supabase/migrations/` has **29** files, from `20260911000100_catalog_shell.sql`
  (Phase 0's user-food layer, logging, RLS, RPC) through
  `20261007090000_phase6_single_pending_proposal.sql` (Phase 7) — Phase 0's own 7 files plus
  catalog tables/search/synonyms, `phase2_*` (log items, daily totals), `phase3_*` (recipes,
  barcode cache, water goal, sync entities), `phase4_*` (ai_calls, media bucket), `phase5_*`
  (health ingest, Oura OAuth), `phase6_*` (expenditure, single-pending-proposal), `phase7_*` (coach,
  token scopes). **None of the 29 have ever been applied to production.**
- Confirmed a second way: a fresh Supabase preview branch created directly from
  `fivatgdpuenszxxnijpc` (`supabase branches create`) inherited the identical 3-table schema before
  any migration was reapplied to it — i.e. branching clones the parent's *live* schema, and the
  parent's live schema is Phase 0 only.
- The 3 tables that DO exist are not even Phase 0 of the current architecture: `foods` (`id text`,
  `data jsonb`), `days` (`date text`, `data jsonb`) and `settings` (`id text`, `data jsonb`) are the
  pre-cutover single-tenant JSON-blob store read and written only by `lib/server/db.ts`
  (`pullAll`/`pushRecords`), which backs the *legacy* `/api/sync` and `/api/mcp` routes pinned to
  `SASHA_USER_ID` (`grep` confirms these are the only three call sites in `lib`/`app`). The
  authenticated, per-user pages (Today, Foods, Settings, Coach — everything behind `/sign-in`) read
  and write an entirely different table set from the Phase 0 architecture v2.1 rewrite —
  `user_foods`, `food_refs`, `log_entries`, `user_settings`, `catalog_foods`, and everything Phase
  1–7 added on top — and none of those exist either. So this is not "Phase 0 is live, Phase 1+ is
  missing"; it is "the pre-rewrite legacy store is live, and the entire current architecture,
  Phase 0 through Phase 7, has never been applied."
- Security advisor: 3 INFO findings ("RLS Enabled No Policy" on `days`, `foods`, `settings` — RLS is
  on with no policies, which is safe-by-default deny-all, not a vulnerability, but confirms these
  three tables were never wired with app-facing policies either) and 1 WARN (leaked-password
  protection disabled in Supabase Auth — a real, independent, low-effort owner fix). No ERROR-level
  findings. "Advisors clean" in this report means no ERROR-level findings; the one WARN is carried as
  owner step 9 below, not treated as clean.
- Performance advisor: 1 INFO (Auth DB connection strategy is absolute, not percentage-based — informational only).

**What this means**: the Vercel deployment is running Phase 0–7 application code against a database
that is still Phase 0. Every route that reads or writes `log_items`, `sync_*`, `coach_*`,
`health_events`/`oauth_states`, `ai_calls`, `catalog_*`/`food_ref`, `expenditure_*`, `target_*`, or
`media` will fail once it gets past the auth gate, because those tables do not exist on production.
This cannot be fixed from a read-only audit — applying migrations to production is a schema write,
explicitly out of bounds for this lane. **Owner step**: run `supabase db push` (or the project's
equivalent migration-deploy step) against `fivatgdpuenszxxnijpc`, confirm `list_migrations` reports
all 29 versions, then re-run areas 2 and 6 of this audit with a real authenticated session.

## 6. RLS and cross-user

Branch `readiness-2026-09-12` (id `fed7e380-b500-46ed-8d13-fdcd4ee44e41`) was created off
`fivatgdpuenszxxnijpc` with `scripts/db-branch.sh create`. As expected from finding #5, the fresh
branch inherited production's 3-table schema and lacked the SQL test-helper functions
(`test_reset_user`, `test_view_options`) that `tests/rls/*` need — the first run failed every test
that depends on them. `scripts/db-branch.sh reset` (which the script itself describes as "re-apply
every migration from scratch, then apply `supabase/seed/test_helpers.sql`") applied all 29
migrations plus the test helpers to the branch only, never to production. After that:

```
pnpm vitest run tests/rls tests/search/cross-user.test.ts --no-file-parallelism
 Test Files  4 passed (4)
      Tests  66 passed (66)
```

(`--no-file-parallelism` was added after the first attempt raced two files that both create a fixed
test-user email concurrently — `pnpm test:integration` in `package.json` already uses this flag for
exactly this reason.)

Branch teardown, both calls against `https://api.supabase.com/v1/branches/fed7e380-b500-46ed-8d13-fdcd4ee44e41`:
`PATCH {"persistent":false}` → 200; `DELETE` → 200, `{"message":"ok"}`.

**Caveat**: this proves the RLS policies and cross-user isolation are correct on the schema the code
expects — once that schema exists. It is not proof that production is safe today, because production
does not yet have most of these tables (finding #5).

**Note on this session's own hygiene**: `scripts/db-branch.sh create`'s `env` step prints the branch's
`SUPABASE_TEST_*` values to stdout by design, and the first `create` call in this run was executed
without redirecting that output, so the branch's anon key, service-role key and pooled Postgres URL
appeared in this session's own transcript before the branch was destroyed. Those credentials are now
inert — the branch project (`yhovxjcxiumeyynargvd`) no longer exists — but this is recorded here in
the interest of an accurate audit trail; every subsequent use of the branch's credentials in this run
was sourced with `eval "$(bash scripts/db-branch.sh env … )"` in the same command as the consuming
step, printing nothing.

## 7. Mobile viewport

Anonymous only, 390×844, headless Chromium (Playwright, local install), no sign-in:

| Route | Result | Final URL | Horizontal scroll | Service worker |
|---|---|---|---|---|
| `/` (Today) | 200 | `/sign-in?next=%2F` | none | registered |
| `/foods` | 200 | `/sign-in?next=%2Ffoods` | none | registered |
| `/settings` | 200 | `/sign-in?next=%2Fsettings` | none | registered |
| `/coach` | 200 | `/sign-in?next=%2Fcoach` | none | registered |
| `/sign-in` | 200 | `/sign-in` | none | registered |

Sign-in screen tap targets: email input 300×52 px, "Send me a sign-in link" button 300×52 px — both
comfortably above the 44 px minimum.

Screenshots: `~/Inbox/screenshots/sasha-readiness-2026-09-12/{today,foods,settings,coach,sign-in}.png`
(all five show the sign-in screen, because every gated route redirects there anonymously — that
redirect is itself the checked behavior).

**What this cannot check**: the Today/Foods/Settings/Coach tab bar, the actual per-screen layout, and
their tap targets, because none of them render without a session, and this audit is barred from
signing in. That is exactly the first thing the mobile test handoff asks Devin to check by hand.

No Lighthouse run happened in this sweep; the 390×844 viewport checks above stand in for it.
Lighthouse is owner step 12, to run once the migrations are applied and a session can render the
real screens.

## 8. PWA

- `/manifest.webmanifest` → 200, valid JSON: `name: "Sasha"`, `display: "standalone"`,
  `start_url: "/"`, `scope: "/"`, 4 icon entries (192/512, `any` + `maskable`).
- `background_color` / `theme_color`: `#F5F5F3` — matches `DESIGN.md`'s documented ground
  (`neutral`/`background: "#F5F5F3"`, "off-white ground").
- `/icon-192.png` → 200, `/icon-512.png` → 200.
- `/sw.js` → 200, real content ("Service worker for Sasha's Meal Companion… offline-capable app
  shell"). Confirmed registering in the browser (`navigator.serviceWorker.getRegistration()`
  returned a registration) on all 5 routes tested in area 7.
- `/manifest.json` → 404 (expected; the app serves `manifest.webmanifest`, not `manifest.json`).

## 9. Runtime errors

`get_runtime_errors(since=24h)` on `prj_qOr6rQOZ5yfCd5VxB227apmg6pvF`: "No runtime errors found in
the selected time range." Caveat carried from area 5: this is consistent with either a healthy
deployment or simply low/no traffic on the routes that would fail against the current database
schema — it is not independent confirmation that those routes work.

## 10. Rollback

Previous production deployment: `dpl_3ftdkprgThf2XBFYJcTB6yFZwih4`
(sha `4fabe72f9b60b91091d4ad0d226602907c825c6d`, "merge: bring in origin/main (PR #47 wave-4 ruling
docs/tests)"), `state: READY`, `target: production`, `isRollbackCandidate: true`, created
2026-09-12T16:58:54Z — one production deploy behind the current main (`ce0a7e6`). A rollback from
Vercel's dashboard or `vercel rollback` targets this deployment.

## Owner steps

Collected here from `docs/decisions/2026-09-12-wave4-rulings.md` "Owner steps, collected", plus what
this audit found new:

1. Gemini: enable Cloud Billing on the project; confirm with `scripts/ai-canary.ts`; then flip Phase 4
   capture flags and the coach flags.
2. Oura: confirm Gen3+ ring and Membership; register the app; set the five `OURA_*` / `HEALTH_*`
   variables; flip `HEALTH_INGEST_ENABLED`.
3. Health Auto Export: install, configure the REST automation with a minted token.
4. Phone gates from PR #41 (four items) — in the mobile test handoff, `~/Inbox/notes/sasha-mobile-test-handoff.md`.
5. Flag order in production: Phase 5, then `ESTIMATOR_ENABLED`, then both coach flags.
6. Reopen dependabot #5 and #6 after the mobile test round.
7. Supabase branch `p1-catalog` (Phase 1 leftover, persistent, about $0.013/h): delete or keep.
8. **DONE 18:07 UTC, see addendum — apply the missing 29 migrations to production** (`fivatgdpuenszxxnijpc`):
   run `supabase db push` (or the project's migration-deploy step) so `list_migrations` reports all
   29 versions, then re-run this audit's Routes and RLS areas with a real session. This is the
   blocking item before any phone test can exercise anything past Today's client-side shell.
   **Checked for the independent reviewer's collision concern**: none of the 29 files `CREATE`,
   `ALTER` or `DROP` a table literally named `foods`, `days` or `settings` (grepped every file; the
   only real hits are `user_foods`, `user_settings`, `favorites_foods` — different tables). The one
   migration that touches the legacy tables at all, `20260911000700_legacy_backfill.sql`, only
   *defines* the function `backfill_legacy(p_user_id, p_rows)` — applying the migration does not
   call it, so `db push` will not read, move or drop any legacy row on its own; that backfill (and
   the paired `20260911000800_drop_legacy.sql` cutover, which does not exist in this repo — ruling 12
   says that cut-over never ran) stays a separate, deliberate, later step. Applying the 29 migrations
   is additive only. Still: push to a preview branch forked from production's *current* schema first
   (not `db-branch.sh reset`, which starts empty) and confirm a clean apply before touching
   production, per the independent reviewer's BLOCK finding below.
9. **DONE, see addendum — enable leaked-password protection** in Supabase Auth (flagged WARN by the
   security advisor); a one-setting toggle, unrelated to the migration gap.
10. **DONE via the Vercel REST API, see addendum — confirm Vercel env var names and registered crons** directly (dashboard or
    `vercel env ls production` / cron-jobs page) — no tool available in this session could read
    either, so areas 3 and 4 above rely on indirect evidence only.
11. **New, this audit — confirm whether `/api/jobs/backup` is meant to run on a Vercel cron** (see
    area 4); it has no `vercel.json` entry today and may be intentional.
12. **New, this audit — run Lighthouse (mobile) on Today, Foods, Settings and Coach** with a real
    session, after owner step 8. Not run in this sweep (anonymous audit; every gated route redirects
    to sign-in).

## What is flag-off for the mobile test

With every flag at its current (unset) production value: AI capture (photo/voice/label capture and
barcode scan), the Coach tab and every `/api/coach*` route, health ingest (Oura connect, the Body
data card, Health Auto Export), and the estimator/target-proposal cards are all off — Devin will see
Today, Foods, Settings and the log sheet exactly as Phase 2 shipped them, with none of Phases 3–7's
UI mounted. This matches contracts §6 ("an unset flag leaves every screen unchanged") and ruling 1/6
of the wave-4 rulings doc.

**This does not make the phone test safe today.** Finding #5 means the flag-off screens are not a
safe corner: Today, Foods, Settings and "log a food / water" all read and write the Phase 0+
tables (`user_foods`, `log_entries`, `user_settings`, `catalog_foods`, …), none of which exist on
production — the 3 tables that do exist (`foods`, `days`, `settings`) are the unrelated legacy
JSON-blob store used only by the old `/api/sync`/`/api/mcp` path, not by the signed-in app. Expect
the UI to render and the sign-in gate to work, then most real actions (logging a food, saving
water, editing Settings) to fail once they reach the database — until owner step 8 (apply the
missing migrations) is done. Tell Devin not to phone-test past sign-in until that step lands.

## Independent review

Run per the lane brief: Grok 4.6 (SuperGrok subscription, `grok-subscription`, tool-free,
`--max-turns 3`, one packet containing this report and the mobile handoff in full) reviewed the
finished draft as an independent senior release reviewer. Full transcript:
`~/.claude/goal-state/sasha-ship/lanes/PROD/review.json`. Verdict: *"No — owner must apply (and
prove) the 29 migrations on production before any phone test past sign-in"* — agrees with this
report's conclusion.

**BLOCK findings, folded in above**:
- The database/schema finding itself — already this report's headline; no change needed.
- The migration-apply owner step (8) didn't show the apply was collision-safe against the live
  legacy tables. Added: confirmed by grep that none of the 29 files touch `foods`/`days`/`settings`
  by name, and that the one migration referencing the legacy tables only defines a function, it
  never calls it — so `db push` is additive-only. Added the recommendation to dry-run on a branch
  forked from production's current schema (not a `reset`) before writing to production.

**FIX findings, already covered by this report's existing caveats, tightened where the reviewer's
wording was sharper than the draft's**: env-var presence, cron registration/last-run, RLS proving
the code's schema rather than production's current one, and runtime-errors absence not being a
health signal. One FIX was new and is now folded in: `/api/jobs/backup` has no cron entry in
`vercel.json` (area 4, owner step 11).

**NIT findings**: build warning (already noted, no action), `p1-catalog` branch cost (already an
owner step), session hygiene (already recorded), flag-off state matching wave-4 intent (no action —
confirms correctness), and keeping the rollback candidate available until after the migration and
phone pass (no doc change needed; already area 10's implicit recommendation).

## Addendum 2026-09-12 18:07-18:40 UTC — after the sweep

Devin authorized the production schema write in his own message; the driver session did the work and
re-audited areas 3, 4 and 5, which move from OWNER STEP to PASS in the table above. Row 7 stays OWNER
STEP (needs a signed-in session on the phone).

- **Area 5, migrations**: rehearsed on a throwaway branch cloned from production's live schema
  (`supabase migration repair --status reverted 20260911070347`, then `supabase db push`: 29 applied,
  50 public tables plus 3 views — `information_schema.tables` counts 53 — 29 versions, legacy `foods`/`days`/`settings` untouched; branch destroyed). Then the
  same sequence on production: 29 applied. After PR #51 (`20261008090000_catalog_rls_lint.sql`,
  ruling 13): 30 versions, `catalog_synonyms` and `catalog_barcode_lookups` have RLS on with one
  signed-in read policy each, zero public tables with RLS off.
- **Area 5, advisors after the push**: security advisor ERROR 0 (the two `rls_disabled_in_public`
  findings that appeared right after the first push are closed by #51), WARN 3 groups
  (`function_search_path_mutable` x3, `extension_in_public` x2, `authenticated_security_definer_function_executable` x9),
  INFO `rls_enabled_no_policy` x6 (legacy tables, `backup_runs`, `legacy_backfill_rows`, `oauth_states`).
  "Clean" = no ERROR-level findings, as defined in section 5.
- **Area 3, env**: the Vercel REST API (`GET /v9/projects/<id>/env`, names only) lists 15 production
  variables: `AI_DAILY_SPEND_CAP_USD CRON_SECRET FDC_API_KEY GEMINI_API_KEY HEALTH_INGEST_TOKEN
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY NEXT_PUBLIC_SUPABASE_URL NOUS_API_KEY NOUS_BASE_URL
  NOUS_COACH_MODEL_ID NOUS_REVIEW_MODEL_ID SASHA_MCP_TOKEN SASHA_SYNC_TOKEN SUPABASE_SERVICE_ROLE_KEY
  SUPABASE_URL`. Every flag-off-week name is unset as expected; `SASHA_USER_ID` (legacy pin) is unset.
  `OURA_CLIENT_ID`, `OURA_CLIENT_SECRET`, `OURA_REDIRECT_URI`, `HEALTH_TOKEN_KEY` and `HEALTH_TZ` are
  absent, which is harmless while `HEALTH_INGEST_ENABLED` is unset (`oura-pull` returns early); they
  are part of the Oura owner step. `NOUS_REVIEW_MODEL_ID` is set but appears nowhere in `.env.example`,
  `lib` or `app`: undocumented, unused today.
- **Area 4, crons**: the project's registered cron list has the same 5 definitions as `vercel.json`
  (`estimate`, `media-sweep`, `oura-pull`, `weekly-proposal`, `weekly-review`), enabled.
- **Auth**: leaked-password protection enabled (`password_hibp_enabled = true`). Sign-in is email
  code (8 digits, 30 min) through Supabase's built-in mailer, 2 emails per hour per project; the only
  account in production Auth is `devs@example.com`, and the sign-in page refuses addresses
  without an account by design.
- **Test-infra note (not production)**: on a preview branch rebuilt with `scripts/db-branch.sh reset`
  from the migrated parent, `service_role` lacked SELECT/INSERT/UPDATE/DELETE on user tables, so
  `tests/rls` was red there while the same suites passed 66/66 on the morning's branch. Cause not
  established (all 50 production tables are owned by `postgres`, the same as on the branch, so
  ownership is not the difference). Production grants verified correct: `service_role` has SELECT and
  INSERT on all 50 public tables. Follow-up: reproduce, make `db-branch.sh reset` grant-equivalent,
  rerun `tests/rls` on a branch.
- Owner steps 8, 9 and 10 above are done; 11 and 12 remain.

