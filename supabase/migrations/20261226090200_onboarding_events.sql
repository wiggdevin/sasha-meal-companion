-- Followups #18 (W15 onboarding question ablation needs an analytics hook; no one exists today):
-- a privacy-safe event log of onboarding's pilot arm, question and step progress ONLY. No answer
-- content and no free text ever reaches this table -- every column but the two uuids and the two
-- timestamps is a fixed, checked enum. Modeled on food_signal_events (20261219090000): a batched,
-- owner-scoped insert RPC and an age-bounded purge, but STRICTER on reads: `authenticated` may
-- insert its own rows and nothing else -- no select policy at all. Only `service_role` (the W15
-- report job) reads.
--
--   * `kind` fixes the event vocabulary: `pilot_arm_assigned` (once per account, which arm),
--     `step_entered` / `step_left` / `step_abandoned` (a numbered screen of the flow),
--     `question_entered` / `question_left` (one onboarding question within a step). Nothing else.
--   * `step`, `question`, `pilot_arm` are each a closed, named list -- never the screen's copy,
--     never the user's answer, never free text. `onboarding_event_shape_valid` fixes which of
--     these three (and `duration_ms`) a given `kind` may or must carry; a row whose shape does
--     not match its kind is invalid under the same function the RPC filters by, so it can never
--     reach the table -- the table's own check constraint is pure defence in depth.
--   * `flow_version` is checked against a short closed list too (today just the one shipping
--     flow) -- a new flow version is a migration, not a client-supplied string.
--   * Idempotent on the phone's event id: unique (user_id, client_event_id); a retry inserts
--     nothing (ON CONFLICT DO NOTHING), same as food_signal_events.
--   * Owner-only insert (RLS `with check`); no `authenticated` select policy at all (spec: "no
--     client reads"). `service_role` selects and deletes (the 90-day purge); neither role updates.
--     Account deletion cascades.
--   * `created_at` is the server's clock and no API role may write it (column-level insert
--     grants): the `at` window is checked against it, so a client cannot back-date it past the
--     90-day purge horizon.
--   * Purged after 90 days by `at` (`onboarding_events_purge`, service_role only, bounded and
--     SKIP LOCKED), run by the `/api/jobs/onboarding-events-purge` cron (vercel.json).
--
-- Live-safe: a new, empty table, its indexes and three new functions; no existing table is
-- altered, so nothing needs NOT VALID / VALIDATE.
-- Apply order: this file alone, its own transaction.
-- Down: supabase/migrations/down/20261226090200_onboarding_events.down.sql.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

do $$
begin
  if to_regclass('public.onboarding_events') is not null then
    raise exception '20261226090200_onboarding_events: already applied';
  end if;
end $$;

-- The fixed vocabulary, named once so the table's check constraints and the RPC's filter read the
-- same lists (lib/profile/onboarding-events.ts mirrors these exactly; a test holds them equal).
create function public.onboarding_event_shape_valid(p_kind text, p_step text, p_question text,
  p_pilot_arm text, p_duration_ms integer) returns boolean
  language sql immutable parallel safe set search_path = '' as $fn$
    -- coalesce(..., false): every branch below is an AND-chain over nullable inputs (p_step,
    -- p_question, p_pilot_arm, p_duration_ms), and `x in (...)`/`x is null` on a NULL input makes
    -- the whole chain evaluate to SQL NULL, not false. A bare `case` would then hand that NULL
    -- straight to the table's CHECK, which treats NULL as satisfied -- the bug this closes: a
    -- `step_left` with no step must come back false, never NULL. The `else false` branch also
    -- covers an unknown or null p_kind.
    select coalesce(case p_kind
      when 'pilot_arm_assigned' then
        p_pilot_arm in ('control', 'treatment') and p_step is null and p_question is null
          and p_duration_ms is null
      when 'step_entered' then
        p_step in ('intro', 'facts', 'allergy', 'foods', 'reward', 'done')
          and p_question is null and p_pilot_arm is null and p_duration_ms is null
      when 'step_left' then
        p_step in ('intro', 'facts', 'allergy', 'foods', 'reward', 'done')
          and p_question is null and p_pilot_arm is null
          and p_duration_ms is not null and p_duration_ms between 0 and 86400000
      when 'step_abandoned' then
        p_step in ('intro', 'facts', 'allergy', 'foods', 'reward', 'done')
          and p_question is null and p_pilot_arm is null
          and p_duration_ms is not null and p_duration_ms between 0 and 86400000
      when 'question_entered' then
        p_question in ('goal', 'sex', 'birthYear', 'heightCm', 'weightKg', 'activity', 'dietFlags',
          'cookingEffort')
          and p_step is null and p_pilot_arm is null and p_duration_ms is null
      when 'question_left' then
        p_question in ('goal', 'sex', 'birthYear', 'heightCm', 'weightKg', 'activity', 'dietFlags',
          'cookingEffort')
          and p_step is null and p_pilot_arm is null
          and p_duration_ms is not null and p_duration_ms between 0 and 86400000
      else false
    end, false)
  $fn$;
