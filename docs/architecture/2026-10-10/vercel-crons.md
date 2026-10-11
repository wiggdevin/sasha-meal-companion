# Vercel cron map

Checked in code on 2026-10-10 at `7405f41f`. Diagram: `vercel-crons-dd.html`.

## Summary

- Ten crons. All sit in `vercel.json:4-13`. All call `GET /api/jobs/<name>`.
- Every function runs in `sfo1` (`vercel.json:2`). No job route sets `preferredRegion`.
- Every job route exports `runtime = "nodejs"` and `dynamic = "force-dynamic"`. Nine set `maxDuration = 300`. `spend-sweep` sets 90.
- Every job uses `adminClient()` (service role, `lib/server/admin.ts:17`). No job runs as a user.
- Every job exports `GET` and `POST` on one handler. Vercel sends `GET`. On the five pass-based jobs a `POST` starts a fresh pass.
- Five jobs walk accounts: `estimate`, `weekly-proposal`, `oura-pull` and `facet-warm` keep a pass cursor. `weekly-review` walks them with no cursor.

## Schedule table

UTC is the schedule in `vercel.json`. "US Eastern" is the clock in New York: EDT (UTC-4) until 2026-11-01, then EST (UTC-5, one hour earlier than shown). The code never assumes one zone for these times. The route comments assume an Eastern evening or night.

| Job | Cron (UTC) | US Eastern, EDT | Fires a day | `maxDuration` | Route file |
|---|---|---|---|---|---|
| media-sweep | `0 3 * * *` | 23:00 the day before | 1 | 300 | `app/api/jobs/media-sweep/route.ts:34` |
| backup | `45 3 * * *` | 23:45 the day before | 1 | 300 | `app/api/jobs/backup/route.ts:29` |
| facet-warm | `20 4-7 * * *` | 00:20 to 03:20 | 4 | 300 | `app/api/jobs/facet-warm/route.ts:34` |
| signal-purge | `50 4 * * *` | 00:50 | 1 | 300 | `app/api/jobs/signal-purge/route.ts:25` |
| onboarding-events-purge | `55 4 * * *` | 00:55 | 1 | 300 | `app/api/jobs/onboarding-events-purge/route.ts:25` |
| estimate | `0 7-9 * * *` | 03:00 to 05:00 | 3 | 300 | `app/api/jobs/estimate/route.ts:37` |
| oura-pull | `0 10-12 * * *` | 06:00 to 08:00 | 3 | 300 | `app/api/jobs/oura-pull/route.ts:28` |
| weekly-proposal | `0 1-3 * * 1` | Sunday 21:00 to 23:00 | 3, Mondays only | 300 | `app/api/jobs/weekly-proposal/route.ts:48` |
| weekly-review | `30 * * * *` | every hour at :30 | 24 | 300 | `app/api/jobs/weekly-review/route.ts:41` |
| spend-sweep | `*/15 * * * *` | every 15 minutes | 96 | 90 | `app/api/jobs/spend-sweep/route.ts:24` |

What "local" means per job:

- `estimate` and `weekly-proposal` use each account's own day, not the cron zone. The route header says "03:00 user tz" and "Sunday 21:00 user tz". That holds for US Eastern only. At UTC-8 the estimate fires at 23:00 to 01:00 and the proposal fires on Sunday 17:00 to 19:00.
- `weekly-review` fires hourly and picks accounts by their own clock. An account is due from its local Sunday 18:00 to the end of that Sunday (`weeklyReviewDue`, `lib/server/jobs.ts:215`). The code reads `user_settings.time_zone`, then `HEALTH_TZ`, then UTC (`accountZones`, `lib/server/jobs.ts:173`).
- `oura-pull`, `facet-warm`, `media-sweep`, `backup` and both purges use UTC dates.

## Gate order on every job

All ten routes run the same first two checks, in this order. The order is checked in code for each route.

1. `cronSecretOk(req)`. It compares the `Authorization: Bearer` token to `CRON_SECRET` with `timingSafeEqual`. A missing env var or a wrong token gives `401` (`lib/server/jobs.ts:22`). Vercel adds this header to cron calls when `CRON_SECRET` is set. That behaviour is the platform's, not this repo's.
2. `enforceRateLimit("jobs:<name>", limit, 3600)`. It calls the `rate_limit_hit` RPC, which writes the `rate_limits` table. The default policy is fail closed. A limiter database error gives `503 rate_limit_unavailable` (`lib/server/ratelimit.ts:129-138`). A refused key gives `429`.
3. Then the job's own flag, if any.
4. Then the sweep, the per-account lock and the work.

The secret check comes first so a caller without the secret cannot spend the shared counter.

