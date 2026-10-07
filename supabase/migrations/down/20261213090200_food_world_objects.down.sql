-- Reverse of 20261213090200_food_world_objects.sql.
-- Runs alone: it drops only its own objects and skips any table that is already gone.
-- Rollback order: revert the app deploy, then the down files from 20261213091200 back to 20261213090000.
-- Dropping a function a remaining trigger still uses fails: run the trigger downs (091200..090300)
-- first, or the function is kept (the drops below are guarded by that check). Refuses to drop
-- condition confirmations unless app.allow_down_data_loss = on.
do $$
begin
  if to_regclass('public.food_world_condition_confirmations') is not null
     and exists (select 1 from public.food_world_condition_confirmations)
     and coalesce(current_setting('app.allow_down_data_loss', true), '') <> 'on' then
    raise exception 'food_world_objects down: condition confirmations exist; set app.allow_down_data_loss = on to drop them';
  end if;
end $$;
do $$
declare
  f text;
begin
  foreach f in array array['public.evidence_clock_bump()', 'public.rules_clock_bump()',
    'public._bump_rules_clock(uuid)', 'public.constraint_profiles_condition_gate()',
    'public.user_settings_food_world_guard()', 'public._food_world_lock(uuid)',
    'public.food_world_unconfirmed(uuid, text[])', 'public.food_world_condition_key(text)'] loop
    if to_regprocedure(f) is not null
       and not exists (select 1 from pg_trigger where tgfoid = to_regprocedure(f)) then
      execute 'drop function ' || f;
    end if;
  end loop;
end $$;
drop table if exists public.evidence_clock;
drop table if exists public.account_rules_clock;
drop table if exists public.food_world_condition_confirmations;