comment on function public.onboarding_event_shape_valid(text, text, text, text, integer) is
  'Followups #18: which of step/question/pilot_arm/duration_ms a kind may carry. The one place the onboarding_events vocabulary is fixed; lib/profile/onboarding-events.ts mirrors it exactly.';

create table public.onboarding_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  client_event_id uuid not null,
  at timestamptz not null,
  flow_version text not null check (flow_version in ('onboarding_v2')),
  kind text not null check (kind in ('pilot_arm_assigned', 'step_entered', 'step_left',
    'step_abandoned', 'question_entered', 'question_left')),
  step text,
  question text,
  pilot_arm text,
  duration_ms integer,
  created_at timestamptz not null default now(),
  constraint onboarding_events_shape
    check (public.onboarding_event_shape_valid(kind, step, question, pilot_arm, duration_ms)),
  -- The phone's clock: at most 10 minutes ahead, at most 14 days behind (an offline queue) --
  -- same window as food_signal_events; the 90-day purge horizon is well outside it either way.
  constraint onboarding_events_at check (at <= created_at + interval '10 minutes'
                                        and at >= created_at - interval '14 days'),
  constraint onboarding_events_client_event unique (user_id, client_event_id)
);
comment on table public.onboarding_events is
  'Followups #18: pilot-arm, question and step events for the W15 onboarding ablation. No answer content, no free text -- every field but the two uuids and two timestamps is a fixed, checked enum (onboarding_event_shape_valid). Owner-only insert; no client select; purged after 90 days.';

-- The purge walks by age; the report (service_role) reads one account's flow in order.
create index onboarding_events_at on public.onboarding_events (at);
create index onboarding_events_user_at on public.onboarding_events (user_id, at);

alter table public.onboarding_events enable row level security;
-- No select POLICY for `authenticated` at all (spec: "no client reads") -- only the insert policy
-- below. RLS with no applicable policy for a command returns zero rows for that role, so
-- `authenticated` reads nothing here, and no select GRANT exists either (see
-- `record_onboarding_events` below for why its insert must avoid RETURNING/a writable CTE, which
-- would otherwise need one).
create policy onboarding_events_insert on public.onboarding_events for insert to authenticated
  with check (user_id = (select auth.uid()));
-- Hosted default privileges grant ALL on a new table to anon, authenticated and service_role.
revoke all on table public.onboarding_events from public, anon, authenticated, service_role;
grant insert (id, user_id, client_event_id, at, flow_version, kind, step, question, pilot_arm,
              duration_ms)
  on table public.onboarding_events to authenticated;
grant select, insert, delete on table public.onboarding_events to service_role;

