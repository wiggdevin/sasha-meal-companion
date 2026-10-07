# 04: Vercel crons

**Outcome:** proved-after-fix

**Severity:** high in current production until the branch lands

## Registration

The current production deployment contains all six cron definitions from `vercel.json`:

| Path | Schedule | Latest scheduled observation |
|---|---|---|
| `/api/jobs/media-sweep` | `0 3 * * *` | 2026-09-19T03:00:35.440Z, GET 200 |
| `/api/jobs/oura-pull` | `0 10 * * *` | 2026-09-19T10:00:14.072Z, GET 405 |
| `/api/jobs/estimate` | `0 7 * * *` | 2026-09-19T07:00:07.358Z, GET 405 |
| `/api/jobs/weekly-proposal` | `0 1 * * 1` | No scheduled run in the 24-hour Friday window |
| `/api/jobs/weekly-review` | `30 1 * * 1` | No scheduled run in the 24-hour Friday window |
| `/api/jobs/backup` | `45 3 * * *` | 2026-09-19T03:45:39.094Z, GET 200 |

Vercel's primary documentation says cron invocations are HTTP GET requests. The production versions of `estimate`, `oura-pull`, `weekly-proposal`, and `weekly-review` export only `POST`; the first two are confirmed failing with 405, and the weekly routes have the same deterministic incompatibility. `backup` aliases GET to POST and `media-sweep` exports both, so both succeeded.

Primary sources: [Cron Jobs](https://vercel.com/docs/cron-jobs), [Managing Cron Jobs](https://vercel.com/docs/cron-jobs/manage-cron-jobs), and [Vercel limits](https://vercel.com/docs/limits).

## Limit calculation

The project is on Pro. Vercel documents a 100-cron limit for Pro projects. Six registered jobs use **6%** of the limit, leaving **94** slots; quantity is not the problem.

## W1 repair and proof

W1 repaired all four POST-only routes on `feat/tidy-and-loops` by exporting `GET = POST` in `estimate`, `oura-pull`, `weekly-proposal`, and `weekly-review`. The alias preserves each route's existing job logic and `CRON_SECRET` bearer check. `backup` and `media-sweep` already supported GET.

The manifest-driven focused suite now covers all six registered paths:

- authenticated GET runs the mocked job and matches POST status;
- a missing or wrong bearer returns 401;
- PUT returns 405 through Next's route-method resolver;
- every `vercel.json` cron path exports GET.

Verification recorded by W1:

```text
pnpm exec vitest run tests/jobs app/api/jobs
Test Files  1 passed (1)
Tests       24 passed (24)
Duration    209ms

pnpm exec tsc --noEmit
exit 0

pnpm exec eslint app/api/jobs lib/server --max-warnings 0
exit 0
```

Six supplemental route files also passed 61 tests. The repair is proved on the branch. Production still runs the old code until this branch lands, so its recorded 405s remain the live state. After landing, confirm the next scheduled calls return 2xx.
