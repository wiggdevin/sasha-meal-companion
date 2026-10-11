# Meal Companion: scale architecture decision brief

Date: 2026-10-10. Basis: repo at `origin/main`, the scale facts supplied, spot checks in the code (marked "checked"), and a second-opinion review (see "Second opinion"). There is no production telemetry. Every number below is derived from code paths unless it says otherwise. Numbers marked "unverified" have no proof behind them yet.

## 1. Verdict

The architecture is the right shape for hundreds of users and for low thousands. It is stateless Next.js functions on Vercel, pinned to `sfo1` beside Supabase. Postgres is reached over PostgREST, and the phone syncs through an idempotent op-log. Locks are per user, per entity and per key (`apply_sync_op` in `supabase/migrations/20260911000600_rpc.sql`), and no global write lock sits in the sync path. A rewrite would be the wrong move. It will not reach tens of thousands unchanged. Nothing in it is wrong by design. Several things grow without bound or cost a little too much per request:
- `change_log` is never pruned. It also carries the replay receipts, so pruning it needs a design first.
- Several append-only tables have no retention: `change_log`, `client_timings`, `ai_calls`, `job_runs`, `recipe_plan_previews`.
- Every API request pays a Postgres write for the rate limiter.
- Hot paths make many sequential PostgREST calls.
- One global AI budget, one `evidence_clock` row, and cron jobs that walk every account will each hit a wall.
- The nightly backup has no proof of capacity beyond a small local restore.
- Almost nobody can see any of this: there is no error tracker, no alerting beyond one backup-staleness script, no load test and no table-size data.

The fixes are retention, fewer round trips, a queue for background work, a sound backup, and a bigger database tier.

## 2. Assumptions

- "Users" means daily active users (DAU). Cron jobs scale with total accounts, not DAU (`accountIds` in `lib/server/jobs.ts` lists every account), so read cron limits against total accounts.
- One active user makes about 60–100 API requests a day and about 400–700 PostgREST calls a day (estimate from `lib/sync/account-sync.ts`, `lib/warm-client.ts` and `lib/server/log.ts`).
- Peak load is about 10 times the average. Meal-time clustering makes that likely.
- Resulting DB call rates, my arithmetic:

| DAU | Average calls/s | Peak calls/s |
|---|---|---|
| 1,000 | about 6 | about 60 |
| 10,000 | about 60 | several hundred, up to about 1,000 |

- I do not know the Supabase compute tier, the pool size, the Vercel plan, or whether JWTs verify locally. Thresholds assume a small-to-medium Supabase tier. I did not verify current prices, so cost lines name the tier and the cost driver only.

## 3. Tiers

### Tier A: hundreds of users

**What holds**
- Sync locks, op-log idempotency and CAS (`apply_sync_op`).
- The DB rate limiter and the sharded spend reservation. The spend reservation was measured at 100 clients with p95 0.18–0.3 s (`20261218090100_ai_spend_reservations.sql`).
- Keyset cron sweeps (`lib/server/job-sweep.ts`).

**What does not yet have proof**
- The nightly JSON backup. The "324k rows" receipt is a local SQL-dump restore, mostly catalog data (`docs/readiness/2026-09-19/11-backup-restore.md`). It says nothing about the JSON backup route at user scale. See Tier B.

**What breaks first**
1. **AI global cap of $50 per UTC day** (`lib/ai/spend.ts`, `AI_GLOBAL_DAILY_SPEND_CAP_USD`).
   - At $0.10–0.50 per active user per day (assumption), it runs out at about 100–500 DAU, or at 25–50 heavy users.
   - Past the cap, every user gets 429 `spend_cap` until 00:00 UTC.
   - Sunday weekly reviews and facet-warm draw from the same pool.
2. **Circuit-breaker reads on `ai_calls`** (`lib/ai/circuit.ts`).
   - `assertCircuitClosed` makes two sequential reads before model calls. The first is provider-wide `permission_denied` (the `google` provider omits the model filter). The second is model-scoped failures. Both select rows and count client-side (checked).
   - I checked the migrations. The only `ai_calls` indexes are `(user_id, created_at)`, the idempotency index and the spend-reservation index. Nothing serves either filter.
   - The table also has no retention.
