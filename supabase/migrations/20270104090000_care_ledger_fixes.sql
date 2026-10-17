-- W067 (audit 2026-10-10 F26: A106, A107, A108): three fixes to the Seeds ledger and accolades.
--
--   care_balance          new. The settled balance and the pending sum, summed in SQL over every
--                         ledger row. GET /api/care/points and GET /api/care/shop summed a plain
--                         PostgREST select in JS, which the API's 1,000-row cap cut short with no
--                         sign (A106); care_purchase already sums the whole ledger in SQL, so the
--                         shop could say "insufficient" for an item the account can afford.
--   care_points_sync      replaced. The phone's day is used as sent within one date of the stored
--                         zone's today and clamped to it beyond that, never refused (A108); see the
--                         function's own comment. Every rule is otherwise unchanged.
--   care_accolades_sync   replaced. full-week is checked for the closed week before the account's
--                         day on any sync, and for the week ending that day on a Sunday (A107); it
--                         could only be granted by a sync on the Sunday itself. Its date-gated
--                         grants (full-week, welcome-back) read a day that is never past the stored
--                         zone's today, through two new revoked helpers, _care_accolade_day and
--                         _care_full_week_mondays. Every other grant is unchanged.
--
-- Care points hold no nutrition or safety data. Live-safe: three new functions, two function bodies
-- replaced with the same signatures and grants; no table changes. Apply before the code merges:
-- the new code calls care_balance.
-- Down: supabase/migrations/down/20270104090000_care_ledger_fixes.down.sql.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

create function public.care_balance(p_user_id uuid) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  v_balance integer;
  v_pending integer;
begin
  perform _sync_assert_caller(p_user_id);
  select coalesce(sum(delta) filter (where status = 'settled'), 0),
         coalesce(sum(delta) filter (where status = 'pending'), 0)
    into v_balance, v_pending
    from care_points_ledger where user_id = p_user_id;
  return jsonb_build_object('balance', v_balance, 'pending', v_pending);
end $$;
revoke all on function public.care_balance(uuid) from public, anon, authenticated;
grant execute on function public.care_balance(uuid) to authenticated, service_role;

create or replace function public.care_points_sync(p_user_id uuid, p_local_date date, p_zone text)
  returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  v_zone text;
  v_today date;
  v_day date;
  v_monday date;
  v_sunday date;
  v_occasions integer;
  v_day_complete boolean;
  v_profile target_profiles%rowtype;
  v_protein_have numeric;
  v_protein_items integer;
  v_protein_target numeric;
  v_water_goal numeric;
  v_water_have integer;
  v_qualified_days integer;
  v_weighin_days integer;
  v_row care_points_ledger%rowtype;
  v_awarded jsonb := '[]'::jsonb;
  v_balance integer;
  v_pending integer;