| Job | Limiter key and limit per hour | Flag after the limiter | Secret helper |
|---|---|---|---|
| estimate | `jobs:estimate`, 10 | `ESTIMATOR_ENABLED` off gives 503 | `cronSecretOk` |
| weekly-proposal | `jobs:weekly-proposal`, 10 | `ESTIMATOR_ENABLED` off gives 503 | `cronSecretOk` |
| oura-pull | `jobs:oura-pull`, 10 | `HEALTH_INGEST_ENABLED` off gives 200 and an empty body | own `bearerOk` copy |
| facet-warm | `jobs:facet-warm`, 10 | none | `cronSecretOk` |
| weekly-review | `jobs:weekly-review`, 10 | `coachEnabled()` false gives 200 `skipped: coach_disabled` | `cronSecretOk` |
| backup | `jobs:backup`, 10 | none | own `bearerOk` copy |
| media-sweep | `jobs:media-sweep`, 30 | none | own `bearerOk` copy |
| spend-sweep | `jobs:spend-sweep`, 12 | none | `cronSecretOk` |
| signal-purge | `jobs:signal-purge`, 12 | none | `cronSecretOk` |
| onboarding-events-purge | `jobs:onboarding-events-purge`, 12 | none | `cronSecretOk` |

## The pass cursor (four jobs)

Used by `estimate`, `weekly-proposal`, `oura-pull` and `facet-warm`. Code: `lib/server/job-cursor.ts` and `lib/server/job-sweep.ts`. Table: `job_cursors` (migration `20261217120300_job_cursors.sql`).

- **Budget.** `BUDGET_MS = 240_000` and `HARD_STOP_MS = 285_000` (`job-cursor.ts:202-203`). No new account starts after 240 s. Work still running at 285 s is left behind and queued for retry. The 15 s left is for saving the cursor before the 300 s limit.
- **Pass.** One row per (job, period). The period is the UTC date (`utcDate`), or `week-<date>` for a `weekly-proposal` run with a `weekStart` body. The row holds `after_key`, `listed`, `retry_keys`, `relist`, `done`, `pass_started_at`, `lease_owner` and `lease_until`.
- **Phases.** First the listing phase: accounts in key order, resuming after `after_key`. Then the retry phase: exactly the keys in `retry_keys`. A pass is `done` only when the listing ended and `retry_keys` is empty. A later fire of a done pass returns at once (`alreadyDone`).
- **Lease.** `claim_job_cursor` takes the lease in one statement and only when no live lease exists. The lease lasts `LEASE_SECONDS = 360`, longer than `maxDuration`. A second caller gets no row and the run returns `busy`. The save is a compare-and-set on `lease_owner` (`savePass`, `job-cursor.ts:83`). A run that lost its lease logs and does not overwrite the pass.
- **Restart.** `POST` passes `restart: true`. It discards the saved pass. It still waits for a live lease, because the claim's `where` clause requires no live lease.
- **Retry cap.** `MAX_RETRY_KEYS = 2_000`. Past that the queue is dropped and `relist` makes the pass list again from the start. The per-account lock then skips whoever is done.
- **Listing.** `keysetRows` pages with `key > last` in pages of 1,000, so the API row cap never drops rows. It throws if a page repeats.
- **Fallback.** If the claim fails (table missing, database down), the run logs it and walks the whole listing with no cursor. That is slower, not wrong.
- **Shared date.** Every run of a pass reads `pass_started_at`, so a resumed fire uses the same day or week as the first.
- **Concurrency.** `estimate` 6, `weekly-proposal` 6, `oura-pull` 6, `facet-warm` 4.

Jobs that use `runWithinBudget` with the same 240/285 s budget but no cursor: `weekly-review` (concurrency 4), `media-sweep` (8), `signal-purge` and `onboarding-events-purge` (1). `spend-sweep` has its own 60 s loop. `backup` has no budget.

## The per-account lock

Table `job_runs`, primary key `(job, user_id, run_key)`. The user can read their own rows (policy `job_runs_ro`); only the service role writes. Code: `claimLock` and `releaseLock` in `lib/server/jobs.ts:85-140`.

- `claimLock` inserts a `running` row. A duplicate key (`23505`) means a row exists.
- It then tries one conditional update. It reclaims a row with status `error`, or a `running` row older than `STALE_LOCK_MS = 15 min`.
- If it cannot reclaim, it reads the row and returns `done` (status `ok`), `failed` (status `error`, or a stale `running` row that the caller chose not to reclaim) or `busy` (a live `running` row).
- `releaseLock` writes `ok` or `error`. It retries once. If both writes fail it logs `JOB LOCK RELEASE FAILED` and throws.

