-- Reverses 20270104090000_care_ledger_fixes.sql: drops care_balance and restores the
-- care_points_sync (20261225090100) and care_accolades_sync (20261225090300) bodies verbatim.
-- Roll the app back to the build that sums the ledger in JS before running this.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

drop function if exists public.care_balance(uuid);

create or replace function public.care_points_sync(p_user_id uuid, p_local_date date, p_zone text)
  returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  v_zone text;
  v_today date;
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
  if p_local_date > v_today then
    raise exception 'future_date' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':care_points', 0));

  -- Backfill never mints: a brand-new award is only ever computed for the account's own current
  -- local day. A date in the past that was never synced on its own day earns nothing retroactively
  -- -- the settle call below still promotes whatever that day DID earn (synced while it was still
  -- today) from pending to settled.
  if p_local_date = v_today then
    -- day_recorded: meals on 2+ occasions (distinct slot) that day.
    select count(distinct slot) into v_occasions from log_entries
     where user_id = p_user_id and local_date = p_local_date and deleted_at is null;
    if v_occasions >= 2 then
      v_row := _care_points_award(p_user_id, 'day_recorded:v1:' || p_local_date, 'v1', 'day_recorded',
        2, p_local_date, v_zone, 'pending', jsonb_build_object('occasions', v_occasions));
      if v_row.id is not null then
        v_awarded := v_awarded || jsonb_build_object('kind', 'day_recorded', 'delta', v_row.delta,
          'local_date', p_local_date);
      end if;
    end if;

    -- day_complete: the existing "day fully logged" mark (T6 E6).
    select day_complete_at is not null into v_day_complete from plan_days
     where user_id = p_user_id and local_date = p_local_date;
    if coalesce(v_day_complete, false) then
      v_row := _care_points_award(p_user_id, 'day_complete:v1:' || p_local_date, 'v1', 'day_complete',
        2, p_local_date, v_zone, 'pending', '{}'::jsonb);
      if v_row.id is not null then
        v_awarded := v_awarded || jsonb_build_object('kind', 'day_complete', 'delta', v_row.delta,
          'local_date', p_local_date);
      end if;
    end if;

    -- protein_goal: known daily_totals protein against the active profile's grams/floor (see the
    -- file header's approximation note).
    select dt.amount, dt.items_with_value into v_protein_have, v_protein_items from daily_totals dt
     where dt.user_id = p_user_id and dt.local_date = p_local_date and dt.nutrient_code = 'protein_g';
    select * into v_profile from target_profiles where user_id = p_user_id
     and effective_from <= p_local_date order by effective_from desc, rev desc limit 1;
    if v_profile.id is not null and v_protein_have is not null and v_protein_items > 0 then
      v_protein_target := greatest(coalesce(
        case when v_profile.mode = 'percent'
          then round(v_profile.kcal_train * v_profile.protein_pct / 100.0 / 4)
          else v_profile.protein_g end, 0), v_profile.protein_g_min);
      if v_protein_target > 0 and v_protein_have >= v_protein_target then
        v_row := _care_points_award(p_user_id, 'protein_goal:v1:' || p_local_date, 'v1', 'protein_goal',
          1, p_local_date, v_zone, 'pending',
          jsonb_build_object('have', v_protein_have, 'target', v_protein_target));
        if v_row.id is not null then
          v_awarded := v_awarded || jsonb_build_object('kind', 'protein_goal', 'delta', v_row.delta,
            'local_date', p_local_date);
        end if;
      end if;
    end if;

    -- water_goal: the SAME mode/formula Today shows (_care_water_goal), not just the manual columns.
    v_water_goal := _care_water_goal(p_user_id, p_local_date);
    select cups into v_water_have from water_log where user_id = p_user_id and local_date = p_local_date;
    if v_water_goal is not null and coalesce(v_water_have, 0) >= v_water_goal then
      v_row := _care_points_award(p_user_id, 'water_goal:v1:' || p_local_date, 'v1', 'water_goal',
        1, p_local_date, v_zone, 'pending', jsonb_build_object('have', v_water_have, 'goal', v_water_goal));
      if v_row.id is not null then
        v_awarded := v_awarded || jsonb_build_object('kind', 'water_goal', 'delta', v_row.delta,
          'local_date', p_local_date);
      end if;
    end if;

    -- Weekly rules: the local week containing today, counted through today only. Stored at the
    -- week's own closing Sunday (not today), so settlement naturally waits for the week to end
    -- (Sol review finding: dating it "today" let the row settle the moment the 5th/3rd day
    -- itself closed, long before the week actually did).
    v_monday := (p_local_date - (extract(isodow from p_local_date)::int - 1))::date;
    v_sunday := v_monday + 6;
    select count(*) into v_qualified_days from (
      select local_date from log_entries
       where user_id = p_user_id and deleted_at is null and local_date between v_monday and p_local_date
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
       and (hs.start_time at time zone v_zone)::date between v_monday and p_local_date;
    if v_weighin_days >= 3 then
      v_row := _care_points_award(p_user_id, 'weigh_in_week:v1:' || v_monday, 'v1', 'weigh_in_week',
        2, v_sunday, v_zone, 'pending', jsonb_build_object('week', v_monday, 'weighInDays', v_weighin_days));
      if v_row.id is not null then
        v_awarded := v_awarded || jsonb_build_object('kind', 'weigh_in_week', 'delta', v_row.delta,
          'local_date', v_sunday);
      end if;
    end if;
  end if;

  perform _care_points_settle(p_user_id, v_today);

  select coalesce(sum(delta), 0) into v_balance from care_points_ledger
   where user_id = p_user_id and status = 'settled';
  select coalesce(sum(delta), 0) into v_pending from care_points_ledger
   where user_id = p_user_id and status = 'pending';
  return jsonb_build_object('balance', v_balance, 'pending', v_pending, 'awarded', v_awarded);
end $$;
revoke all on function public.care_points_sync(uuid, date, text) from public, anon, authenticated;
grant execute on function public.care_points_sync(uuid, date, text) to authenticated, service_role;

create or replace function public.care_accolades_sync(p_user_id uuid, p_local_date date, p_zone text)
  returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  v_today date;
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

  -- full-week: only checked once the week has closed (today is its Sunday), and only for the
  -- account's own real today.
  if p_local_date is not null and p_local_date = v_today and extract(isodow from p_local_date)::int = 7 then
    v_monday := p_local_date - 6;
    select count(distinct local_date) into v_week_dates from log_entries
     where user_id = p_user_id and deleted_at is null and local_date between v_monday and p_local_date;
    if v_week_dates = 7 then
      v_row := _care_accolade_grant(p_user_id, 'full-week', jsonb_build_object('week', v_monday));
      if v_row.key is not null then v_granted := v_granted || to_jsonb(v_row.key); end if;
    end if;
  end if;

  -- welcome-back: active today, with a 7+ day silent gap right before it and at least one date
  -- before that gap. awards.ts's "at most once a month" is a weaker requirement than a grant
  -- ever earns only once (unique on user+key+version); this satisfies it without a time window.
  -- Only for the account's own real today (same reasoning as full-week above).
  if p_local_date is not null and p_local_date = v_today
     and exists (select 1 from log_entries where user_id = p_user_id and local_date = p_local_date
                   and deleted_at is null) then
    select max(local_date) into v_gap_start from log_entries
     where user_id = p_user_id and deleted_at is null and local_date < p_local_date;
    if v_gap_start is not null and p_local_date - v_gap_start >= 8 then
      v_row := _care_accolade_grant(p_user_id, 'welcome-back', jsonb_build_object('gapStart', v_gap_start));
      if v_row.key is not null then v_granted := v_granted || to_jsonb(v_row.key); end if;
    end if;
  end if;

  return jsonb_build_object('granted', v_granted);
end $$;
revoke all on function public.care_accolades_sync(uuid, date, text) from public, anon, authenticated;
grant execute on function public.care_accolades_sync(uuid, date, text) to authenticated, service_role;
