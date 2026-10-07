-- Down for supabase/migrations/20260920090000_phase4_ai_calls_capture.sql. Lives here, not beside
-- the live migration, because `supabase db reset` applies every top-level <digits>_<name>.sql file
-- and does not descend into subdirectories. Tested on a branch, never applied to production.
--
-- Restores the Phase 0 two-value check from 20260911000700_legacy_backfill.sql. Rows carrying a
-- Phase 4 status would violate it, so they are narrowed to 'error' first — the audit value Phase 0
-- had for every failure.
drop function if exists ai_calls_today(uuid, text);
drop index if exists ai_calls_idem;
update ai_calls set status = 'error'
  where status in ('schema_invalid','provider_error','timeout','blocked');
alter table ai_calls drop constraint if exists ai_calls_status_check;
alter table ai_calls add constraint ai_calls_status_check check (status in ('ok','error'));
