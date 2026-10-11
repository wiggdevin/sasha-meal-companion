# Skipped tests in CI (W040)

The Integration job (`.github/workflows/ci.yml`) runs every file that uses a database
(`scripts/ci-integration-files.ts`). It writes a Vitest JSON report, and
`scripts/ci-skip-ceiling.ts` then prints every skipped test by file and fails the job when:

- more tests skipped than the ceiling in `scripts/ci-skip-ceiling.json`, or
- any test skipped in a throwaway-Postgres suite (a test file that names `PG_BIN`), or
- the report is empty or does not add up.

The unit shards run without a database, so their skips are expected and not counted here: each
of those files runs again in Integration.

## Ceiling: 9

| Date | Run | Tests | Skipped | Note |
|---|---|---|---|---|
| 2026-10-11 | before W040 (run 38130044776, `fix/w019-media-storage`) | 2298 | 85 | 76 throwaway-Postgres tests skipped: `PG_BIN` was unset on Ubuntu |
| 2026-10-11 | W040 PR (see the PR body) | — | 9 | `PG_BIN` set from the runner's PostgreSQL |

The 9 skips that remain need data or settings CI does not have, on purpose:

| File | Skipped | Condition |
|---|---|---|
| `tests/search/recall.test.ts` | 5 | `CATALOG_ACTIVE=1`: the imported USDA catalog |
| `tests/search/relevance.test.ts` | 2 | `CATALOG_ACTIVE=1`: labelled relevance against the catalog |
| `tests/foods/fndds-release-fingerprint.test.ts` | 1 | the pinned FNDDS release files (not in the repo) |
| `tests/cards/inventory.test.ts` | 1 | `PERF=1` |

The throwaway-Postgres suites that now run in CI: `tests/migrations/coach-undo-sql.test.ts`,
`coach-undo-receipt-sql.test.ts`, `recipe-energy-rule-db.test.ts`,
`health-ingest-record-db.test.ts` and `media-owner-paths-db.test.ts`.

## Changing the ceiling

Lower it when a skip goes away. Raise it only with a reason added to the table above, in the same
PR as the new skip. A new throwaway-Postgres suite needs nothing: the gate finds it by `PG_BIN`.