3. **Almost no visibility.** Console logs only, with no error tracker and no alerts. `/api/health` exists but nothing watches it. `scripts/check-backup-staleness.sh` exists, but it is not an independent watchdog.
4. **Unbounded tables** (`client_timings`, `ai_calls`, `job_runs`, `recipe_plan_previews`) with no purge. `recipe_plan_previews` rows hold proof JSON and I found no delete or purge anywhere in migrations, lib, app or scripts.

**Concrete changes**
- **AI budget** (effort S).
  - Raise the cap on purpose and reserve a share for interactive use. Cap background jobs separately.
  - Alert at 60% of the cap.
  - Trigger: spend over 60% of cap before 18:00 UTC, or any `spend_cap` 429 in `ai_calls`.
  - Cost: AI spend scales roughly linearly, about $30–150 a day at 300 DAU. This is the largest cost line at every tier.
- **Indexes and retention** (S).
  - For the circuit reads, add `ai_calls (provider, model_id, status, created_at)` for the model-scoped read. The provider-wide read needs its own index such as `(provider, status, created_at)`, or both reads should become one count query.
  - Add `log_items (food_ref_id)`. I checked: only `log_items_entry` exists. `catalog_search` runs a per-candidate lateral count over `log_items` by `food_ref_id` (`20260912090100_catalog_search.sql`).
  - Add purge crons for `client_timings`, `ai_calls`, `job_runs` and `recipe_plan_previews`, at 90 days (my pick).
  - Trigger: circuit read p95 over 50 ms, `catalog_search` p95 over 300 ms, or `log_items` over 1M rows.
  - Cost: negligible. Build the indexes concurrently.
- **Observability** (S).
  - Add an error tracker, an uptime monitor on `/api/health`, and alerts on stale `job_cursors` and `backup_runs`. Treat the existing backup-staleness script as a stopgap.
  - Trigger: now.
  - Cost: a new vendor, so ask Devin first.
- **Quick safety fixes** (S).
  - Set `maxDuration` on `/api/sync/ops`. This is necessary but not enough; see Tier B on the post-apply stamping work.
  - Skip dormant accounts in weekly-review.
  - Memoize `loadAccountPrior` before `OPEN_WORLD_ENABLED` goes on. It is the only loader called on a hot path (`lib/server/meal-snapshot-v3.ts:214`, via `lib/foods/universe/artifacts.ts`). The pairing loader (`lib/foods/pairing/artifacts.ts`) has no hot-path caller; leave it.

**Cost at this tier:** Supabase Pro on a small or medium compute class, Vercel Pro. Both are fine. AI is the only cost that moves.

### Tier B: thousands of users

**What holds**
- Postgres on a bigger compute class. Per-user locking means contention does not rise with user count.
- The job-cursor design, which resumes across fires.

**What breaks first**
1. **`change_log` growth.**
   - There is no retention. I grepped migrations, lib, app and scripts, and found no delete from it.
   - It stores the full post-op row in `current`, and a log entry carries about 3 KB of nutrient snapshot per item. Estimate: 15–30 MB per user-year.
   - That is about 15–30 GB a year at 1,000 users. The estimate is unmeasured.
   - A new phone replays all history from seq 0 at 500 rows a page (`lib/sync/client.ts`: `PAGE_LIMIT` 500, `DEFAULT_MAX_PAGES` 50, checked). There is no byte cap on pages.
   - **Replay protection lives in this table.** `apply_sync_op` answers `duplicate` by checking `exists (select 1 from change_log where op_id = v_op_id)` (`20260911000600_rpc.sql:336`, checked). Pruning rows without a durable receipt store would let a retried op apply twice.
2. **Backup function.**
   - One 300 s function reads 32 tables (checked; an earlier draft said 37) in 1,000-row pages using OFFSET paging (`.range(offset, …)`), so later pages scan more rows (`app/api/jobs/backup/route.ts:77,86`).
   - It reports `consistency: "per-request"`, so a backup is not one point-in-time snapshot.
   - There is no proof of its capacity. The only receipt is a 324k-row local restore of mostly catalog data. The failure point is unknown; measure it on a branch before trusting any row-count threshold.
