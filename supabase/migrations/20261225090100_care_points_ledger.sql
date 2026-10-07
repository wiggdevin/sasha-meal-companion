-- UI-NEEDS SPROUT-CARE item 1 (coord.md 2026-10-07T04:15Z; earning rules:
-- ~/Inbox/plans/2026-10-06-sasha-sprout-card-astra.md §5/§8): Seeds, earned for taking care of
-- yourself. The server computes eligibility; nothing here trusts a kind, delta or date the caller
-- names -- `care_points_sync` re-derives every signal itself from log_entries, plan_days,
-- water_log, target_profiles, daily_totals and health_samples, the same tables the app's own
-- pages already read. A direct PostgREST call (bypassing the Next.js route) can still only ever
-- earn what the real data supports.
--
--   care_points_ledger   one immutable row per awarded (or reversed) event, unique per account and
--                        `event_key` (so a repeat sync is a no-op). `status`: 'pending' while the
--                        event's own local day has not yet closed in the account's zone at sync
--                        time, 'settled' once it has, 'reversed' for a correction row (negative
--                        delta, `reverses` the settled row it undoes). The spendable balance is
--                        the settled-row sum; `care_purchase` (20261225090200) debits it under the
--                        same per-account advisory lock `care_points_sync` takes, so purchase and
--                        award can never race into a negative balance.
--
-- Known approximations, flagged rather than silently guessed (owner may tune, per the brief):
--   - "protein target reached" compares `daily_totals` (protein_g, already the app's own rollup)
--     against `target_profiles`' base grams/floor, not the full pinned-revision resolution
--     `lib/server/targets.ts` uses for display. A profile with no active revision, or one whose
--     pin differs from its base grams, can disagree with what Today shows by a few grams.
--   - "water goal reached" (`_care_water_goal`) ports `lib/water-goal.ts`'s mode/formula
--     (auto-by-weight vs. the manual `water_goal_cups_*` columns) by hand; a divergence there is
--     a port bug, not a deliberately accepted gap (Sol review r1 BLOCK: the first version always
--     read the manual columns, which disagreed with Today whenever an account was in auto mode).
--   - "day marked complete" is the existing `plan_days.day_complete_at` mark (T6 E6), the same
--     "day fully logged" flag Today already shows; this migration does not add a new mark.
--   - weekly rules key their event on the Monday that starts the account's local week
--     (`lib/server/jobs.ts mondayOf`, Sunday belongs to the week just ending), award once the
--     qualifying count is reached, and are DATED at that Sunday (not the day they were computed
--     on) so `_care_points_settle`'s own "local_date has closed" rule is what makes them wait for
--     the week to actually end (Sol review r1 BLOCK: dating them "today" let a weekly row settle
--     the moment the 5th/3rd day itself closed).
--   - every account's own `user_settings.time_zone` wins over whatever zone a call passes
--     (`_care_effective_zone`); a zone argument only ever applies when no stored zone exists yet
--     (Sol review r1 BLOCK: a direct caller could otherwise pick a zone ahead of their own
--     account to settle a pending award early).
--   - `_care_points_settle` re-verifies each pending row's own condition (`_care_points_recheck`)
--     before promoting it, and deletes it instead when the evidence is gone (Sol review r1 BLOCK:
--     a blanket settle could promote, and make spendable, a row for a mark/log/water total the
--     account had since undone).
--
-- Live-safe: one new table, RLS on from creation, five new functions; no existing table or
-- function is altered. Down: supabase/migrations/down/20261225090100_care_points_ledger.down.sql.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

do $$
begin
  if to_regclass('public.care_points_ledger') is not null then
    raise exception '20261225090100_care_points_ledger: already applied';
  end if;
end $$;

create table public.care_points_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  event_key text not null,
  rule_version text not null,
  kind text not null check (kind in ('day_recorded', 'day_complete', 'protein_goal', 'water_goal',
    'five_day_week', 'weigh_in_week', 'purchase', 'reversal')),
  delta integer not null check (delta <> 0),
  local_date date not null,
  zone text not null check (char_length(zone) between 1 and 64),
  status text not null check (status in ('pending', 'settled', 'reversed')),
  -- Opaque to this table: ids/snapshots care_points_sync and care_purchase used to decide the
  -- award (an item id for a purchase, the qualifying dates for a weekly rule, and so on).
  source jsonb not null default '{}'::jsonb,
  -- Deliberately not a foreign key: a self-referencing FK on this table would need its own
  -- same-owner guard trigger (20261103090100's trigger only covers the tables that existed at
  -- that migration), and nothing in this pass ever writes a 'reversal' row yet -- the column is
  -- reserved for that future correction path.
  reverses uuid,
  created_at timestamptz not null default now(),
  constraint care_points_ledger_event unique (user_id, event_key),
  constraint care_points_ledger_reversal check ((kind = 'reversal') = (reverses is not null))
);
create index care_points_ledger_user_date on public.care_points_ledger (user_id, local_date);
comment on table public.care_points_ledger is
  'UI-NEEDS SPROUT-CARE item 1: one immutable Seeds event per account and event_key. Written only '
  'by care_points_sync / care_purchase / care_points_settle.';

