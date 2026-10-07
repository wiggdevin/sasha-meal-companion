-- Down for supabase/migrations/20260919090100_phase3_barcode_cache.sql. Lives in down/ for the
-- reason 20260912090200_catalog_grants.down.sql gives: `supabase db reset` applies every
-- top-level <digits>_<name>.sql and does not descend into subdirectories.
--
-- Drops only what 090100 created. The cached OFF and FDC catalog rows are derived data and are
-- left in place: dropping them costs a re-fetch, and log_items keep their own snapshots either
-- way (spec "Rollout and rollback").
drop function if exists catalog_write_provider_revision(uuid, text, text, jsonb);
drop index if exists catalog_barcode_lookups_stale;
drop table if exists catalog_barcode_lookups;
