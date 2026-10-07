-- Scale slice S2: one shared fixed-window rate limiter for every serverless instance.
--
-- Before this, lib/server/ratelimit.ts counted in a per-instance Map: the real ceiling was
-- `limit x instances` and a cold start forgot the window. `rate_limit_hit` is now the authority
-- for every allowed request; the Map only short-circuits a key the database already refused in
-- the current window.
--
--   * One row per (key, window). Windows are aligned to the epoch, so every instance agrees on
--     the window a request falls in. Keys are per user, per token or per IP (one hot row per
--     caller, never one row shared by all users); the only static keys are the cron jobs'.
--   * `rate_limit_hit` increments and reads the count in ONE statement
--     (INSERT .. ON CONFLICT DO UPDATE .. RETURNING): concurrent hits on one key serialise on its
--     row lock, so N parallel hits never allow more than `p_limit`.
--   * Expired rows: the first hit of a key's new window deletes that key's older windows (a primary
--     key prefix scan), and about 1 hit in 100 also runs `rate_limits_sweep(200)`, a bounded,
--     SKIP LOCKED delete of any expired rows (keys never hit again, such as one-off IPs).
--     `rate_limits_sweep` may also be scheduled from a cron; nothing here requires one.
--   * service_role only: RLS forced with no policy, every client grant revoked, and EXECUTE revoked
--     from public, anon and authenticated (Supabase's default privileges grant it to authenticated
--     directly, so `from public` alone is not enough).
--
-- Live-safe: a new, empty table and two new functions. Apply before the code that calls it merges.
-- Down: supabase/migrations/down/20261218090000_rate_limits.down.sql.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

do $$
begin
  if to_regclass('public.rate_limits') is not null then
    raise exception '20261218090000_rate_limits: already applied';
  end if;
end $$;

create table public.rate_limits (
  key text not null check (char_length(key) between 1 and 200),
  window_start timestamptz not null,
  count integer not null check (count >= 1),
  expires_at timestamptz not null,
  primary key (key, window_start)
);
comment on table public.rate_limits is
  'Shared fixed-window rate limiter (scale S2). Written only by rate_limit_hit; swept by rate_limits_sweep.';
create index rate_limits_expires on public.rate_limits (expires_at);

alter table public.rate_limits enable row level security;
alter table public.rate_limits force row level security;
revoke all on table public.rate_limits from public, anon, authenticated;
grant select on table public.rate_limits to service_role;

-- Deletes at most p_max expired rows; returns how many. SKIP LOCKED: never waits on a live hit.
create function public.rate_limits_sweep(p_max integer default 200) returns integer
  language plpgsql security definer set search_path = '' as $$
declare
  v_deleted integer;
begin
  delete from public.rate_limits r
   where r.ctid = any (array(
     select x.ctid from public.rate_limits x
      where x.expires_at < now()
      order by x.expires_at
      limit greatest(1, least(coalesce(p_max, 200), 5000))
      for update skip locked));
  get diagnostics v_deleted = row_count;
  return v_deleted;
end $$;

create function public.rate_limit_hit(p_key text, p_limit integer, p_window_seconds integer)
  returns table (allowed boolean, remaining integer, reset_at timestamptz)
  language plpgsql security definer set search_path = '' as $$
declare
  v_start timestamptz;
  v_count integer;
begin
  if p_key is null or char_length(p_key) not between 1 and 200 then
    raise exception 'rate_limit_hit: key must be 1-200 characters' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 or p_window_seconds is null
     or p_window_seconds not between 1 and 86400 then
    raise exception 'rate_limit_hit: limit >= 1 and window 1-86400 s' using errcode = '22023';
  end if;
  v_start := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);

  -- The one atomic statement. The stored count stops at limit + 1: a flood past the limit keeps
  -- the row refused without growing the number.
  insert into public.rate_limits as r (key, window_start, count, expires_at)
  values (p_key, v_start, 1, v_start + make_interval(secs => p_window_seconds))
  on conflict (key, window_start)
    do update set count = least(r.count, p_limit) + 1
  returning r.count into v_count;

  if v_count = 1 then
    delete from public.rate_limits where key = p_key and window_start < v_start;
    if random() < 0.01 then
      perform public.rate_limits_sweep(200);
    end if;
  end if;

  return query select v_count <= p_limit, greatest(p_limit - v_count, 0),
    v_start + make_interval(secs => p_window_seconds);
end $$;

revoke all on function public.rate_limit_hit(text, integer, integer) from public, anon, authenticated;
revoke all on function public.rate_limits_sweep(integer) from public, anon, authenticated;
grant execute on function public.rate_limit_hit(text, integer, integer) to service_role;
grant execute on function public.rate_limits_sweep(integer) to service_role;