-- The caller's batch (POST /api/onboarding/events): at most 20 events, each stored under
-- auth.uid(). Security invoker, so RLS applies (the insert policy, no select policy at all). An
-- event the table would refuse (bad shape for its kind, bad flow_version, outside the clock
-- window) is skipped and counted as rejected, so one bad event never fails its batch; a repeat of
-- a stored client_event_id (or of one earlier in the same batch) is a duplicate.
--
-- Deliberately a per-row loop with an exception handler, not a single
-- `insert ... on conflict (...) do nothing [returning ...]` (the shape record_food_signals,
-- 20261219090000, uses): Postgres requires SELECT privilege on the target table for `ON CONFLICT`
-- (to probe the arbiter index), and once granted, an `ON CONFLICT` write under RLS with no SELECT
-- POLICY for the role still fails "new row violates row-level security policy" (it cannot resolve
-- visibility for the conflict check). The same is true of RETURNING / a writable CTE read back via
-- SELECT. `food_signal_events` has an owner SELECT policy, so none of this bites there; this table
-- has NONE by design (spec: "no client reads"), so its insert must reach the table only through a
-- bare `insert ... values (...)` with no RETURNING and no ON CONFLICT -- a true duplicate
-- `client_event_id` is instead caught as a `unique_violation` per row, inside its own
-- subtransaction (cheap at this table's 20-row batch cap) so one duplicate never aborts the batch.
-- This needs no SELECT grant and no SELECT policy, matching the table's actual read capability.
create function public.record_onboarding_events(p_events jsonb)
  returns table (inserted integer, duplicates integer, rejected integer)
  language plpgsql security invoker set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_total integer;
  v_eligible integer := 0;
  v_inserted integer := 0;
  v_event record;
begin
  if v_uid is null then
    raise exception 'record_onboarding_events: sign in' using errcode = '42501';
  end if;
  if p_events is null or jsonb_typeof(p_events) <> 'array'
     or jsonb_array_length(p_events) not between 1 and 20 then
    raise exception 'record_onboarding_events: 1 to 20 events' using errcode = '22023';
  end if;
  v_total := jsonb_array_length(p_events);

  for v_event in
    select b.client_event_id, b.at, b.flow_version, b.kind, b.step, b.question, b.pilot_arm,
           b.duration_ms
      from jsonb_to_recordset(p_events) as b(client_event_id uuid, at timestamptz,
        flow_version text, kind text, step text, question text, pilot_arm text, duration_ms integer)
     where b.client_event_id is not null and b.at is not null
       and b.flow_version in ('onboarding_v2')
       and public.onboarding_event_shape_valid(b.kind, b.step, b.question, b.pilot_arm, b.duration_ms)
       and b.at <= now() + interval '10 minutes'
       and b.at >= now() - interval '14 days'
  loop
    v_eligible := v_eligible + 1;
    begin
      insert into public.onboarding_events (user_id, client_event_id, at, flow_version, kind, step,
        question, pilot_arm, duration_ms)
      values (v_uid, v_event.client_event_id, v_event.at, v_event.flow_version, v_event.kind,
        v_event.step, v_event.question, v_event.pilot_arm, v_event.duration_ms);
      v_inserted := v_inserted + 1;
    exception when unique_violation then
      -- A retry of the same (user_id, client_event_id): counted as a duplicate, stored once.
      null;
    end;
  end loop;

  return query select v_inserted, v_eligible - v_inserted, v_total - v_eligible;
end $$;

-- Deletes at most p_max events older than 90 days; returns how many. SKIP LOCKED.
create function public.onboarding_events_purge(p_max integer default 5000) returns integer
  language plpgsql security definer set search_path = '' as $$
declare
  v_deleted integer;
begin
  delete from public.onboarding_events e
   where e.ctid = any (array(
     select x.ctid from public.onboarding_events x
      where x.at < now() - interval '90 days'
      order by x.at
      limit greatest(1, least(coalesce(p_max, 5000), 20000))
      for update skip locked));
  get diagnostics v_deleted = row_count;
  return v_deleted;
end $$;

revoke all on function public.onboarding_event_shape_valid(text, text, text, text, integer) from public, anon;
revoke all on function public.record_onboarding_events(jsonb) from public, anon;
revoke all on function public.onboarding_events_purge(integer) from public, anon, authenticated;
grant execute on function public.onboarding_event_shape_valid(text, text, text, text, integer)
  to authenticated, service_role;
grant execute on function public.record_onboarding_events(jsonb) to authenticated;
grant execute on function public.onboarding_events_purge(integer) to service_role;
