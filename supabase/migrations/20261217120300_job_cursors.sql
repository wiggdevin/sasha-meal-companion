-- Scale-readiness S3: one pass of a background job, strung across budgeted runs
-- (lib/server/job-cursor.ts).
--
-- A job that walks every account stops starting new accounts at its time budget. Per (job, period)
-- this row keeps the key of the last account the listing started (`after_key`), whether the listing
-- reached its end (`listed`), the accounts that did not finish cleanly and must be retried
-- (`retry_keys`, at most 2,000 by the app; past that `relist` makes the pass list again from the
-- start, the per-user locks skipping whoever is done), and `done` once the listing ended with nothing left to retry. `pass_started_at`
-- is the instant the pass began, so every run of one pass derives the same date or week for an
-- account. One run at a time advances a pass: `claim_job_cursor` takes the lease
-- (`lease_owner`, `lease_until`) in one statement, only when no live lease exists, and the app's
-- save is a compare-and-set on `lease_owner`. The per-user `job_runs` lock, not this row, keeps an
-- account to one run per key; a missing row only costs a rescan.
--
-- Server boundary only: RLS on and forced with no policy, nothing granted to anon or
-- authenticated, written by the service role. No user_id column, so it is not account-owned.
--
-- Down: supabase/migrations/down/20261217120300_job_cursors.down.sql.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

create table public.job_cursors (
  job text not null constraint job_cursors_job check (job <> ''),
  period text not null constraint job_cursors_period check (period <> ''),
  after_key text,
  listed boolean not null default false,
  retry_keys text[] not null default '{}',
  relist boolean not null default false,
  done boolean not null default false,
  pass_started_at timestamptz not null default now(),
  lease_owner uuid,
  lease_until timestamptz,
  updated_at timestamptz not null default now(),
  primary key (job, period),
  constraint job_cursors_lease check ((lease_owner is null) = (lease_until is null))
);
alter table public.job_cursors enable row level security;
alter table public.job_cursors force row level security;
revoke all on table public.job_cursors from public, anon, authenticated;
grant all on table public.job_cursors to service_role;

-- Takes the pass's lease for p_owner when no live lease exists and returns the pass state; returns
-- no row when another run holds a live lease. p_restart discards the saved pass (an explicit
-- operator run) and starts a fresh one now.
create function public.claim_job_cursor(
  p_job text, p_period text, p_owner uuid, p_lease_seconds integer, p_restart boolean
) returns table (after_key text, listed boolean, retry_keys text[], relist boolean,
                 done boolean, pass_started_at timestamptz)
language sql volatile security invoker set search_path = '' as $$
  insert into public.job_cursors as c (job, period, lease_owner, lease_until)
  values (p_job, p_period, p_owner, now() + make_interval(secs => p_lease_seconds))
  on conflict (job, period) do update set
    lease_owner = excluded.lease_owner,
    lease_until = excluded.lease_until,
    updated_at = now(),
    after_key = case when p_restart then null else c.after_key end,
    listed = case when p_restart then false else c.listed end,
    retry_keys = case when p_restart then '{}'::text[] else c.retry_keys end,
    relist = case when p_restart then false else c.relist end,
    done = case when p_restart then false else c.done end,
    pass_started_at = case when p_restart then now() else c.pass_started_at end
  where c.lease_until is null or c.lease_until < now()
  returning c.after_key, c.listed, c.retry_keys, c.relist, c.done, c.pass_started_at;
$$;
revoke all on function public.claim_job_cursor(text, text, uuid, integer, boolean)
  from public, anon, authenticated;
grant execute on function public.claim_job_cursor(text, text, uuid, integer, boolean)
  to service_role;