alter table public.care_points_ledger enable row level security;
create policy care_points_ledger_select on public.care_points_ledger for select to authenticated
  using (user_id = (select auth.uid()));
revoke all on table public.care_points_ledger from public, anon, authenticated, service_role;
grant select on table public.care_points_ledger to authenticated;
-- service_role: read, and insert as the tenancy fixtures do; no role updates or deletes (ledger
-- rows are immutable; a correction is a new 'reversal' row, never an edit).
grant select, insert on table public.care_points_ledger to service_role;

-- One idempotent insert. Returns the inserted row, or null when event_key already exists (a
-- repeat sync, or the window overlapping an earlier call's work).
create function public._care_points_award(p_user uuid, p_event_key text, p_rule_version text,
  p_kind text, p_delta integer, p_local_date date, p_zone text, p_status text, p_source jsonb)
  returns public.care_points_ledger
  language plpgsql security definer set search_path = public as $$
declare v_row care_points_ledger%rowtype;
begin
  insert into care_points_ledger (user_id, event_key, rule_version, kind, delta, local_date, zone,
    status, source)
  values (p_user, p_event_key, p_rule_version, p_kind, p_delta, p_local_date, p_zone, p_status,
          p_source)
  on conflict (user_id, event_key) do nothing
  returning * into v_row;
  return v_row;
end $$;
revoke all on function public._care_points_award(uuid, text, text, text, integer, date, text, text, jsonb)
  from public, anon, authenticated;

-- The account's own stored zone (`user_settings.time_zone`, a real IANA name) wins over
-- whatever `p_fallback` the caller passed in this call -- Sol review finding: `p_zone` is a
-- plain per-call parameter a direct PostgREST caller (not only the Next.js route) can set to
-- anything, every single call, with nothing persisted to audit; the stored zone is the same
-- settings column `accountDay` (lib/server/account-day.ts) already prefers for this exact
-- reason, so a raw caller can no longer pick a zone ahead of their own account to settle a
-- pending award early. `p_fallback` only ever applies to an account with no stored zone yet.
create function public._care_effective_zone(p_user uuid, p_fallback text) returns text
  language sql stable security definer set search_path = public as $fn$
    select coalesce(
      (select time_zone from user_settings
        where user_id = p_user and time_zone is not null
          and time_zone in (select name from pg_timezone_names)),
      p_fallback)
  $fn$;
revoke all on function public._care_effective_zone(uuid, text) from public, anon, authenticated;

-- The water goal for one local day, resolving the SAME mode and formula lib/water-goal.ts does
-- (`waterGoalMode` / `autoGoalCups`), so an account in its default auto mode is judged against
-- the goal Today actually shows, not the manual columns' 8-cup default (Sol review finding).
-- Shared by the award path and `_care_points_recheck`, so the two can never diverge.
create function public._care_water_goal(p_user uuid, p_local_date date) returns numeric
  language plpgsql security definer set search_path = public as $$
declare
  v_settings user_settings%rowtype;
  v_day_type text;
  v_water_mode text;
  v_weight_kg numeric;
  v_profile_weight numeric;
  v_cups_est numeric;
  v_base_oz numeric;
  v_bonus_oz numeric;
begin
  select * into v_settings from user_settings where user_id = p_user;
  v_day_type := coalesce(
    (select day_type_override from plan_days where user_id = p_user and local_date = p_local_date),
    case when extract(dow from p_local_date)::int = any(coalesce(v_settings.training_weekdays, '{}'::smallint[]))
         then (case when extract(dow from p_local_date)::int = 3 then 'training-7-fasted' else 'training-10' end)
         else 'rest' end);

  -- waterPrefsOfDietPrefs(dietPrefs).goal, else hasManualGoal(stored) ? 'manual' : 'auto'
  -- (lib/water-prefs.ts, lib/water-goal.ts). WATER_GOAL_MIN=1, DEFAULT_WATER_GOAL_CUPS=8.
  v_water_mode := case when v_settings.diet_prefs->'water'->>'goal' in ('auto', 'manual')
                    then v_settings.diet_prefs->'water'->>'goal' end;
  if v_water_mode is null then
    v_water_mode := case when
        (v_settings.water_goal_cups_training is not null and v_settings.water_goal_cups_training >= 1
          and v_settings.water_goal_cups_training <> 8)
        or (v_settings.water_goal_cups_rest is not null and v_settings.water_goal_cups_rest >= 1
          and v_settings.water_goal_cups_rest <> 8)
      then 'manual' else 'auto' end;
  end if;

  if v_water_mode = 'manual' then
    return case when v_day_type = 'rest' then coalesce(v_settings.water_goal_cups_rest, 8)
                else coalesce(v_settings.water_goal_cups_training, 8) end;
  end if;

  -- autoGoalCups: the active target revision's own input weight first, else the profile's.
  select input_weight_kg into v_profile_weight from target_profiles where user_id = p_user
   and effective_from <= p_local_date order by effective_from desc, rev desc limit 1;
  v_weight_kg := coalesce(v_profile_weight, v_settings.weight_kg);
  if v_weight_kg is null or v_weight_kg <= 0 then return 8; end if;
  -- LB_PER_KG (lib/health/units.ts) * OZ_PER_LB (lib/water-goal.ts) / OZ_PER_CUP (lib/water.ts).
  v_cups_est := round(v_weight_kg * 2.2046226218 * 0.6 / 8);
  v_base_oz := greatest(64, least(160, v_cups_est * 8));
  v_bonus_oz := case when v_day_type <> 'rest' then 16 else 0 end;
  return round(least(160, v_base_oz + v_bonus_oz) / 8.0);
end $$;
revoke all on function public._care_water_goal(uuid, date) from public, anon, authenticated;

-- Whether a still-pending row's own condition still holds, re-read from the real tables right
-- now (Sol review finding: a blanket settle promoted a row even after the user had since
-- cleared the mark/log/water it was awarded for). A weekly row's week is read back from its own
-- `source.week`, never from `local_date` (which now names the week's own closing Sunday, not
-- the day it was first computed on -- see care_points_sync). `purchase` / `reversal` rows are
-- never pending, so they are not re-checked; true is the harmless default for them.
create function public._care_points_recheck(p_user uuid, p_row public.care_points_ledger)
  returns boolean
  language plpgsql security definer set search_path = public as $$
declare
  v_occasions integer;
  v_profile target_profiles%rowtype;
  v_protein_have numeric;
  v_protein_items integer;
  v_protein_target numeric;
  v_water_goal numeric;
  v_water_have integer;
  v_monday date;
  v_qualified_days integer;
  v_weighin_days integer;
begin
  case p_row.kind
  when 'day_recorded' then
    select count(distinct slot) into v_occasions from log_entries
     where user_id = p_user and local_date = p_row.local_date and deleted_at is null;
    return coalesce(v_occasions, 0) >= 2;
  when 'day_complete' then
    return exists (select 1 from plan_days where user_id = p_user and local_date = p_row.local_date
                     and day_complete_at is not null);
  when 'protein_goal' then
    select dt.amount, dt.items_with_value into v_protein_have, v_protein_items from daily_totals dt
     where dt.user_id = p_user and dt.local_date = p_row.local_date and dt.nutrient_code = 'protein_g';
    select * into v_profile from target_profiles where user_id = p_user
     and effective_from <= p_row.local_date order by effective_from desc, rev desc limit 1;
    if v_profile.id is null or v_protein_have is null or coalesce(v_protein_items, 0) = 0 then
      return false;
    end if;
    v_protein_target := greatest(coalesce(
      case when v_profile.mode = 'percent'
        then round(v_profile.kcal_train * v_profile.protein_pct / 100.0 / 4)
        else v_profile.protein_g end, 0), v_profile.protein_g_min);
    return v_protein_target > 0 and v_protein_have >= v_protein_target;
  when 'water_goal' then
    v_water_goal := _care_water_goal(p_user, p_row.local_date);
    select cups into v_water_have from water_log where user_id = p_user and local_date = p_row.local_date;
    return v_water_goal is not null and coalesce(v_water_have, 0) >= v_water_goal;
  when 'five_day_week' then
    v_monday := (p_row.source->>'week')::date;
    if v_monday is null then return false; end if;
    select count(*) into v_qualified_days from (
      select local_date from log_entries where user_id = p_user and deleted_at is null
       and local_date between v_monday and v_monday + 6
       group by local_date having count(distinct slot) >= 2
    ) q;
    return v_qualified_days >= 5;
  when 'weigh_in_week' then
    v_monday := (p_row.source->>'week')::date;
    if v_monday is null then return false; end if;
    select count(distinct (hs.start_time at time zone p_row.zone)::date) into v_weighin_days
      from health_samples hs where hs.user_id = p_user and hs.type = 'body_mass'
       and (hs.start_time at time zone p_row.zone)::date between v_monday and v_monday + 6;
    return v_weighin_days >= 3;
  else
    return true;
  end case;
end $$;
revoke all on function public._care_points_recheck(uuid, public.care_points_ledger)
  from public, anon, authenticated;

-- Promotes every pending row of p_user whose local_date has closed to settled, but only when
-- `_care_points_recheck` still confirms its condition; a row whose evidence was removed since
-- (an unmarked day, a corrected log, a lowered water total) is deleted instead -- it was never
-- settled or spent, so deleting it is not a correction to anything spendable, and the dropped
-- event_key is never reused (a past date is never re-awarded; see care_points_sync).
create function public._care_points_settle(p_user uuid, p_today date) returns void
  language plpgsql security definer set search_path = public as $$
declare v_row care_points_ledger%rowtype;
begin
  for v_row in select * from care_points_ledger
    where user_id = p_user and status = 'pending' and local_date < p_today
    order by created_at
  loop
    if _care_points_recheck(p_user, v_row) then
      update care_points_ledger set status = 'settled' where id = v_row.id;
    else
      delete from care_points_ledger where id = v_row.id;
    end if;
  end loop;
end $$;
revoke all on function public._care_points_settle(uuid, date) from public, anon, authenticated;

-- Recomputes and awards every rule for p_local_date (and its week), then settles whatever has
-- closed. One transaction, serialized per account against care_purchase. Returns
-- `{balance, pending, awarded: [{kind, delta, local_date}]}`.
create function public.care_points_sync(p_user_id uuid, p_local_date date, p_zone text)
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
