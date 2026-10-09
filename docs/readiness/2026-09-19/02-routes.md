# 02 — Unauthenticated API routes

**Outcome:** proved, as of 2026-09-19 — **superseded/partial.** The `app/api` tree has grown to 105
`route.ts` files since this sweep (`app/api/care/*` now has 10, not 8; `app/api/shopping/*` now has
11, not 10). Treat this doc as a historical sample, not current coverage, until a fresh sweep of
the full tree runs.  
**Coverage:** every implemented method in all 38 `app/api/**/route.ts` files at the time of this
sweep; 48 requests total

## Results

| Route and method | Status |
|---|---:|
| `POST /api/coach` | 401 |
| `GET`, `POST /api/coach/threads` | 401, 401 |
| `GET`, `DELETE /api/coach/threads/test-id` | 401, 401 |
| `POST /api/coach/transcribe` | 401 |
| `GET`, `PUT /api/constraints` | 401, 401 |
| `GET /api/dev/sign-in` | 404 |
| `GET /api/expenditure` | 401 |
| `GET /api/export` | 401 |
| `GET /api/foods/test-id` | 401 |
| `POST /api/foods/barcode` | 404 |
| `GET /api/foods/search?q=rice` | 401 |
| `GET /api/health/daily?...` | 503 |
| `POST /api/health/ingest` | 503 |
| `GET /api/health/oura/callback` | 302 |
| `POST /api/health/oura/disconnect` | 401 |
| `GET /api/health/oura/start` | 503 |
| `DELETE /api/health/tokens/test-id` | 401 |
| `POST /api/health/tokens` | 401 |
| `POST`, `DELETE /api/health/weigh-in` | 401, 401 |
| `GET`, `POST /api/jobs/backup` | 401, 401 |
| `POST /api/jobs/estimate` | 401 |
| `GET`, `POST /api/jobs/media-sweep` | 401, 401 |
| `POST /api/jobs/oura-pull` | 401 |
| `POST /api/jobs/weekly-proposal` | 401 |
| `POST /api/jobs/weekly-review` | 401 |
| `POST /api/log/commit` | 401 |
| `POST /api/log/propose` | 401 |
| `GET`, `POST`, `DELETE /api/mcp` | 401, 401, 401 |
| `POST /api/media/sign` | 401 |
| `POST /api/profile/prefs` | 401 |
| `POST /api/proposals/test-id/decide` | 401 |
| `GET /api/proposals` | 401 |
| `GET /api/sync/changes?...` | 401 |
| `POST /api/sync/ops` | 401 |
| `GET`, `POST /api/sync` | 401, 401 |
| `GET`, `POST /api/targets` | 401, 401 |
| `POST /api/timings` | 401 |
| `GET /api/warm` | 200 |

## The one unauthenticated 200

`GET /api/warm` is intentionally public. The handler is rate-limited and returns a no-op response; it performs no data read or write. No other tested route returned 200 without authentication.

The health endpoints' 503 responses are the expected disabled-feature behavior in this production configuration. The Oura callback's 302 is an authorization-flow redirect, not an authenticated data response.