| Job | Lock key (`run_key`) | Reclaims error rows | Reclaims stale rows |
|---|---|---|---|
| estimate | account-local date at pass start | yes | yes |
| weekly-proposal | `weekStart` (Monday), or the `weekStart` body | yes | yes |
| oura-pull | UTC date | yes | yes |
| facet-warm | UTC date | yes | yes |
| weekly-review (`weekly-review-local`) | `weekStart`, then `<weekStart>#retry` | no | no |
| backup | none. It uses `backup_runs` (`local_date` is the key) | error rows yes | `running` rows older than 2 h |
| media-sweep, spend-sweep, signal-purge, onboarding-events-purge | none | | |

`job_runs` has no cleanup job. A run adds one row per account per job per key.

## Tables each job reads and writes

All through the service role. "RPC" means a `security definer` or service-role function.

| Job | Reads | Writes |
|---|---|---|
| estimate | `user_settings` (zone, `day_marks_started_on`), `plan_days`, `health_samples` and `weigh_ins` (via `lib/server/health-daily.ts`), `health_source_status`, `target_profiles` (seed), `expenditure_estimates` | `expenditure_estimates` (RPC `upsert_expenditure_estimate`), `job_runs`, `job_cursors`, `rate_limits` |
| weekly-proposal | the estimate reads, plus `target_profiles` (active revision) and the pace-hold tables `constraint_profiles`, `user_dietary_profiles`, `user_settings.birth_year` (`readTargetEligibility`) | `expenditure_estimates` (blocked case), `target_proposals` (RPC `write_target_proposal`, which also rejects older pending rows), `job_runs`, `job_cursors`, `rate_limits` |
| oura-pull | `health_sources` (kind `oura`, not revoked, sealed `oauth`) | `health_sources.oauth` (token rotation), `ingest_events` (RPC `health_ingest_event`), `health_samples` (RPC `health_ingest_apply`), `job_runs`, `job_cursors`, `rate_limits` |
| facet-warm | `user_settings`, `user_food_prefs`, `food_refs`, `user_foods`, `catalog_food_revisions`, `food_facets` | `food_facets` (upsert, after Jev calls billed to the AI cap), `ai_calls`, AI spend tables (through `callModel`), `job_runs`, `job_cursors`, `rate_limits` |
| weekly-review | `user_settings` (zones), `coach_messages`, `coach_threads`, day totals (`daily_energy` view and RPC), `expenditure_estimates` | `coach_threads` (creates the `weekly_review` thread, sets `last_message_at`, `unread_at`), `coach_messages` (insert), `ai_calls`, AI spend tables, `job_runs`, `rate_limits` |
| backup | 31 tables through `select *` (list at `backup/route.ts:40-52`) | Storage bucket `backups` (`meal-companion/<date>.json`, upsert), `backup_runs`, `rate_limits` |
| media-sweep | `media_objects` (`deleted_at` null, `entry_id` null, older than 24 h) | Storage bucket removal, `media_objects.deleted_at`, `coach_action_undos` (RPC `scrub_coach_action_undos`), `rate_limits` |
| spend-sweep | RPC `ai_spend_expired_count` | `ai_spend_reservations`, `ai_spend_user_days`, `ai_spend_global_days` (RPC `ai_spend_sweep`, 50 rows a pass), `rate_limits` |
| signal-purge | none directly | `food_signal_events` (RPC `food_signal_events_purge`, 5,000 rows a pass, rows older than 180 days), `rate_limits` |
| onboarding-events-purge | none directly | `onboarding_events` (RPC `onboarding_events_purge`, 5,000 rows a pass, rows older than 90 days), `rate_limits` |

The weekly-review and facet-warm model calls go through `callModel`, so they also reserve spend (`ai_spend_reserve`) and write one `ai_calls` row each.

## What happens on failure

General rule for the four cursor jobs: a failed or held account returns `retry`. The pass queues its key. The next fire retries it. A pass with work left answers `incomplete: true` and logs a warning. A pass that never finishes is not paged by anything.

| Job | One account fails | Whole run fails | Retried by |
|---|---|---|---|
| estimate | lock set to `error`; key queued; `errors` +1 | limiter 503, flag 503, secret 401 | next fires at +1 h and +2 h. Next day starts a new pass. |
| weekly-proposal | same | same | same. A manual `POST` with `{ "weekStart": "yyyy-mm-dd" }` re-targets one week. |
| oura-pull | lock `error`; result row carries the message | `500` if the source listing fails | next fires at +1 h and +2 h |
| facet-warm | lock `error` only if nothing warmed and errors > 0; `warmEatsFacets` swallows all throws and returns `errors: 1` | same | next fires at 05:20, 06:20, 07:20 |
| weekly-review | first failure leaves the week lock `error` and it is not reclaimed. The next hourly run takes `<week>#retry` once. After that the week is spent. | limiter 503 | next hourly fire, once |
| backup | `backup_runs` set to `error`, response 500 | 500 | not by the schedule (it fires once a day). A manual call can reclaim an `error` row, or a `running` row older than 2 h. |
| media-sweep | the object row stays live; counted in `failed` | 500 only if the listing failed with nothing started | next day |
| spend-sweep | RPC error gives 500 | 500 | next fire in 15 min |
| signal-purge / onboarding-events-purge | a failed pass stops the loop; 500 only if nothing was purged | same | next day |