3. **Rate-limiter writes.**
   - Every allowed request, including cheap GETs, does one `rate_limit_hit` write, and some routes do two (`lib/server/ratelimit.ts`).
   - The two hits are not duplicates. On `app/api/foods/eligible/route.ts` one limiter is per IP at 120/min before auth, and the other is per account at 30/min (checked). The IP one guards unauthenticated traffic; the account one guards a signed-in user.
   - A slow limiter returns 503 on fail-closed routes.
4. **Round trips.**
   - `/api/sync/ops` loops up to 200 `apply_sync_op` RPCs, one HTTP call each, and has never been benchmarked. After the loop it runs `stampLogOccasionsSafely` (`route.ts:140`), which does one `trainingKcalOn` read per date and one update per entry (`lib/server/log-occasion.ts`, about lines 123–150). The real call count per batch is higher than 200, and a `maxDuration` setting alone does not bound it.
   - `/api/log/commit` makes many sequential calls (`lib/server/log.ts`). My earlier 15–25 is an unverified estimate. Count total calls and sequential stages separately.
   - `/api/foods/eligible` runs a large number of queries on every sync pass and every date swipe, with no cache for closed accounts (`app/page.tsx`). The count varies by version (v1, v2, v3) and by account state (closed or open); it is not recounted.
   - `eligible-foods.ts` pages `user_food_prefs`, then runs unchunked `.in("id", refIds)` on `food_refs` and `.in("catalog_food_id", catalogIds)` on `catalog_food_revisions` (checked). A large account hits the 1,000-row cap and an oversized request URL.
5. **Cron jobs scale with total accounts.**
   - The estimate job reads `HISTORY_DAYS = 1825` (`lib/expenditure.ts`) in 180-day chunks (`lib/server/date-chunks.ts`). That is about 11 chunks per read and about 33 reads across three reads, even when the data is empty (checked).
   - Its period is `utcDate(now)`, so it starts a fresh pass per UTC date. I have no capacity number for it. Measure the per-account cost before setting an account limit.
   - Weekly review makes one model call per account at concurrency 4. Throughput per fire is unmeasured. Accounts in the tail may be skipped on busy fires.
   - facet-warm is tighter still.
6. **Catalog-ref write amplification.**
   - Each new catalog `food_ref` runs `update recipe_plan_state set rev = rev+1 where user_id is not null`. It also bumps the `evidence_clock` singleton (`20261202090000_scope_recipe_food_ref_clock.sql`, `20261213091100_evidence_clock_food_refs.sql`).
   - Cost per mint is proportional to user count. It is still milliseconds at 1,000 users.
7. **Client store.**
   - The sync mirrors for entities and the outbox are in IndexedDB (`lib/sync/idb.ts`). The localStorage JSON blob is the legacy day projection, parsed and re-written by `saveStoreFor` on every pulled `plan_days` row (`lib/store.ts`, `lib/sync/plan-days.ts`). There is no pruning.
   - This is a per-user, time-driven problem. It appears after months, not at a user-count threshold.

**Concrete changes**
- **`change_log` compaction** (L).
  - Step 1: move replay receipts (op_id, outcome, retained at least as long as any device cursor can replay) into a durable table, and make `apply_sync_op` check that table instead of `change_log`.
  - Step 2: write per-entity checkpoint snapshots, prune superseded rows behind them, and send a stale cursor a snapshot instead of history.
  - Add a byte cap per pull page now (S).
  - A plain TTL is unsafe, because devices with old cursors would lose data.
  - Trigger: table over 5 GB or 5M rows, first sync over 15 pages, or any page over 2 MB.
  - Cost: it avoids buying disk. Without it, expect 150–300 GB a year at 10k users (unmeasured).
- **Backup** (S/M).
  - First, measure: run the JSON backup against a branch with realistic row counts and record run time and failures.
  - Use Supabase daily backups plus PITR, or `pg_dump` from an always-on runner. Keep the JSON export only as a secondary copy, and switch it to keyset paging if it stays.
  - Trigger: run time over 150 s, or any failed run.
  - Cost: the PITR add-on, or a runner.
  - Reason: the Mac `pg_dump` depends on a laptop being awake (`docs/operations/backup-recovery.md`).
