# W122 search_path migration applied to production, 2026-10-17

Project `fivatgdpuenszxxnijpc`. Owner approval: Devin, in session, 2026-10-17 ("We're allowed to
migrate"). This clears the three `function_search_path_mutable` advisor WARNs from the W122
readiness pass (`docs/readiness/2026-10-17/README.md`).

## Review
The migration is three metadata-only `ALTER FUNCTION ... SET search_path = public, pg_temp`
statements. No app code depends on it, so the order did not matter. It was reviewed in session;
no second-model round was run for a change this size.

## Order
Applied first, at 08:45:49 UTC. PR #163 then merged as `28268931` at 08:46:08 UTC.

## Backup
`~/Backups/supabase/meal-companion/2026-10-17T084530Z-a4ab04fb.sql` (23,902,560 bytes,
sha256 `5eb45d0f01da30e818137584d1387a6c0b22688fc73d91a255e2cf2d12bf6a71`), taken by `scripts/backup.sh`.

## Applied
The dry run, from `main` with the PR file added, listed only `20270105130000_function_search_path`.
`--commit` applied and recorded it. A second dry run reported 180 of 180 recorded.

## Verified (read-only SQL)
- `_sync_assert_key`, `catalog_search_doc` and `compute_item_snapshot` each have
  `proconfig = {search_path=public, pg_temp}`.
- `catalog_search_doc('Crème brûlée', 'Brand', 'dessert')` still returns the expected weighted,
  unaccented document.
- `GET /api/health` on production reported `db: ok` after the apply.
