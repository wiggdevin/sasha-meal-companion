-- Rollback for the Phase 0 backfill. Deletes ONLY the rows the ledger names for
-- one batch. foods, days and settings are not touched; they are dropped by
-- 20260911000800_drop_legacy.sql in the cut-over release, after the manual gate.

create or replace function rollback_legacy_backfill(p_batch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted jsonb := '{}'::jsonb;
  n int;
begin
  -- log_items cascade from log_entries; delete children of ledgered parents first.
  delete from log_items i using legacy_backfill_rows l
   where l.batch_id = p_batch_id and l.table_name = 'log_entries'
     and i.entry_id = (l.pk ->> 'id')::uuid;

  delete from log_entries e using legacy_backfill_rows l
   where l.batch_id = p_batch_id and l.table_name = 'log_entries'
     and e.id = (l.pk ->> 'id')::uuid;
  get diagnostics n = row_count; v_deleted := v_deleted || jsonb_build_object('log_entries', n);

  delete from user_food_prefs p using legacy_backfill_rows l
   where l.batch_id = p_batch_id and l.table_name = 'user_food_prefs'
     and p.user_id = (l.pk ->> 'user_id')::uuid
     and p.food_ref_id = (l.pk ->> 'food_ref_id')::uuid;
  get diagnostics n = row_count; v_deleted := v_deleted || jsonb_build_object('user_food_prefs', n);

  delete from food_refs f using legacy_backfill_rows l
   where l.batch_id = p_batch_id and l.table_name = 'food_refs' and f.id = (l.pk ->> 'id')::uuid;
  get diagnostics n = row_count; v_deleted := v_deleted || jsonb_build_object('food_refs', n);

  delete from user_foods u using legacy_backfill_rows l
   where l.batch_id = p_batch_id and l.table_name = 'user_foods' and u.id = (l.pk ->> 'id')::uuid;
  get diagnostics n = row_count; v_deleted := v_deleted || jsonb_build_object('user_foods', n);

  delete from health_samples s using legacy_backfill_rows l
   where l.batch_id = p_batch_id and l.table_name = 'health_samples' and s.id = (l.pk ->> 'id')::uuid;
  get diagnostics n = row_count; v_deleted := v_deleted || jsonb_build_object('health_samples', n);

  delete from health_sources h using legacy_backfill_rows l
   where l.batch_id = p_batch_id and l.table_name = 'health_sources' and h.id = (l.pk ->> 'id')::uuid;
  get diagnostics n = row_count; v_deleted := v_deleted || jsonb_build_object('health_sources', n);

  delete from gut_log g using legacy_backfill_rows l
   where l.batch_id = p_batch_id and l.table_name = 'gut_log' and g.id = (l.pk ->> 'id')::uuid;
  get diagnostics n = row_count; v_deleted := v_deleted || jsonb_build_object('gut_log', n);

  delete from water_log w using legacy_backfill_rows l
   where l.batch_id = p_batch_id and l.table_name = 'water_log'
     and w.user_id = (l.pk ->> 'user_id')::uuid and w.local_date = (l.pk ->> 'local_date')::date;
  get diagnostics n = row_count; v_deleted := v_deleted || jsonb_build_object('water_log', n);

  delete from plan_days d using legacy_backfill_rows l
   where l.batch_id = p_batch_id and l.table_name = 'plan_days'
     and d.user_id = (l.pk ->> 'user_id')::uuid and d.local_date = (l.pk ->> 'local_date')::date;
  get diagnostics n = row_count; v_deleted := v_deleted || jsonb_build_object('plan_days', n);

  delete from user_settings s using legacy_backfill_rows l
   where l.batch_id = p_batch_id and l.table_name = 'user_settings'
     and s.user_id = (l.pk ->> 'user_id')::uuid;
  get diagnostics n = row_count; v_deleted := v_deleted || jsonb_build_object('user_settings', n);

  delete from legacy_backfill_rows where batch_id = p_batch_id;
  return v_deleted;
end;
$$;

revoke execute on function rollback_legacy_backfill(uuid) from public, anon, authenticated;
grant execute on function rollback_legacy_backfill(uuid) to service_role;
