# 05: Supabase advisors

**Outcome:** proved, security and performance

**ERROR count:** 0 across both advisors

The Supabase Management API advisor endpoints were queried read-only for project `fivatgdpuenszxxnijpc`. The performance result was refreshed through `GET /v1/projects/fivatgdpuenszxxnijpc/advisors/performance` with the bearer kept out of output.

| Advisor | INFO | WARN | ERROR |
|---|---:|---:|---:|
| Security | 6 | 15 | 0 |
| Performance | 37 | 0 | 0 |

## Performance INFO items

| Item | Count | Top examples |
|---|---:|---|
| Unindexed foreign keys | 28 | `api_tokens_user_id_fkey`, `catalog_barcodes_catalog_food_id_fkey`, `client_timings_user_id_fkey`, `coach_messages_ai_call_id_fkey`, `coach_messages_user_id_fkey` |
| Unused indexes | 6 | `client_timings_path_at`, `client_timings_run`, `log_entries_day`, `catalog_food_revisions_trgm_brand`, `catalog_barcode_lookups_stale`, `ingest_events_source_time` |
| No primary key | 2 | `catalog_staging.food_nutrient`, `catalog_staging.food_portion` |
| Auth DB connection strategy is absolute | 1 | Auth is capped at 10 connections instead of a percentage-based allocation. |

All 37 performance findings are INFO. The endpoint returned no performance WARN or ERROR items.

## Security WARNs

- Mutable function search path (3): `_sync_assert_key`, `catalog_search_doc`, `compute_item_snapshot`.
- Extension installed in `public` (2): `pg_trgm`, `unaccent`.
- Authenticated role can execute security-definer function (10): `_sync_assert_caller`, `_sync_current`, `_sync_tombstone`, `_sync_upsert`, `apply_sync_op`, `approve_target_proposal`, `get_or_create_food_ref`, `health_weigh_in`, `revoke_api_token`, `sync_changes`.

There were no security or performance errors. The 15 security WARNs and 37 performance INFO items should remain on the hardening backlog and be assessed against the intentional RPC boundary and observed workload rather than bulk-fixed.

Primary source: [Supabase Performance and Security Advisors](https://supabase.com/docs/guides/database/database-advisors).