begin
  perform _sync_assert_caller(p_user_id);
  if p_local_date is null then raise exception 'local_date_required' using errcode = '22023'; end if;
  if p_zone is null or char_length(p_zone) = 0 or char_length(p_zone) > 64 then
    raise exception 'zone_required' using errcode = '22023';
  end if;
  -- The account's own stored zone wins over p_zone (see _care_effective_zone's comment).
  v_zone := _care_effective_zone(p_user_id, p_zone);
  v_today := (now() at time zone v_zone)::date;
  -- W067 (audit A108): the phone's own day is the account's day (lib/server/account-day.ts), and
  -- it can sit one date either side of the stored zone's today (a trip across the date line, or
  -- a zone stored before a move). Within that one-date window it is used as sent; anything
  -- further is clamped to the stored zone's today. It never raises: the old 22023 future_date
  -- failed every Seeds and shop read for a phone one day ahead, and a phone one day behind
  -- minted nothing. Rows minted for v_day stay pending until v_day itself has closed: settlement
  -- below runs up to the earlier of v_day and the stored zone's today, so a day-behind phone's
  -- in-progress day is rechecked against the real rows on a later sync (_care_points_settle),
  -- never settled in the call that minted it.
  v_day := case when p_local_date between v_today - 1 and v_today + 1 then p_local_date else v_today end;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':care_points', 0));

  -- Backfill never mints past the one-date window above: a brand-new award is only ever computed
  -- for the account's own current local day (v_day). A date more than one day back that was never
  -- synced on its own day earns nothing retroactively -- the settle call below still promotes whatever that
  -- day DID earn (synced while it was still today) from pending to settled.
  begin
    -- day_recorded: meals on 2+ occasions (distinct slot) that day.
    select count(distinct slot) into v_occasions from log_entries
     where user_id = p_user_id and local_date = v_day and deleted_at is null;
    if v_occasions >= 2 then
      v_row := _care_points_award(p_user_id, 'day_recorded:v1:' || v_day, 'v1', 'day_recorded',
        2, v_day, v_zone, 'pending', jsonb_build_object('occasions', v_occasions));
      if v_row.id is not null then
        v_awarded := v_awarded || jsonb_build_object('kind', 'day_recorded', 'delta', v_row.delta,
          'local_date', v_day);
      end if;
    end if;

    -- day_complete: the existing "day fully logged" mark (T6 E6).
    select day_complete_at is not null into v_day_complete from plan_days
     where user_id = p_user_id and local_date = v_day;
    if coalesce(v_day_complete, false) then
      v_row := _care_points_award(p_user_id, 'day_complete:v1:' || v_day, 'v1', 'day_complete',
        2, v_day, v_zone, 'pending', '{}'::jsonb);
      if v_row.id is not null then
        v_awarded := v_awarded || jsonb_build_object('kind', 'day_complete', 'delta', v_row.delta,
          'local_date', v_day);
      end if;
    end if;

    -- protein_goal: known daily_totals protein against the active profile's grams/floor (see the
    -- file header's approximation note).
    select dt.amount, dt.items_with_value into v_protein_have, v_protein_items from daily_totals dt
     where dt.user_id = p_user_id and dt.local_date = v_day and dt.nutrient_code = 'protein_g';
    select * into v_profile from target_profiles where user_id = p_user_id
     and effective_from <= v_day order by effective_from desc, rev desc limit 1;
    if v_profile.id is not null and v_protein_have is not null and v_protein_items > 0 then
      v_protein_target := greatest(coalesce(
        case when v_profile.mode = 'percent'
          then round(v_profile.kcal_train * v_profile.protein_pct / 100.0 / 4)
          else v_profile.protein_g end, 0), v_profile.protein_g_min);
      if v_protein_target > 0 and v_protein_have >= v_protein_target then
        v_row := _care_points_award(p_user_id, 'protein_goal:v1:' || v_day, 'v1', 'protein_goal',
          1, v_day, v_zone, 'pending',
          jsonb_build_object('have', v_protein_have, 'target', v_protein_target));
        if v_row.id is not null then
          v_awarded := v_awarded || jsonb_build_object('kind', 'protein_goal', 'delta', v_row.delta,
            'local_date', v_day);
        end if;
      end if;
    end if;

    -- water_goal: the SAME mode/formula Today shows (_care_water_goal), not just the manual columns.
    v_water_goal := _care_water_goal(p_user_id, v_day);
    select cups into v_water_have from water_log where user_id = p_user_id and local_date = v_day;
    if v_water_goal is not null and coalesce(v_water_have, 0) >= v_water_goal then
      v_row := _care_points_award(p_user_id, 'water_goal:v1:' || v_day, 'v1', 'water_goal',
        1, v_day, v_zone, 'pending', jsonb_build_object('have', v_water_have, 'goal', v_water_goal));
      if v_row.id is not null then
        v_awarded := v_awarded || jsonb_build_object('kind', 'water_goal', 'delta', v_row.delta,
          'local_date', v_day);
      end if;
    end if;

    -- Weekly rules: the local week containing today, counted through today only. Stored at the
    -- week's own closing Sunday (not today), so settlement naturally waits for the week to end
    -- (Sol review finding: dating it "today" let the row settle the moment the 5th/3rd day
    -- itself closed, long before the week actually did).
    v_monday := (v_day - (extract(isodow from v_day)::int - 1))::date;
    v_sunday := v_monday + 6;
    select count(*) into v_qualified_days from (
      select local_date from log_entries
       where user_id = p_user_id and deleted_at is null and local_date between v_monday and v_day
       group by local_date having count(distinct slot) >= 2
    ) q;
    if v_qualified_days >= 5 then
      v_row := _care_points_award(p_user_id, 'five_day_week:v1:' || v_monday, 'v1', 'five_day_week',
        5, v_sunday, v_zone, 'pending', jsonb_build_object('week', v_monday, 'qualifiedDays', v_qualified_days));
      if v_row.id is not null then
        v_awarded := v_awarded || jsonb_build_object('kind', 'five_day_week', 'delta', v_row.delta,
          'local_date', v_sunday);
      end if;
    end if;

    select count(distinct (hs.start_time at time zone v_zone)::date) into v_weighin_days
      from health_samples hs where hs.user_id = p_user_id and hs.type = 'body_mass'
       and (hs.start_time at time zone v_zone)::date between v_monday and v_day;
    if v_weighin_days >= 3 then
      v_row := _care_points_award(p_user_id, 'weigh_in_week:v1:' || v_monday, 'v1', 'weigh_in_week',
        2, v_sunday, v_zone, 'pending', jsonb_build_object('week', v_monday, 'weighInDays', v_weighin_days));
      if v_row.id is not null then
        v_awarded := v_awarded || jsonb_build_object('kind', 'weigh_in_week', 'delta', v_row.delta,
          'local_date', v_sunday);
      end if;
    end if;
  end;

  perform _care_points_settle(p_user_id, least(v_today, v_day));

  select coalesce(sum(delta) filter (where status = 'settled'), 0),
         coalesce(sum(delta) filter (where status = 'pending'), 0)
    into v_balance, v_pending
    from care_points_ledger where user_id = p_user_id;
  return jsonb_build_object('balance', v_balance, 'pending', v_pending, 'awarded', v_awarded);
