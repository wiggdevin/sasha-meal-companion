-- T0 §1 (docs/plans/2026-09-17-t0-speed-foundations.md): one row per hop of one run, posted by
-- lib/timing.ts through POST /api/timings.
--
-- `ms` is a DURATION, never an instant: a client hop measured with performance.now(), or the
-- server's own `model` / `ground` ms handed back on the propose and coach responses. `at` is the
-- instant the run closed, so a day's runs can be bucketed without a second column per row.
--
-- She INSERTS and nothing else. There is no select policy on purpose: the p50/p95 report is
-- `pnpm timings`, a service-role script (scripts/timings.ts), and a phone that could read its own
-- history would be a second, unasked-for surface to keep honest. `ai_calls.latency_ms` stays the
-- provider-side truth; this table is the phone's side of the same runs.

create table if not exists client_timings (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  run_id uuid not null,
  path text not null check (path in ('barcode','label','photo','voice','text','search-log',
                                    'meal-log','coach-turn','coach-action')),
  step text not null check (step in ('decode','lookup','sign','upload','propose','model',
                                     'ground','confirm-shown','commit','card-visible',
                                     'sent','first-text','reply-done','action-applied')),
  ms integer not null check (ms >= 0),
  at timestamptz not null default now(),
  device text,
  created_at timestamptz not null default now());

-- The report filters by path and by "the last N days", in that order.
create index if not exists client_timings_path_at on client_timings (path, at desc);
create index if not exists client_timings_run on client_timings (run_id);

alter table client_timings enable row level security;
alter table client_timings force row level security;

create policy client_timings_insert on client_timings
  for insert to authenticated
  with check (user_id = (select auth.uid()));

revoke all on table client_timings from anon, authenticated;
grant insert on table client_timings to authenticated;
grant all on table client_timings to service_role;
