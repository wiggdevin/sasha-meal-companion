-- Body-fat provenance (step C, docs/plans/2026-09-22-tdee-engine-plan.md).
--
-- Katch-McArdle needs a MEASURED body-fat value; a typed guess makes it worse than Mifflin-St Jeor.
-- The app now uses Katch only when the value has a measured source (DEXA, InBody, clinical BIA)
-- dated within 180 days (lib/profile/energy.ts `katchEligible`). These two nullable columns carry
-- that provenance. A null source means "not verified", so every existing row, which has no source,
-- moves to Mifflin with no backfill.

-- Under scripts/apply-migrations.py (one transaction per file): wait at most 5 s for a table
-- lock, then fail the whole file (rolled back, nothing recorded) instead of queueing every app
-- write behind this migration. Outside a transaction (a local `supabase db reset`) it is a no-op.
-- The locks, once held, last for the file; user_settings and target_profiles hold one row per
-- account and a few revisions each, so the check scans below are short (review r2, accepted).
set local lock_timeout = '5s';

alter table user_settings
  add column body_fat_source text constraint user_settings_body_fat_source_check
    check (body_fat_source in
    ('dexa', 'inbody', 'clinical_bia', 'consumer_scale', 'visual_estimate', 'typed_unknown')),
  add column body_fat_measured_on date;

-- A new value never inherits the old value's provenance. When body_fat_pct changes and the same
-- write does not also change the source or the date, both are cleared; a row inserted or updated
-- with no body fat carries no provenance either. The app sends an explicit
-- null source with every body-fat edit; this trigger is the backstop for a phone still running a
-- bundle that does not know the columns (its sync omits the keys, which keeps the stored values).
create or replace function user_settings_body_fat_provenance() returns trigger
  language plpgsql set search_path = public as $$
begin
  if new.body_fat_pct is null then
    new.body_fat_source := null;
    new.body_fat_measured_on := null;
  elsif tg_op = 'UPDATE' then
    -- Nested, not AND-ed: plpgsql does not promise short-circuit, and INSERT has no OLD row.
    if new.body_fat_pct is distinct from old.body_fat_pct
       and new.body_fat_source is not distinct from old.body_fat_source
       and new.body_fat_measured_on is not distinct from old.body_fat_measured_on then
      new.body_fat_source := null;
      new.body_fat_measured_on := null;
    end if;
  end if;
  return new;
end;
$$;

create trigger user_settings_body_fat_provenance
  before insert or update of body_fat_pct, body_fat_source, body_fat_measured_on on user_settings
  for each row execute function user_settings_body_fat_provenance();

-- The two columns join the sync contract: an omitted key keeps the stored value, a present JSON
-- null clears it, an insert with the key omitted stores null. Three anchored insertions into the
-- installed user_settings branch; each anchor must occur exactly once, so every other branch is
-- carried forward byte for byte.
do $migration$
declare
  definition text;
  anchors text[] := array[
    'height_unit, weight_unit, time_zone, rev)',
    'p_payload->>''time_zone'', p_rev)',
    'else user_settings.time_zone end,'];
  replacements text[] := array[
    'height_unit, weight_unit, time_zone, body_fat_source,
                               body_fat_measured_on, rev)',
    'p_payload->>''time_zone'', p_payload->>''body_fat_source'',
            (p_payload->>''body_fat_measured_on'')::date, p_rev)',
    'else user_settings.time_zone end,
      body_fat_source = case when p_payload ? ''body_fat_source''
        then p_payload->>''body_fat_source''
        else user_settings.body_fat_source end,
      body_fat_measured_on = case when p_payload ? ''body_fat_measured_on''
        then (p_payload->>''body_fat_measured_on'')::date
        else user_settings.body_fat_measured_on end,'];
  i integer;
begin
  select pg_get_functiondef(
    'public._sync_upsert(uuid,text,text,jsonb,integer)'::regprocedure
  ) into definition;
  -- Already applied: the first replacement is present. Any other state must match every anchor.
  if position(replacements[1] in definition) > 0 then
    return;
  end if;
  for i in 1 .. array_length(anchors, 1) loop
    if (length(definition) - length(replace(definition, anchors[i], '')))
       / length(anchors[i]) <> 1 then
      raise exception 'body_fat_provenance: anchor % does not occur exactly once', i;
    end if;
    definition := replace(definition, anchors[i], replacements[i]);
  end loop;
  execute definition;
end;
$migration$;

-- Caller guard and privileges, restated from 20261103090000_sync_internals_revoke_authenticated.sql
-- (PR #249). Production applies this file AFTER that migration; a fresh database applies it
-- before. Either way `_sync_upsert` leaves this file with the guard as its first statement and
-- with no EXECUTE for a client role. The anchored patch above keeps an installed guard, and a
-- create or replace keeps the privileges; this block and the revoke make that explicit. The
-- marker check keeps one guard, so 20261103090000 later skips the function.
do $migration$
declare
  definition text;
  replaced text;
begin
  select pg_get_functiondef(
    'public._sync_upsert(uuid,text,text,jsonb,integer)'::regprocedure
  ) into definition;
  if position('p9_sync_caller_guard' in definition) = 0 then
    -- First `begin` line of the body only (no 'g' flag): the guard becomes the first statement.
    replaced := regexp_replace(
      definition,
      '(\n[ \t]*begin[ \t]*\n)',
      $guard$\1  perform _sync_assert_caller(p_user_id); -- p9_sync_caller_guard
$guard$,
      'i'
    );
    if replaced = definition then
      raise exception 'Could not add the caller guard to _sync_upsert';
    end if;
    execute replaced;
  end if;
end;
$migration$;
revoke execute on function public._sync_upsert(uuid, text, text, jsonb, integer) from public, anon, authenticated;
grant execute on function public._sync_upsert(uuid, text, text, jsonb, integer) to service_role;
