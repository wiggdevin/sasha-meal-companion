# W059 and W026 migrations — production receipt (2026-10-11)

Owner approval: Devin, 2026-10-11, in session. Tool: `scripts/apply-migrations.py --commit` from
each PR's checkout after a merge of `origin/main`. Project `fivatgdpuenszxxnijpc`.

Backup taken first: `~/Backups/supabase/meal-companion/2026-10-11T183807Z-e4597a43.sql`
(23,769,789 B, sha256 `7cc4bc6f359e52acfd516b44c451aa5eab84359dedfdd6912b0b3b95dab45c4c`).
No other migration on main or in an open PR redefines `catalog_search` or `apply_sync_op`; both
patches refuse a partial anchor match.

| Migration | PR | sha256 of the applied file |
|---|---|---|
| `20261231190200_catalog_search_barcode_versions` | #87 (W059) | `c1356fd346c60b1b30bb6164a5c6d2cf89f0a9931820e0412df341df18837c91` |
| `20261231180000_sync_conflict_at` | #89 (W026) | `09f0422e557953ccd1f2898dd774165ec6315f37dd612e4b731183066c62b052` |

## Verification

- `catalog_search` accepts the `off` and `fdc_branded` barcode versions.
- `apply_sync_op` carries both conflict-answer patches (`_sync_written_at` appears twice);
  `_sync_written_at` is not executable by authenticated.
- Ledger: `20261231180000`, `20261231190200`.

## Relevance gate after W059 (read-only, production)

The 66 labelled queries in `docs/catalog/labelled-queries.jsonl` (61 resolve to a catalog food),
each parsed with `lib/search/query.ts` `parseQuery` and run through `catalog_search(…, 3)` in one
read-only SQL statement (the same scoring rule as `lib/search/eval.ts`; no account sign-in):

| n | top-1 | top-3 | barcode rows at top-1 |
|---|---|---|---|
| 61 | 51 (83.6 %) | 61 (100 %) | 0 |

Gate: top-1 ≥ 82 %, top-3 ≥ 95 % (ruling R1). It holds, unchanged from the recorded baseline.
OD07 (the 0.95 / 0.30 auto-resolve gate): owner decision 2026-10-11, keep for now.