end $$;
revoke all on function public.care_points_sync(uuid, date, text) from public, anon, authenticated;
grant execute on function public.care_points_sync(uuid, date, text) to authenticated, service_role;

-- The day care_accolades_sync's date-gated grants read (see its comment): one date behind the
-- stored zone's today as sent, anything else clamped to that today, null stays null.
create function public._care_accolade_day(p_local_date date, p_today date) returns date
  language sql immutable set search_path = public as $fn$
    select case when p_local_date is null or p_today is null then null
                when p_local_date between p_today - 1 and p_today then p_local_date
                else p_today end
  $fn$;
revoke all on function public._care_accolade_day(date, date) from public, anon, authenticated;

-- The Mondays of the closed weeks full-week checks for p_day: the week before p_day's week, and
-- p_day's own week when p_day is its Sunday. Every week ends on or before p_day.
create function public._care_full_week_mondays(p_day date) returns date[]
  language sql immutable set search_path = public as $fn$
    select case when p_day is null then '{}'::date[]
                when extract(isodow from p_day)::int = 7 then array[p_day - 13, p_day - 6]
                else array[(p_day - extract(isodow from p_day)::int - 6)::date] end
  $fn$;
revoke all on function public._care_full_week_mondays(date) from public, anon, authenticated;

create or replace function public.care_accolades_sync(p_user_id uuid, p_local_date date, p_zone text)
  returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  v_today date;
  v_day date;
  v_active_dates integer;
  v_granted jsonb := '[]'::jsonb;
  v_row care_accolades%rowtype;
  v_monday date;
  v_week_dates integer;
  v_gap_start date;
