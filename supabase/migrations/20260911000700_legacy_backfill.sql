-- Phase 0 legacy backfill. Lane D owns this file.
--
-- Everything lands in ONE transaction through backfill_legacy(). Count
-- assertions at the end raise, which rolls the whole insert back. A ledger
-- records every inserted primary key under one batch id, so the down migration
-- can delete exactly the backfilled rows and nothing else — no new column on
-- any Lane A table.

create table legacy_backfill_rows (
  batch_id uuid not null,
  table_name text not null,
  pk jsonb not null,
  created_at timestamptz not null default now(),
  primary key (batch_id, table_name, pk));

-- Per-day lock for /api/jobs/backup. One row per local date; a second POST on
-- the same date finds the row and answers 409.
create table backup_runs (
  local_date date primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  bytes bigint,
  status text not null default 'running' check (status in ('running','ok','error')),
  error text);

alter table legacy_backfill_rows enable row level security;
alter table backup_runs enable row level security;   -- service role only; no policy for users
-- RLS with no policy already denies both roles, but the default public grants
-- stay on the table. Revoke them too, matching 20260911000500_rls.sql.
revoke all on table legacy_backfill_rows from anon, authenticated;
revoke all on table backup_runs from anon, authenticated;

-- ai_calls records a failed call too, so the circuit breaker's history is
-- auditable. Additive; Lane A's create table is untouched.
alter table ai_calls add column if not exists status text not null default 'ok'
  check (status in ('ok','error'));
alter table ai_calls add column if not exists error text;

-- Private bucket for the nightly JSON dump. Vercel cannot write to ~/Backups.
insert into storage.buckets (id, name, public)
values ('backups', 'backups', false)
on conflict (id) do nothing;

