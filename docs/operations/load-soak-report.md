# Sign-up load and job-sweep soak (W049)

Status: **measured 2026-10-17 on the Mac** (Apple M4 Max, OrbStack, isolated `mc-care-test` stack,
Supabase CLI 2.120.0, `pnpm dev` app server). Every pass mark below is met. The raw JSON is in
`docs/operations/load-soak-2026-10-17/`.

Both scripts run **only** against the isolated local test stack from `scripts/test-stack.sh`
(API 56321, DB 56322, shadow 56320, project_id `mc-care-test`). Each refuses any Supabase URL other
than `http://127.0.0.1:56321` (or `localhost` / `[::1]` on 56321) and any app URL not on this
machine, and never reads `SUPABASE_URL`, so a production env file cannot leak in. The soak also
proves the app server trusts the test stack's sessions before it fires a cron route, and stops if
the route's pass does not appear in the test stack's `job_cursors`. Every account either script makes
is deleted in `finally`, and a sweep by email prefix catches leftovers.

## Commands

```sh
scripts/test-stack.sh start
set -a && . .supabase-test/.env && set +a

# App server on the test stack, for the bootstrap call and the route passes (its own port, 3523+).
SUPABASE_URL=$SUPABASE_TEST_URL SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_TEST_SERVICE_ROLE_KEY \
NEXT_PUBLIC_SUPABASE_URL=$SUPABASE_TEST_URL NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$SUPABASE_TEST_ANON_KEY \
CRON_SECRET=w049-local ESTIMATOR_ENABLED=1 pnpm dev --port 3523

# 1. Sign-up load: real signUp + GET /api/foods/world per account, load average held under 20.
pnpm exec tsx scripts/load/signup-load.ts --dry-run --app http://localhost:3523
pnpm exec tsx scripts/load/signup-load.ts --n 25 --concurrency 5 --app http://localhost:3523 --out signup-25.json
pnpm exec tsx scripts/load/signup-load.ts --n 200 --concurrency 20 --app http://localhost:3523 --out signup-200.json

# 2. Soak: 1,000 seeded accounts, the real sweep and job_cursors, then the real estimate route.
pnpm exec tsx scripts/load/job-sweep-soak.ts --dry-run
pnpm exec tsx scripts/load/job-sweep-soak.ts --accounts 1000 --out soak-real-budget.json
pnpm exec tsx scripts/load/job-sweep-soak.ts --accounts 1000 --budget-ms 5000 --out soak-resume.json
CRON_SECRET=w049-local pnpm exec tsx scripts/load/job-sweep-soak.ts --accounts 1000 \
  --app http://localhost:3523 --routes estimate,weekly-proposal --out soak-routes.json

scripts/test-stack.sh stop
```

Flags: `signup-load.ts` takes `--n`, `--concurrency`, `--max-load` (default 20), `--app`,
`--bootstrap <api path>`, `--no-bootstrap`, `--out`. `job-sweep-soak.ts` takes `--accounts`
(default 1,000), `--fail-rate` (default 0.03), `--budget-ms` (default the real 240 s; lower it to
force the listing to resume across runs), `--concurrency` (default 6, the estimate job's),
`--work-ms` (simulated per-account cost, default 5), `--app`, `--routes` (allowlist: `estimate`,
`weekly-proposal`; neither calls a model or a provider), `--out`.

## Sign-up ceiling

The ceiling on sign-ups is the auth email limit, not the app:

| Where | Limit | Why |
|---|---|---|
| Production now | 150 emails an hour | Each sign-up sends a confirmation email. |
| Production after W051 (custom SMTP) | 900 emails an hour | Same, on the project's own SMTP. |
| Local test stack | No email (`enable_confirmations = false`); Auth's per-IP `sign_in_sign_ups` rate limit applies instead | The CLI default for `[auth.rate_limit]`; check `.supabase-test/supabase/config.toml`. |

The load script counts a 429 from Auth as `rateLimited`, apart from `errors`, so the local per-IP
limit shows up as the ceiling rather than as failures. A run larger than that limit measures the
first window's sign-ups and the 429s after it.

## Sign-up results

| Run | Signed up | Rate limited | Error rate | auth p50 / p95 | bootstrap p50 / p95 | Peak load (1 min) |
|---|---|---|---|---|---|---|
| 25 at 5 | 25 | 0 | 0 % | 131 / 166 ms | 9 / 70 ms | 3.93 |
| 200 at 20 | 200 | 0 | 0 % | 371 / 481 ms | 10 / 48 ms | 4.41 |

Pass mark: error rate 0 % outside rate limiting, bootstrap errors 0, peak load under 20.

## Soak results (1,000 accounts)

| Pass | Runs (listing / retry) | Pass time | Retry depth | Retry queue after listing | Done |
|---|---|---|---|---|---|
| Harness, real budget | 1 / 2 | 1.04 s | 2 | 16 | yes, 1,000 deleted |
| Harness, 5 s budget | 1 / 2 | 1.02 s | 2 | 29 | yes, 1,000 deleted |
| `estimate` route | 1 fire, 200: ran 1,000, errors 0 | 3.46 s | n/a | 0 | yes |
| `weekly-proposal` route | 1 fire, 200: ran 1,000, errors 0 | 4.56 s | n/a | 0 | yes, 1,000 deleted |

Pass mark: every pass reports `passDone: true`, every seeded account is listed once in the listing
phase, the retry queue drains, and cleanup reports all seeded accounts deleted.

The same shape (5,000 keys, 5 % injected failures, budgeted runs resumed from the cursor, retry
phase to empty, depth 2) runs in CI in `tests/jobs/job-sweep.test.ts`, without a database.

## Notes from the 2026-10-17 run

- All 1,225 sign-ups succeeded with no Auth 429: the local per-IP limit was not reached at these
  sizes, so the table shows app capacity, not the ceiling.
- The 5 s budget did not force a resume: a 1,000-account listing takes about 1 s here, so it
  finished inside one run. Resume across runs is still covered by `tests/jobs/job-sweep.test.ts`.
  To exercise it live, use `--budget-ms 300` or `--work-ms 50`.
- Run the three soak passes with a pause between them. Back to back (about 3,000 accounts created and
  deleted within minutes), the test stack's Auth container ran out of outbound ports (`connect:
  cannot assign requested address` to Postgres), and the third seeding failed with "Database error
  checking email". After a 2-minute pause the same pass ran clean. This is local Docker socket churn,
  not an app limit; 150 half-seeded accounts were deleted from the test stack by hand.
- `scripts/test-stack.sh` passed `--workdir .supabase-test/supabase`. CLI 2.120.0 reads the workdir
  as the project root, so it ignored the patched config and tried to start a default `supabase`
  project on 54322 (taken by another stack). Fixed in the same PR: `--workdir .supabase-test`.