A killed run (platform timeout, crash): the per-account lock stays `running` and counts as stale after 15 minutes. The pass lease lapses at 360 s. The next fire (1 h later) resumes cleanly.

HTTP status is not a health signal for the cursor jobs. A run where every account failed still answers `200` with `errors` set (`estimate/route.ts:101`).

## Diagram notes

- Diagram 1 shows the 24-hour UTC schedule. A solid dot starts a pass. A hollow dot only resumes it. The accent marks the single-fire backup.
- Diagram 2 shows one request from the cron call to the saved pass. Gates 1 and 2 are dashed because they refuse the call. The accent marks the 240 s / 285 s budget.

## Suspicious items for the audit

Ordered by weight.

1. **Backup cannot resume and has no time budget.** `app/api/jobs/backup/route.ts:71-82` pages every table with `OFFSET`, one after another, inside one 300 s function. `ai_calls`, `change_log` and `health_samples` grow without a cap. When the dump passes 300 s the run dies with `backup_runs.status = running`. The cron fires once a day (`vercel.json:9`), so a timeout repeats every day. The reclaim of a `running` row waits 2 h (`route.ts:58`). The snapshot is "per-request", not consistent (`route.ts:86`).
2. **Backup table list is stale.** `backup/route.ts:40-52` omits tables added since September, for example `user_dietary_profiles`, `food_signal_events`, `onboarding_events`, `coach_action_undos`, `taste_chip_receipts` and `shopping_lines`. The comment at `route.ts:34` names only the 2026-09-11 RLS migration as the source. A restore from this JSON loses those tables.
3. **A limiter failure skips the backup for the day.** The limiter fails closed (`ratelimit.ts:129`) and the backup has one fire. A database blip at 03:45 UTC returns 503 and nothing retries.
4. **Hobby comment is wrong.** `media-sweep/route.ts:2-3` says the cron is daily because of Vercel Hobby. `vercel.json` also holds `*/15` and hourly schedules, which Hobby does not allow, and `maxDuration = 300`. Either the plan is Pro and the comment is stale, or the deploy would refuse. Check the plan.
5. **Oura token rotation drops the new tokens on a lost race.** `lib/server/oura.ts:112-116`: the update matches `oauth = source.oauth` and the result is discarded (`void data`). If another run already rotated, zero rows change and the new pair is lost. The refresh callback in `pullTwoDays` also passes the same unchanged `source` row; check what a 401 retry does with it.
6. **200 hides total failure.** `estimate/route.ts:100-101` and the other cursor jobs answer `200` with `errors > 0`, even when every account failed. Vercel cron shows success. Only logs show the failure.
7. **Weekly review rescans done accounts every hour.** `weekly-review/route.ts:69,111` lists all accounts from the start each fire (no cursor), then `weekLock` costs about three queries per already-done account (`lib/server/jobs.ts:85-123`). At large account counts on a Sunday evening, a crowded zone could spend the 240 s budget on re-checks before it reaches new accounts. Not a problem at today's size.
8. **Three copies of the secret check.** `backup/route.ts:124`, `oura-pull/route.ts:46` and `media-sweep/route.ts:39` repeat `cronSecretOk` instead of calling it. A fix in one will not reach the others.
9. **`job_runs` grows without bound.** No job or migration deletes rows (`grep` found none). One row per account per job per key per day.
10. **Dead helper.** `takeLock` (`lib/server/jobs.ts:58`) has no caller in `app/` or `lib/`. Only tests use it.
11. **Time-zone comments only fit US Eastern.** `estimate/route.ts:2` and `weekly-proposal/route.ts:2` say "03:00 user tz" and "Sunday 21:00 user tz". Other zones get other local times. A UTC-8 account gets its Sunday proposal at 17:00 to 19:00, before its Sunday ends.
12. **`warmEatsFacets` swallows every error.** `lib/server/eats-facet-warm.ts` (the final `catch`) returns `errors: 1` with no log, so the job log shows no cause.
13. **Abandoned in-flight work still runs.** At 285 s `runWithinBudget` stops waiting but cannot cancel (`job-sweep.ts:113`). A review or pull may finish after the response, with its lock row still `running`. The idempotent writes and the unique index `coach_messages_one_weekly_review` cover this; the cursor jobs rely on idempotent writes only.