- **Fewer limiter writes** (M).
  - Keep the per-account limit on every route that has one, including eligible. Do not drop the second hit.
  - The candidate for thinning is the pre-auth per-IP limiter on cheap GETs. Move it to Vercel WAF or an edge counter. Keep the DB limiter on write routes and AI routes.
  - Trigger: limiter writes over 30% of PostgREST calls, or limiter RPC p95 over 30 ms.
  - Cost: possibly a new vendor, so ask Devin first.
- **Cut client fan-out** (M).
  - Fire `SYNCED_EVENT` only when something changed.
  - Cut warm pings: the client sends one `/api/warm` call plus five routes in `WARM_ROUTES` (checked). Consolidate to one call. I have no verified saving figure for this.
  - Eligible short-circuit: a token or ETag check can skip rebuilding the snapshot, but the key must cover every input of the body, not only `rules_rev` and `evidence_rev`. `mealSnapshot` and `mealSnapshotV3` also depend on eaten history, the date and the schedule. A cache keyed on the two rule clocks alone can serve a stale plan. Design the key with a review before building it.
  - Chunk the unbounded `.in()` reads in `eligible-foods.ts`.
  - Trigger: eligible p95 over 500 ms, or limiter 429s on eligible.
- **Single-round-trip RPCs** (M).
  - Add `apply_sync_ops(batch jsonb)`, move the occasion stamping into it or batch it, and fold the commit's reads into one function.
  - Trigger: `/api/sync/ops` p95 over 3 s, or any timeout.
- **Queue background work** (M).
  - The cron enqueues per-account jobs, and workers drain them. Keep `job_runs` and `job_cursors` as the ledger.
  - Trigger: a pass not done by its last fire, or weekly reviews skipped.
- **Replace the per-user catalog-ref bump** (M).
  - Use a global catalog revision checked at read time, like `evidence_clock`.
  - Trigger: `recipe_plan_state` dead tuples, or mint latency over 100 ms.
  - Do this before Tier C.
- **Trim the legacy day projection in localStorage** (M).
  - Move it to IndexedDB with the other mirrors, or stop re-writing it per pulled row. Prune old days.
  - Trigger: store over 1 MB, or `persistFailed` events.
- **Compute tier.**
  - Move to a Large-class Supabase instance.
  - Trigger: sustained CPU over 60%, or connections over 70% of max.
  - Cost: the main infrastructure step-up.

**Cost at this tier:** Supabase compute and disk lead. Vercel invocations are about 100k a day at 1,000 DAU. AI is $100–500 a day at 1,000 DAU (assumption).

### Tier C: tens of thousands of users

**What holds** (if Tier B is done)
- The sync protocol, per-user locks, and the op-log with idempotent `op_id` (receipts held in their own table).
- Sharded spend reservation up to a few hundred concurrent model calls.
- The PostgREST-over-HTTP model, if the RPCs are consolidated.

**What breaks first**
1. **Row counts.**
   - `client_timings` reaches 70–200M rows without purge.
   - Even with purge, `change_log`, `ai_calls` and `health_samples` need partitioning.
2. **Provider limits.**
   - Gemini already returned 503s at a handful of users (`docs/audit/2026-10-03-ai-call-success.md`).
   - The circuit opens a whole model after 5 failures, and there is no third provider.
3. **Hold-based refusals.**
   - Reservation holds are 3–10 times actual cost, so open holds alone can refuse calls (`lib/ai/spend.ts`, `lib/ai/openrouter.ts`).
4. **Cron passes.**
   - estimate and weekly-proposal scale with total accounts and with the per-account read cost above. Measure the per-account cost and derive the fire budget from it.
5. **`evidence_clock`.**
   - It serializes ref-minting transactions once minting runs at several per second.
6. **Vercel volume.**
   - About 1M requests a day at 10k DAU. It is a bill item, not a hard limit.

**Concrete changes**
- **Partition the big append-only tables** (L).
  - Use time partitions for `change_log`, `client_timings` and `ai_calls`.
  - Trigger: any table over 100M rows, or autovacuum falling behind.
