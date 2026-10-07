-- Phase 5 (spec §4). oauth_states is server-boundary only: it carries no policy, so RLS denies every
-- authenticated read and the callback route reaches it with the service role.
create table oauth_states (state_hash bytea primary key, provider text not null check (provider in ('oura')),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(), expires_at timestamptz not null,
  consumed_at timestamptz);
alter table oauth_states enable row level security;   -- no policy: server boundary only
revoke all on table oauth_states from anon, authenticated;

create table job_runs (job text not null, run_key text not null,   -- e.g. ('oura-pull','2026-09-15')
  user_id uuid not null references auth.users(id) on delete cascade,
  started_at timestamptz not null default now(), finished_at timestamptz,
  status text not null check (status in ('running','ok','error')), detail jsonb,
  primary key (job, user_id, run_key));
alter table job_runs enable row level security;
create policy job_runs_ro on job_runs for select to authenticated
  using (user_id = (select auth.uid()));
revoke all on table job_runs from anon, authenticated;
grant select on table job_runs to authenticated;