begin
  perform _sync_assert_caller(p_user_id);
  -- Sol review finding: this function used to trust p_local_date outright (and never read
  -- p_zone at all), so a direct caller naming a future Sunday with future-dated log rows could
  -- grant full-week before that week was real. The two date-gated checks below now run only
  -- when p_local_date is the account's own current day, anchored the same way
  -- care_points_sync is (the account's stored zone first; 20261225090100's _care_effective_zone).
  v_today := case when p_zone is not null and char_length(p_zone) between 1 and 64
    then (now() at time zone _care_effective_zone(p_user_id, p_zone))::date else null end;
  -- W067 (audit A108): the account's day for the two date-gated grants below. A phone day one date
  -- behind the stored zone's today is used as sent; any other date, a day ahead included, is
  -- clamped to that today, so neither grant ever reads a date the stored zone has not reached
  -- (care_points_sync's window also takes a day ahead, but only for pending Seeds that settle
  -- after a recheck; an accolade is permanent). A null p_local_date (or zone) keeps v_day null and
  -- skips both, as before.
  v_day := _care_accolade_day(p_local_date, v_today);

  if exists (select 1 from log_entries where user_id = p_user_id and deleted_at is null) then
    v_row := _care_accolade_grant(p_user_id, 'first-meal', '{}'::jsonb);
    if v_row.key is not null then v_granted := v_granted || to_jsonb(v_row.key); end if;
  end if;

  if exists (select 1 from plan_days where user_id = p_user_id and day_complete_at is not null) then
    v_row := _care_accolade_grant(p_user_id, 'first-complete-day', '{}'::jsonb);
    if v_row.key is not null then v_granted := v_granted || to_jsonb(v_row.key); end if;
  end if;

  if exists (select 1 from recipe_plan_selections where user_id = p_user_id) then
    v_row := _care_accolade_grant(p_user_id, 'first-recipe', '{}'::jsonb);
    if v_row.key is not null then v_granted := v_granted || to_jsonb(v_row.key); end if;
  end if;

  select count(distinct local_date) into v_active_dates from log_entries
   where user_id = p_user_id and deleted_at is null;
  if v_active_dates >= 7 then
    v_row := _care_accolade_grant(p_user_id, 'seven-days', jsonb_build_object('activeDates', v_active_dates));
    if v_row.key is not null then v_granted := v_granted || to_jsonb(v_row.key); end if;
  end if;
  if v_active_dates >= 30 then
    v_row := _care_accolade_grant(p_user_id, 'thirty-days', jsonb_build_object('activeDates', v_active_dates));
    if v_row.key is not null then v_granted := v_granted || to_jsonb(v_row.key); end if;
  end if;

  if (select count(distinct local_date) from care_points_ledger
       where user_id = p_user_id and kind = 'protein_goal' and status = 'settled') >= 5 then
    v_row := _care_accolade_grant(p_user_id, 'protein-5', '{}'::jsonb);
    if v_row.key is not null then v_granted := v_granted || to_jsonb(v_row.key); end if;
  end if;
  if (select count(distinct local_date) from care_points_ledger
       where user_id = p_user_id and kind = 'water_goal' and status = 'settled') >= 5 then
    v_row := _care_accolade_grant(p_user_id, 'water-5', '{}'::jsonb);
    if v_row.key is not null then v_granted := v_granted || to_jsonb(v_row.key); end if;
  end if;
  if (select count(distinct local_date) from care_points_ledger
       where user_id = p_user_id and kind in ('protein_goal', 'water_goal') and status = 'settled') >= 5 then
    v_row := _care_accolade_grant(p_user_id, 'goal-5', '{}'::jsonb);
    if v_row.key is not null then v_granted := v_granted || to_jsonb(v_row.key); end if;
  end if;
  if (select count(distinct local_date) from care_points_ledger
       where user_id = p_user_id and kind in ('protein_goal', 'water_goal') and status = 'settled') >= 20 then
    v_row := _care_accolade_grant(p_user_id, 'goal-20', '{}'::jsonb);
    if v_row.key is not null then v_granted := v_granted || to_jsonb(v_row.key); end if;
  end if;

  -- full-week (W067, audit A107): a retained meal on all seven dates of a local Monday-Sunday
  -- week that has closed. Any sync checks the week before the account's day (so a Monday-to-
  -- Saturday sync still grants it), and on a Sunday the week ending that day, as before. v_day is
  -- never past the stored zone's today, so both weeks end on or before it: a stored Saturday with
  -- a phone already on Sunday checks only the week before.
  if v_day is not null then
    foreach v_monday in array _care_full_week_mondays(v_day)
    loop
      select count(distinct local_date) into v_week_dates from log_entries
       where user_id = p_user_id and deleted_at is null and local_date between v_monday and v_monday + 6;
      if v_week_dates = 7 then
        v_row := _care_accolade_grant(p_user_id, 'full-week', jsonb_build_object('week', v_monday));
        if v_row.key is not null then v_granted := v_granted || to_jsonb(v_row.key); end if;
      end if;
    end loop;
  end if;

  -- welcome-back: active today, with a 7+ day silent gap right before it and at least one date
  -- before that gap. awards.ts's "at most once a month" is a weaker requirement than a grant
  -- ever earns only once (unique on user+key+version); this satisfies it without a time window.
  -- Only for the account's own day (v_day above: never past the stored zone's today).
  if v_day is not null
     and exists (select 1 from log_entries where user_id = p_user_id and local_date = v_day
                   and deleted_at is null) then
    select max(local_date) into v_gap_start from log_entries
     where user_id = p_user_id and deleted_at is null and local_date < v_day;
    if v_gap_start is not null and v_day - v_gap_start >= 8 then
      v_row := _care_accolade_grant(p_user_id, 'welcome-back', jsonb_build_object('gapStart', v_gap_start));
      if v_row.key is not null then v_granted := v_granted || to_jsonb(v_row.key); end if;
    end if;
  end if;

  return jsonb_build_object('granted', v_granted);
end $$;
revoke all on function public.care_accolades_sync(uuid, date, text) from public, anon, authenticated;
grant execute on function public.care_accolades_sync(uuid, date, text) to authenticated, service_role;