- **Read replica** (M).
  - Route read-only history paths to it only where a stale read is harmless: taste and history-affinity reads for ranking.
  - Do not serve rule-enforcing reads (`/api/foods/eligible` admission) from a lagging replica. A stale rule or Avoid read risks showing a food the user just banned.
  - Trigger: primary CPU over 60% with reads above 70% of load.
  - Cost: a replica charge on top of Large or XL compute.
- **Cache the eligible snapshot** (M).
  - Cache per user, keyed by every input of the body (rules and evidence tokens, history watermark, date, schedule), not by the rules token alone. Invalidate on any write to those inputs.
- **Budget leasing for AI** (M/L).
  - Give each instance a chunk of the daily budget, so reserve and settle stop being two RPCs per call.
  - Trigger: shard p95 over 300 ms.
- **Second and third AI provider** (M).
  - Add quota alerts.
  - Trigger: provider 503s over 2% of calls.
  - Cost: metered spend. A new vendor needs Devin's approval.
- **Dedicated worker service** for background jobs (L).
  - Trigger: queue depth over one day of work.
- **Direct Postgres pool** for hot RPC paths only (L).
  - Use Supavisor, and only after the RPCs are consolidated and PostgREST is proven the bottleneck.
- **Real APM and SLOs.**

**Cost at this tier:** Supabase XL-class compute plus a replica. Vercel is about 30M invocations a month. AI is $1k–5k a day at $0.10–0.50 per user (assumption), so the $50 cap must be replaced by per-tier policy.

## 4. What NOT to change

- **Do not leave Supabase or PostgREST.**
  - Do not build a custom backend or microservices.
  - The cost is round trips, and the fix is fewer calls (see Tier B).
- **Do not shard Postgres or go multi-tenant-per-schema.**
  - Locks are per user already, and a single instance with a bigger tier covers 10k.
- **Do not rewrite the sync protocol.**
  - Only add retention to it. Idempotent ops, CAS and per-user sequence are sound.
- **Do not prune `change_log` with a plain TTL, and do not prune it before replay receipts have their own table.**
  - Use compaction with snapshots.
- **Do not add Redis, Kafka or Elasticsearch yet.**
  - Fix `catalog_search` with an index. 13.7k foods does not need an external search engine.
- **Do not switch to edge runtime or multi-region.**
  - The `sfo1` pin matches Supabase us-west-1 (`vercel.json`, `tests/speed/region-pins.test.ts`).
- **Do not remove the DB limiter or spend reservation from AI and write routes.**
  - Fail-closed spend control is a feature. Thin only the cheap GETs, and keep per-account limits.
- **Do not cache the eligible snapshot by rule clocks alone, or read it from a lagging replica.**
  - Stale rule enforcement is a safety risk.
- **Do not move off Vercel cron before the queue is needed.**
  - `job-sweep` and `job-cursor` are well built.
- **Do not trim the bundle, the art or FOOD_DB yet.**
  - CDN-served, 15 MB of `public/`, 194 KB `food-db.json`. This only matters at tens of thousands or with frequent deploys.

## 5. Top 10 actions, in order

1. **Measure.** (S)
   - Pull row counts, table sizes, `pg_column_size(current)` on `change_log`, and `pg_stat_statements`.
   - Confirm the Supabase tier, the JWT signing type and the Vercel plan.
   - Benchmark a 200-op `/api/sync/ops` batch on a branch, including the occasion stamping.
   - Run the JSON backup on a branch with realistic row counts.
2. **Alerts.** (S)
   - Error tracker, uptime monitor on `/api/health`, alerts on stale `job_cursors` and `backup_runs`, and spend over 60%.
   - Needs Devin's approval if it is a new vendor.
3. **AI budget policy.** (S)
   - Raise the global cap, reserve an interactive share, cap background separately.
4. **Indexes and retention.** (S)
   - `ai_calls` indexes that serve both circuit reads, and `log_items (food_ref_id)`, built concurrently.
   - Purge `client_timings`, `ai_calls`, `job_runs` and `recipe_plan_previews`.
5. **Safety quick fixes.** (S)
   - `maxDuration` on sync/ops.
   - A byte cap on `sync_changes` pages.
   - Chunk the `.in()` reads in `eligible-foods.ts`.
   - Skip dormant accounts in weekly-review.
   - Memoize `loadAccountPrior` before open-world turns on.