create or replace function backfill_legacy(p_user_id uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch uuid := gen_random_uuid();
  v_expected jsonb := p_rows -> 'expected';
  v_entry jsonb;
  v_item jsonb;
  v_counts jsonb;
  n_user_foods int; n_food_refs int; n_prefs int; n_entries int; n_items int;
  n_water int; n_samples int; n_gut int; n_plan int; n_settings int;
begin
  if p_user_id is null then raise exception 'backfill_legacy: p_user_id is required'; end if;

  insert into user_foods (id, user_id, name, kind, per_100g, created_at)
  select (r ->> 'id')::uuid, p_user_id, r ->> 'name', r ->> 'kind',
         r -> 'per_100g', (r ->> 'created_at')::timestamptz
    from jsonb_array_elements(p_rows -> 'user_foods') r;
  get diagnostics n_user_foods = row_count;

  insert into food_refs (id, kind, user_food_id)
  select (r ->> 'id')::uuid, r ->> 'kind', (r ->> 'user_food_id')::uuid
    from jsonb_array_elements(p_rows -> 'food_refs') r;
  get diagnostics n_food_refs = row_count;

  insert into user_food_prefs (user_id, food_ref_id, status, role, no_cook, note, updated_at)
  select p_user_id, (r ->> 'food_ref_id')::uuid, r ->> 'status', r ->> 'role',
         (r ->> 'no_cook')::boolean, r ->> 'note', (r ->> 'updated_at')::timestamptz
    from jsonb_array_elements(p_rows -> 'user_food_prefs') r;
  get diagnostics n_prefs = row_count;

  n_entries := 0; n_items := 0;
  for v_entry in select * from jsonb_array_elements(p_rows -> 'log_entries') loop
    insert into log_entries (id, user_id, note, eaten_at, tz, local_date, slot, method)
    values ((v_entry ->> 'id')::uuid, p_user_id, v_entry ->> 'note',
            (v_entry ->> 'eaten_at')::timestamptz, v_entry ->> 'tz',
            (v_entry ->> 'local_date')::date, v_entry ->> 'slot', v_entry ->> 'method');
    n_entries := n_entries + 1;
    insert into legacy_backfill_rows (batch_id, table_name, pk)
    values (v_batch, 'log_entries', jsonb_build_object('id', v_entry ->> 'id'));

    for v_item in select * from jsonb_array_elements(v_entry -> 'items') loop
      insert into log_items (id, entry_id, seq, qty, unit, food_ref_id, grams, snapshot, was_edited)
      values ((v_item ->> 'id')::uuid, (v_entry ->> 'id')::uuid, (v_item ->> 'seq')::int,
              (v_item ->> 'qty')::numeric, v_item ->> 'unit',
              (v_item ->> 'food_ref_id')::uuid, (v_item ->> 'grams')::numeric,
              v_item -> 'snapshot', (v_item ->> 'was_edited')::boolean);
      n_items := n_items + 1;
    end loop;
  end loop;

  insert into water_log (user_id, local_date, cups)
  select p_user_id, (r ->> 'local_date')::date, (r ->> 'cups')::int
    from jsonb_array_elements(p_rows -> 'water_log') r;
  get diagnostics n_water = row_count;

  insert into health_sources (id, user_id, kind, device_label, created_at)
  select (r ->> 'id')::uuid, p_user_id, r ->> 'kind', r ->> 'device_label',
         (r ->> 'created_at')::timestamptz
    from jsonb_array_elements(p_rows -> 'health_sources') r;

  insert into health_samples (id, user_id, source_id, type, value, unit, start_time, end_time, tz)
  select (r ->> 'id')::uuid, p_user_id, (r ->> 'source_id')::uuid, r ->> 'type',
         (r ->> 'value')::numeric, r ->> 'unit', (r ->> 'start_time')::timestamptz,
         (r ->> 'end_time')::timestamptz, r ->> 'tz'
    from jsonb_array_elements(p_rows -> 'health_samples') r;
  get diagnostics n_samples = row_count;

  insert into gut_log (id, user_id, local_date, tz, state, note)
  select (r ->> 'id')::uuid, p_user_id, (r ->> 'local_date')::date, r ->> 'tz',
         r ->> 'state', r ->> 'note'
    from jsonb_array_elements(p_rows -> 'gut_log') r;
  get diagnostics n_gut = row_count;

  insert into plan_days (user_id, local_date, day_type_override, floor_day, swaps, slot_notes,
                         updated_at)
  select p_user_id, (r ->> 'local_date')::date, r ->> 'day_type_override',
         (r ->> 'floor_day')::boolean, r -> 'swaps', r -> 'slot_notes',
         (r ->> 'updated_at')::timestamptz
    from jsonb_array_elements(p_rows -> 'plan_days') r;
  get diagnostics n_plan = row_count;

  -- Guarded: without the key, `p_rows -> 'user_settings'` is NULL and the insert
  -- would still write one all-null row, which n_settings would then over-report.
  n_settings := 0;
  if p_rows ? 'user_settings' then
    insert into user_settings (user_id, first_opened_at, scale_warning_dismissed, training_kcal,
                               rest_kcal, protein_g, protein_locked, ramp_override, slot_times,
                               shift_minutes, changed_at)
    select p_user_id, (s ->> 'first_opened_at')::timestamptz,
           (s ->> 'scale_warning_dismissed')::boolean, (s ->> 'training_kcal')::int,
           (s ->> 'rest_kcal')::int, (s ->> 'protein_g')::numeric,
           (s ->> 'protein_locked')::boolean, (s ->> 'ramp_override')::smallint,
           s -> 'slot_times', (s ->> 'shift_minutes')::int, (s ->> 'changed_at')::timestamptz
      from (select p_rows -> 'user_settings' as s) t;
    get diagnostics n_settings = row_count;
  end if;

  -- Ledger for every table the down migration must clean.
  insert into legacy_backfill_rows (batch_id, table_name, pk)
  select v_batch, 'user_foods', jsonb_build_object('id', r ->> 'id')
    from jsonb_array_elements(p_rows -> 'user_foods') r
  union all select v_batch, 'food_refs', jsonb_build_object('id', r ->> 'id')
    from jsonb_array_elements(p_rows -> 'food_refs') r
  union all select v_batch, 'user_food_prefs',
         jsonb_build_object('user_id', p_user_id, 'food_ref_id', r ->> 'food_ref_id')
    from jsonb_array_elements(p_rows -> 'user_food_prefs') r
  union all select v_batch, 'water_log',
         jsonb_build_object('user_id', p_user_id, 'local_date', r ->> 'local_date')
    from jsonb_array_elements(p_rows -> 'water_log') r
  union all select v_batch, 'health_sources', jsonb_build_object('id', r ->> 'id')
    from jsonb_array_elements(p_rows -> 'health_sources') r
  union all select v_batch, 'health_samples', jsonb_build_object('id', r ->> 'id')
    from jsonb_array_elements(p_rows -> 'health_samples') r
  union all select v_batch, 'gut_log', jsonb_build_object('id', r ->> 'id')
    from jsonb_array_elements(p_rows -> 'gut_log') r
  union all select v_batch, 'plan_days',
         jsonb_build_object('user_id', p_user_id, 'local_date', r ->> 'local_date')
    from jsonb_array_elements(p_rows -> 'plan_days') r
  union all select v_batch, 'user_settings', jsonb_build_object('user_id', p_user_id)
    where n_settings > 0;

  v_counts := jsonb_build_object(
    'user_foods', n_user_foods, 'food_refs', n_food_refs, 'user_food_prefs', n_prefs,
    'log_entries', n_entries, 'log_items', n_items, 'water_log', n_water,
    'health_samples', n_samples, 'gut_log', n_gut, 'plan_days', n_plan,
    'user_settings', n_settings);

  if v_expected is null then
    raise exception 'backfill_legacy: p_rows.expected is required';
  end if;
  if v_counts <> v_expected then
    raise exception 'backfill_legacy: count mismatch. inserted=% expected=%', v_counts, v_expected;
  end if;

  return jsonb_build_object('batch_id', v_batch, 'counts', v_counts);
end;
$$;

revoke execute on function backfill_legacy(uuid, jsonb) from public, anon, authenticated;
grant execute on function backfill_legacy(uuid, jsonb) to service_role;
