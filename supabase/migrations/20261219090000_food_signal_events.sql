-- Phase 18 W6, migration 5 (docs/specs/phase-18-open-world-foods.md §6, §W6): food signal events
-- with their offered slates.
--
-- One row per tap on a food the app OFFERED: a swap-sheet pick or swap-away, a Plan-sheet
-- "Not this" or "Add", a suggestion-card pick or "Not this". Each row carries the slate it was
-- offered in (`offered_keys`, 1 to 8 distinct food keys) so W7's `N_{f,o}` counts a negative only
-- when the food was actually offered (D5), and W14 can rebuild every decision from the slates
-- (a decision is an offered slate after which the user picked, swapped to or ate an anchor).
--
--   * The food the event is about (`chosen_key`) must be in its offered slate: a check
--     constraint, so no writer (the RPC, a direct insert, service_role) can store an unoffered
--     negative. `record_food_signals` also skips such an event and counts it as rejected, so one
--     bad event never fails its batch.
--   * "Not this" is kind `not_this` here, for one occasion. A taste dislike lives in
--     `user_settings.diet_prefs.taste.dislikes` (W5) and is never written from this table: no
--     trigger, function or kind here touches `user_settings`. There is no `dislike` kind.
--   * No PII beyond `user_id` and food keys: keys are `catalog:<id>` or `food:<uuid|bundled id>`
--     (lib/meals/food-key.ts), never a name or free text.
--   * Idempotent on the phone's event id: unique (user_id, client_event_id); a retry inserts
--     nothing (ON CONFLICT DO NOTHING).
--   * Owner-only: `authenticated` may select and insert its own rows (RLS), never update or delete.
--     `service_role` selects, inserts and deletes (the purge); it never updates. Account deletion cascades.
--   * `created_at` is the server's clock and no API role may write it (column-level insert grants):
--     the `at` window is checked against it, so a client cannot back-date it to store an `at` far
--     in the future that the 180-day purge would never reach.
--   * Purged after 180 days by `at` (`food_signal_events_purge`, service_role only, bounded and
--     SKIP LOCKED), run by the `/api/jobs/signal-purge` cron.
--
-- Live-safe: a new, empty table, its indexes and three new functions; no existing table is
-- altered, so nothing needs NOT VALID / VALIDATE. Apply to production before the code that calls
-- it merges. Down: supabase/migrations/down/20261219090000_food_signal_events.down.sql.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

do $$
begin
  if to_regclass('public.food_signal_events') is not null then
    raise exception '20261219090000_food_signal_events: already applied';
  end if;
end $$;

-- A food key as lib/meals/food-key.ts parses it, and an offered slate: 1 to 8 distinct keys.
create function public.food_signal_slate_valid(p_keys text[]) returns boolean
  language sql immutable set search_path = '' as $$
  select p_keys is not null
     and cardinality(p_keys) between 1 and 8
     and array_ndims(p_keys) = 1
     and array_position(p_keys, null) is null
     and (select count(distinct k) = count(*)
                 and bool_and(char_length(k) <= 160
                   and k !~ '^catalog:0+$'
                   and k ~ '^(catalog:[0-9]{1,15}|food:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[a-z0-9]+(-[a-z0-9]+)*))$')
            from unnest(p_keys) as k)
$$;

create table public.food_signal_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  client_event_id uuid not null,
  -- One showing of a slate: a swap's `swapped_away` and `picked` share it (W14 decisions).
  slate_id uuid not null,
  at timestamptz not null,
  local_date date not null,
  surface text not null check (surface in ('swap_sheet', 'plan_sheet', 'suggestion_card')),
  kind text not null check (kind in ('picked', 'swapped_away', 'not_this', 'added')),
  occasion text not null check (occasion in ('breakfast', 'lunch', 'dinner', 'snack', 'other')),
  chosen_key text not null,
  offered_keys text[] not null,
  ranking_version text not null check (ranking_version ~ '^[a-z0-9][a-z0-9._-]{0,31}$'),
  created_at timestamptz not null default now(),
  constraint food_signal_events_slate check (public.food_signal_slate_valid(offered_keys)),
  -- W6 acceptance 2: an event for a food that was not offered is never stored.
  constraint food_signal_events_offered check (chosen_key = any (offered_keys)),
  -- The phone's clock: at most 10 minutes ahead, at most 14 days behind (an offline queue).
  constraint food_signal_events_at check (at <= created_at + interval '10 minutes'
                                          and at >= created_at - interval '14 days'),
  -- Every zone is within a day of UTC's date.
  constraint food_signal_events_local_date check (
    local_date between (at at time zone 'UTC')::date - 1 and (at at time zone 'UTC')::date + 1),
  constraint food_signal_events_client_event unique (user_id, client_event_id)
);
comment on table public.food_signal_events is
  'Phase 18 W6: taps on offered foods with their offered slate (1-8 food keys). Owner-only; purged after 180 days. "Not this" is per occasion and is never a taste preference.';

