-- UI-NEEDS SPROUT-CARE item 3 (coord.md 2026-10-07T04:15Z). Keys match the already-landed gallery
-- catalog (components/today/care/awards.ts AWARDS) so a real grant and a design sample read the
-- same key.
--
-- `care_accolades_sync` grants the subset this migration can confidently derive from tables that
-- already exist: first-meal, first-complete-day, full-week, seven-days, thirty-days, protein-5,
-- water-5 (from care_points_ledger, so it never re-derives the nutrition/water rules a second
-- time), goal-5 / goal-20 (five / twenty dates with a settled protein_goal OR water_goal ledger
-- row -- "your chosen goal", never a calorie goal, exactly as awards.ts documents it), first-
-- recipe, and welcome-back.
--
-- Deliberately NOT computed here, flagged rather than guessed:
--   - workout-pair / workout-10: "needs activity data: say which source counts" (the owner's own
--     wording in coord.md item 3) -- no workout log exists in this schema yet. care_accolade_defs
--     still seeds both keys so the gallery and a future grant agree on the key; care_accolades_sync
--     never grants them.
--   - weight-milestone: opt-in AND a loss goal AND a 7-day/3-weigh-in trend test -- no column
--     records the opt-in yet. Seeded, never granted, until that opt-in exists.
--   - first-note: "a note kept" -- no user-authored note table exists in this schema (care_messages,
--     20261225090400, is server-to-user only). Seeded, never granted.
--
-- Live-safe: two new tables, RLS on from creation, one new function, one seeded catalog.
-- Down: supabase/migrations/down/20261225090300_care_accolades.down.sql.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

do $$
begin
  if to_regclass('public.care_accolade_defs') is not null then
    raise exception '20261225090300_care_accolades: already applied';
  end if;
end $$;

create table public.care_accolade_defs (
  key text primary key,
  version integer not null default 1,
  rule text not null,
  evidence_window text
);

create table public.care_accolades (
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null references public.care_accolade_defs(key),
  version integer not null,
  earned_at timestamptz not null default now(),
  evidence jsonb not null default '{}'::jsonb,
  seen_at timestamptz,
  primary key (user_id, key, version)
);
create index care_accolades_unseen on public.care_accolades (user_id) where seen_at is null;

alter table public.care_accolade_defs enable row level security;
create policy care_accolade_defs_read on public.care_accolade_defs for select to authenticated using (true);
revoke all on table public.care_accolade_defs from public, anon, authenticated, service_role;
grant select on table public.care_accolade_defs to authenticated;
grant select on table public.care_accolade_defs to service_role;

alter table public.care_accolades enable row level security;
create policy care_accolades_select on public.care_accolades for select to authenticated
  using (user_id = (select auth.uid()));
revoke all on table public.care_accolades from public, anon, authenticated, service_role;
grant select on table public.care_accolades to authenticated;
-- service_role: read, insert (grants) and update (seen_at only, via care_accolades_seen below) --
-- no role may delete a grant.
grant select, insert, update on table public.care_accolades to service_role;

insert into public.care_accolade_defs (key, rule, evidence_window) values
  ('first-meal', 'the first retained meal', 'all time'),
  ('first-complete-day', 'the first explicit day-complete mark', 'all time'),
  ('full-week', 'a retained meal on all seven dates of a completed local week', 'one local week'),
  ('seven-days', 'seven distinct active dates', 'all time'),
  ('thirty-days', 'thirty distinct active dates', 'all time'),
  ('goal-5', 'five dates that reached a protein or water goal (never a calorie goal)', 'all time'),
  ('goal-20', 'twenty dates that reached a protein or water goal (never a calorie goal)', 'all time'),
  ('protein-5', 'five known dates that reached the protein target', 'all time'),
  ('water-5', 'five dates that reached the water goal', 'all time'),
  ('workout-pair', 'recorded workouts on two consecutive dates', 'not computed: no workout log yet'),
  ('workout-10', 'ten dates with a recorded workout', 'not computed: no workout log yet'),
  ('first-note', 'the first saved note', 'not computed: no note table yet'),
  ('first-recipe', 'the first accepted recipe selection', 'all time'),
  ('welcome-back', 'activity after seven inactive dates, at most once a month', 'rolling 30 days'),
  ('weight-milestone',
   'opt-in AND a loss goal: the trend stays 5 lb below the opt-in baseline across seven days with 3+ weigh-ins',
   'not computed: no opt-in column yet');

-- One idempotent grant, keyed on (user, key, version) so a repeat sync never double-grants.
create function public._care_accolade_grant(p_user uuid, p_key text, p_evidence jsonb)
  returns public.care_accolades
  language plpgsql security definer set search_path = public as $$
declare v_version integer; v_row care_accolades%rowtype;
begin
  select version into v_version from care_accolade_defs where key = p_key;
  if v_version is null then return null; end if;
  insert into care_accolades (user_id, key, version, evidence)
  values (p_user, p_key, v_version, p_evidence)
  on conflict (user_id, key, version) do nothing
  returning * into v_row;
  return v_row;
end $$;
revoke all on function public._care_accolade_grant(uuid, text, jsonb) from public, anon, authenticated;

-- Recomputes every rule this migration can derive and grants whichever newly apply. Returns
-- `{granted: [key, ...]}`.
create function public.care_accolades_sync(p_user_id uuid, p_local_date date, p_zone text)
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

-- Marks the named grants seen (unseen GET excludes them afterward). Silently skips a key the
-- caller never earned or already saw.
create function public.care_accolades_seen(p_user_id uuid, p_keys text[]) returns integer
  language plpgsql security definer set search_path = public as $$
declare v_n integer;
begin
  perform _sync_assert_caller(p_user_id);
  update care_accolades set seen_at = now()
   where user_id = p_user_id and key = any(coalesce(p_keys, '{}'::text[])) and seen_at is null;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function public.care_accolades_seen(uuid, text[]) from public, anon, authenticated;
grant execute on function public.care_accolades_seen(uuid, text[]) to authenticated, service_role;