6. **Backup that does not depend on a laptop or a 300 s function.** (S/M)
   - PITR or an always-on `pg_dump`. Treat the JSON backup as unproven until step 1 measures it.
7. **Cut fan-out.** (M)
   - `SYNCED_EVENT` only on change, one warm call, per-IP limiter thinning on cheap GETs. Eligible cache only with a full-input key.
8. **Replay receipts table, then `change_log` compaction with snapshots.** (L)
   - This is the largest structural fix, and it grows with time, not only with users.
9. **Single-round-trip RPCs.** (M)
   - `apply_sync_ops` batch (with the stamping), plus consolidating the log commit.
   - Then move weekly-review, estimate and facet-warm to queued per-account jobs.
10. **Remove O(users) work.** (M)
    - Replace the catalog-ref bump on `recipe_plan_state` with a global revision.
    - Set explicit compute-tier upgrade triggers.
    - Partition the big tables before Tier C.

## 6. Unknowns to close first

Item 1 above closes most of these.
- Supabase compute tier, max connections and pool size.
- Whether `getClaims` verifies locally or calls Supabase Auth (`lib/server/auth.ts`).
- Real `change_log` row sizes, and real opens and ops per user per day.
- Real JSON backup run time and failure point at realistic row counts.
- Per-account cost of the estimate and weekly-review jobs, and total account count.
- Provider quotas for OpenRouter, Gemini and TypeSafe.
- Vercel plan limits, including function concurrency.
- Health Auto Export volume per user (`health_samples` growth).

All thresholds above should be re-set once these are known.

## Second opinion

A second model (GPT-6.1 Sol, read-only) reviewed the first draft. Only findings confirmed against the code changed this brief. Plausible but unchecked findings did not change it.

What changed:
- **Replay receipts.** `apply_sync_op` finds duplicates through `change_log.op_id`. Compaction now starts with a durable receipts table. A new "do not" rule says so.
- **Eligible cache and replica.** The snapshot depends on history, date and schedule, not only the rule clocks. The cache key now covers every input, and rule-enforcing reads stay off a lagging replica.
- **Backup.** The route exports 32 tables, not 37. It pages by OFFSET and is consistent per request only. The "324k rows" receipt is a local restore of mostly catalog data. The 2–6M row failure point is removed as unsupported. Measuring comes first.
- **Sync ops cost.** `/api/sync/ops` also runs occasion stamping after the apply loop (one read per date, one update per entry). The call count is higher than 200, and `maxDuration` alone is not enough.
- **Unchunked reads.** `eligible-foods.ts` runs unchunked `.in()` reads on `food_refs` and `catalog_food_revisions`. Added to the quick fixes.
- **Cron denominator.** Jobs list every account, so cron limits follow total accounts, not DAU. The estimate job does about 33 history reads per account. The "8–10k accounts" limit and the "170–300 reviews per fire" figure are removed.
- **Circuit reads.** There are two sequential `ai_calls` reads, and one index covers only the second. The index advice now covers both.
- **Limiter advice.** The two eligible limiters are different (IP at 120/min before auth, account at 30/min). "Drop the second hit" is removed. Per-account limits stay.
- **Client store.** Entity mirrors and the outbox are already in IndexedDB. The localStorage rewrite is the legacy day projection from `saveStoreFor`.
- **Retention gap.** `recipe_plan_previews` has no purge. Added to the retention list.
- **Warm ping.** It is one `/api/warm` call plus five routes. The "36 a day" and "a quarter of invocations" claims are removed.
- **Pairing loader.** The path is `lib/foods/pairing/artifacts.ts`, and it has no hot-path caller. Only `loadAccountPrior` needs memoizing.
- **Alerting.** "No alerting" was too absolute. `scripts/check-backup-staleness.sh` exists, but it is not an independent watchdog.
- **Not changed:** the `evidence_clock` and per-recipe-clock lock claims, the call counts for log commit and eligible (now marked unverified), the weekly-review window, the spend-cap wording and the spend benchmark. The review marked these plausible and they were not checked.