-- W7/W14 read one account's recent events; the purge walks by age.
create index food_signal_events_user_at on public.food_signal_events (user_id, at);
create index food_signal_events_at on public.food_signal_events (at);

alter table public.food_signal_events enable row level security;
create policy food_signal_events_select on public.food_signal_events for select to authenticated
  using (user_id = (select auth.uid()));
create policy food_signal_events_insert on public.food_signal_events for insert to authenticated
  with check (user_id = (select auth.uid()));
-- Hosted default privileges grant ALL on a new table to anon, authenticated and service_role.
revoke all on table public.food_signal_events from public, anon, authenticated, service_role;
grant select on table public.food_signal_events to authenticated, service_role;
grant insert (id, user_id, client_event_id, slate_id, at, local_date, surface, kind, occasion,
              chosen_key, offered_keys, ranking_version)
  on table public.food_signal_events to authenticated, service_role;
grant delete on table public.food_signal_events to service_role;

-- The caller's batch (POST /api/foods/signals): at most 20 events, each stored under auth.uid().
-- Security invoker, so RLS applies. An event the table would refuse (outside its slate, a bad slate,
-- surface, kind, occasion or ranking version, a missing field, or outside the clock or date window)
-- is skipped and counted as rejected, so one bad event never fails its batch; a repeat of a stored
-- client_event_id (or of one earlier in the same batch) is a duplicate. A value of the wrong JSON
-- type (a uuid or date that does not parse) still fails the call: the route sends none.
create function public.record_food_signals(p_events jsonb)
  returns table (inserted integer, duplicates integer, rejected integer)
  language plpgsql security invoker set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_total integer;
  v_eligible integer;
  v_inserted integer;
begin
  if v_uid is null then
    raise exception 'record_food_signals: sign in' using errcode = '42501';
  end if;
  if p_events is null or jsonb_typeof(p_events) <> 'array'
     or jsonb_array_length(p_events) not between 1 and 20 then
    raise exception 'record_food_signals: 1 to 20 events' using errcode = '22023';
  end if;
  v_total := jsonb_array_length(p_events);

  with batch as (
    select e.*
      from jsonb_to_recordset(p_events) as e(client_event_id uuid, slate_id uuid, at timestamptz,
        local_date date, surface text, kind text, occasion text, chosen_key text,
        offered_keys text[], ranking_version text)
  ), eligible as (
    select b.* from batch b
     where b.client_event_id is not null and b.slate_id is not null
       and b.at is not null and b.local_date is not null
       and b.surface in ('swap_sheet', 'plan_sheet', 'suggestion_card')
       and b.kind in ('picked', 'swapped_away', 'not_this', 'added')
       and b.occasion in ('breakfast', 'lunch', 'dinner', 'snack', 'other')
       and b.ranking_version ~ '^[a-z0-9][a-z0-9._-]{0,31}$'
       and public.food_signal_slate_valid(b.offered_keys)
       and b.chosen_key = any (b.offered_keys)
       and b.at <= now() + interval '10 minutes'
       and b.at >= now() - interval '14 days'
       and b.local_date between (b.at at time zone 'UTC')::date - 1
                            and (b.at at time zone 'UTC')::date + 1
  ), stored as (
    insert into public.food_signal_events (user_id, client_event_id, slate_id, at, local_date,
      surface, kind, occasion, chosen_key, offered_keys, ranking_version)
    select v_uid, b.client_event_id, b.slate_id, b.at, b.local_date, b.surface, b.kind,
           b.occasion, b.chosen_key, b.offered_keys, b.ranking_version
      from eligible b
    on conflict (user_id, client_event_id) do nothing
    returning 1
  )
  select (select count(*) from eligible)::integer, (select count(*) from stored)::integer
    into v_eligible, v_inserted;

  return query select v_inserted, v_eligible - v_inserted, v_total - v_eligible;
end $$;

-- Deletes at most p_max events older than 180 days; returns how many. SKIP LOCKED.
create function public.food_signal_events_purge(p_max integer default 5000) returns integer
  language plpgsql security definer set search_path = '' as $$
declare
  v_deleted integer;
begin
  delete from public.food_signal_events e
   where e.ctid = any (array(
     select x.ctid from public.food_signal_events x
      where x.at < now() - interval '180 days'
      order by x.at
      limit greatest(1, least(coalesce(p_max, 5000), 20000))
      for update skip locked));
  get diagnostics v_deleted = row_count;
  return v_deleted;
end $$;

revoke all on function public.food_signal_slate_valid(text[]) from public, anon;
revoke all on function public.record_food_signals(jsonb) from public, anon;
revoke all on function public.food_signal_events_purge(integer) from public, anon, authenticated;
grant execute on function public.food_signal_slate_valid(text[]) to authenticated, service_role;
grant execute on function public.record_food_signals(jsonb) to authenticated;
grant execute on function public.food_signal_events_purge(integer) to service_role;
