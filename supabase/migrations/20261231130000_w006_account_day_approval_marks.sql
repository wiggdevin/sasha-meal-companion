-- W006 (audit 2026-10-10 A075, A098, P20): two server writes that dated by the wrong day.
--
-- 1. approve_target_proposal dated the new revision `coalesce(week_start, current_date)` and read
--    the revision in force with `effective_from <= current_date`. Since the weekly job moved to
--    the week just ending, `week_start` is a Monday 7-13 days in the past: the approval rewrote
--    targets for days already lived, and a revision written since (a profile edit, a weigh-in
--    recompute) shadowed it, so "Approved" changed nothing. `current_date` is the database's UTC
--    date, not the account's (lib/server/account-day.ts, t24b): a U.S. evening approval could read
--    tomorrow's scheduled revision as the one in force and copy its floors and pace.
--    Now both use the account's day: the stored `user_settings.time_zone` when Postgres knows it,
--    else UTC as the last resort (the order lib/server/account-day.ts uses when the request carries
--    no day). The approved revision takes effect on that day.
--
-- 2. plan_days_record_first_mark set `day_marks_started_on` to the MARKED day and moved it earlier
--    for every older mark. Ruling R3 wants the date marking BEGAN: one back-dated "I logged
--    everything that day" tap otherwise disqualified every unmarked, coverage-complete day since
--    that date (lib/expenditure.ts isQualifiedDay) and dropped an adaptive estimate to its seed.
--    Now the first mark ever stores the account's day at the moment it is made; later marks, of
--    any date, never move it, and clearing a mark still cannot bring the old rule back.
--    Existing values are left as they are (no backfill): a cleared first mark leaves no trace, so
--    the true start cannot be rebuilt from the table.
--
-- Patches approve_target_proposal(uuid, uuid) by anchor (the rate_goals / seed_freeze pattern),
-- refusing a partial patch; its signature and privileges are unchanged (service_role only since
-- 20261228090000; CREATE OR REPLACE keeps them). Live-safe: function DDL only, no table lock beyond
-- the catalog rows; lock_timeout bounds it. Order: apply to production BEFORE the W006 code merges.
-- Down: supabase/migrations/down/20261231130000_w006_account_day_approval_marks.down.sql.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

-- The account's local date now: its stored zone when Postgres knows the name, else UTC.
create or replace function public._account_local_date(p_user_id uuid)
returns date
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare
  v_zone text;
begin
  select s.time_zone into v_zone from public.user_settings s where s.user_id = p_user_id;
  if v_zone is not null
     and exists (select 1 from pg_catalog.pg_timezone_names z where z.name = v_zone) then
    return (pg_catalog.now() at time zone v_zone)::date;
  end if;
  return (pg_catalog.now() at time zone 'UTC')::date;
end
$fn$;
revoke all on function public._account_local_date(uuid) from public, anon, authenticated;
grant execute on function public._account_local_date(uuid) to service_role;
comment on function public._account_local_date(uuid) is
  'W006: the account''s local date now (stored user_settings.time_zone, else UTC). SQL twin of '
  'lib/server/account-day.ts for a request that carries no day.';

do $migration$
declare
  definition text;
  froms text[] := array[
    '  v_rest_carbs integer;',
    '  v_proposed := v_prop.proposed;',
    'effective_from <= current_date',
    '''effective_from'', coalesce(v_prop.week_start, current_date),'];
  tos text[] := array[
    '  v_rest_carbs integer;
  v_day date;',
    '  v_proposed := v_prop.proposed;
  -- W006 (A075, A098): the account''s day, for the revision in force and the new one''s date.
  v_day := public._account_local_date(p_user_id);',
    'effective_from <= v_day',
    '''effective_from'', v_day,'];
  occurrences integer;
  i integer;
begin
  select pg_get_functiondef('public.approve_target_proposal(uuid,uuid)'::regprocedure)
    into definition;
  if position('_account_local_date' in definition) > 0 then
    return;
  end if;
  for i in 1 .. array_length(froms, 1) loop
    occurrences := (length(definition) - length(replace(definition, froms[i], '')))
      / length(froms[i]);
    if occurrences <> 1 then
      raise exception 'w006 (approve_target_proposal): anchor % occurs % times, expected once; refusing a partial function',
        i, occurrences;
    end if;
    definition := replace(definition, froms[i], tos[i]);
  end loop;
  execute definition;
end;
$migration$;
revoke execute on function public.approve_target_proposal(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.approve_target_proposal(uuid, uuid) to service_role;

-- R3 (P20): the date marking began, set once by the first mark, never by the marked date.
create or replace function public.plan_days_record_first_mark() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  if new.day_complete_at is not null then
    update public.user_settings set day_marks_started_on = public._account_local_date(new.user_id)
      where user_id = new.user_id and day_marks_started_on is null;
  end if;
  return null;
end $$;
revoke all on function public.plan_days_record_first_mark() from public, anon, authenticated;
