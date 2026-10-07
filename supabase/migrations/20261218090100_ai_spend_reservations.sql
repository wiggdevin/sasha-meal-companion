-- Scale slice S2: atomic AI spend reservations against the per-user daily cap AND a global daily
-- ceiling, with a bounded overshoot.
--
-- Before this, lib/ai/spend.ts summed today's ai_calls rows before a call, under a per-instance
-- lock, and let the call through when the read failed. Two instances could both pass a cap their
-- combined cost broke, and nothing bounded the whole deployment's spend.
--
-- The guarantee. Providers bill after the fact, so no cap can be exact. Instead:
--   (a) a reservation is refused unless settled spend + every unsettled hold + this call's estimate
--       stays within the cap; once settled spend reaches the cap, every further reserve is refused;
--   (b) the estimate is the call's maximum cost (lib/ai: the output cap and input size at the
--       model's price, or a configured ceiling where the price is unknown);
--   (c) settle records the ACTUAL cost even when it exceeds the hold.
-- So a cap can be exceeded by at most one call's overrun beyond its estimate.
--
--   * ai_spend_user_days: settled spend per (user, UTC day). ai_spend_global_days: settled spend
--     per UTC day in 16 shard rows (a user's shard is a hash of the user id); the day's global
--     total is their sum. Day rows are created on a day's first reservation, seeded from that
--     day's ai_calls cost (the global seed on shard 0), so the deploy day still counts what was
--     spent before it.
--   * ai_spend_reservations: one row per model call. An unsettled hold counts against both caps
--     until it is settled, whether or not it has expired: expiry never frees headroom by itself.
--     `expires_at` (5 minutes, past any function's maxDuration) only makes a hold eligible for
--     reconciliation.
--   * ai_calls.spend_reservation_id: the reservation a call's row belongs to, so reconciliation can
--     charge what the call actually cost.
--   * ai_spend_reserve: first reconciles up to 100 of the caller's own expired holds for today
--     (so no user is blocked by their own abandoned holds), then the check above, then the hold.
--     It locks the caller's global shard row and the caller's user day row only. The global check
--     (every shard's settled spend + every open hold + this estimate) is ONE statement, so it reads
--     one snapshot: a settle on another shard is seen either wholly before (as its hold) or wholly
--     after (as its spend), never as neither. The remaining global bound: reservations running at
--     the same moment on different shards each pass against a snapshot without the others, so the
--     ceiling can additionally be exceeded by at most the sum of those concurrent reservations'
--     estimates. The per-user cap has no such term: each user's day row is locked. Sharding:
--     100 clients of reserve+settle measured one shared row at p95 0.8-1.8 s and 16 shards at
--     0.18-0.3 s on the same (loaded) machine.
--   * ai_spend_settle: the client's settle. An unsettled hold becomes its actual cost. A hold the
--     sweep already reconciled is adjusted to the actual cost (the difference only, never twice).
--     A second client settle is a no-op that returns false.
--   * ai_spend_sweep: reconciles expired unsettled holds, oldest day first (charging the call's
--     ai_calls cost when a row names the reservation, else the whole reserved amount), deletes
--     settled reservations older than 2 days, then day rows older than 40 days that no reservation
--     still names. Reconciling never creates a day row, so an old hold cannot re-seed a deleted day
--     from ai_calls and charge its call twice. Single-flight (advisory lock), bounded, never inside
--     a reserve. Callers: the /api/jobs/spend-sweep cron every 15 minutes (until nothing expired
--     remains or 60 s pass) and about 1 settle in 50.
--   * Lock order everywhere: the user's global shard row, then the user's day row, then the
--     reservation; the sweep walks holds in (day, shard, user) order, so it cannot deadlock.
--   * service_role only, as rate_limits: RLS forced with no policy, all client grants revoked,
--     EXECUTE revoked from public, anon and authenticated. The user_id keys cascade on account
--     delete; the global day row keeps that account's spend, as it should.
--
-- Live-safe: new, empty tables, new functions and one nullable column on ai_calls (no default, no
-- rewrite). Apply before the code that calls them merges.
-- Down: supabase/migrations/down/20261218090100_ai_spend_reservations.down.sql.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

do $$
begin
  if to_regclass('public.ai_spend_reservations') is not null then
    raise exception '20261218090100_ai_spend_reservations: already applied';
  end if;
end $$;

create table public.ai_spend_global_days (
  day date not null,
  shard smallint not null check (shard between 0 and 15),
  spent_usd numeric not null default 0 check (spent_usd >= 0),
  created_at timestamptz not null default now(),
  primary key (day, shard)
);
comment on table public.ai_spend_global_days is
  'Settled AI spend per UTC day and shard, all accounts (scale S2); the day total is the sum. Written only by the ai_spend_* functions.';

create table public.ai_spend_user_days (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  spent_usd numeric not null default 0 check (spent_usd >= 0),
  created_at timestamptz not null default now(),
  primary key (user_id, day)
);
comment on table public.ai_spend_user_days is
  'Settled AI spend per account and UTC day (scale S2). Written only by the ai_spend_* functions.';

create table public.ai_spend_reservations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  amount_usd numeric not null check (amount_usd >= 0),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  settled_at timestamptz,
  actual_usd numeric check (actual_usd is null or actual_usd >= 0),
  settled_by text check (settled_by in ('client', 'reconcile')),
  check ((settled_at is null) = (actual_usd is null) and (settled_at is null) = (settled_by is null))
);
comment on table public.ai_spend_reservations is
  'One hold per model call until it is settled by the client or reconciled by ai_spend_sweep (scale S2).';
create index ai_spend_reservations_open_day on public.ai_spend_reservations (day)
  where settled_at is null;
create index ai_spend_reservations_open_user on public.ai_spend_reservations (user_id, day)
  where settled_at is null;
create index ai_spend_reservations_open_expiry on public.ai_spend_reservations (expires_at)
  where settled_at is null;
create index ai_spend_reservations_created on public.ai_spend_reservations (created_at);

alter table public.ai_calls add column spend_reservation_id uuid;
create index ai_calls_spend_reservation on public.ai_calls (spend_reservation_id)
  where spend_reservation_id is not null;

alter table public.ai_spend_global_days enable row level security;
alter table public.ai_spend_global_days force row level security;
alter table public.ai_spend_user_days enable row level security;
alter table public.ai_spend_user_days force row level security;
alter table public.ai_spend_reservations enable row level security;
alter table public.ai_spend_reservations force row level security;
revoke all on table public.ai_spend_global_days from public, anon, authenticated;
revoke all on table public.ai_spend_user_days from public, anon, authenticated;
revoke all on table public.ai_spend_reservations from public, anon, authenticated;
grant select on table public.ai_spend_global_days to service_role;
grant select, insert, delete on table public.ai_spend_user_days to service_role;
grant select, insert, delete on table public.ai_spend_reservations to service_role;

-- The global shard a user's spend is counted in.
create function public._ai_spend_shard(p_user_id uuid) returns smallint
  language sql immutable set search_path = '' as $$
  select (abs(hashtext(p_user_id::text)) % 16)::smallint;
$$;

-- Locks the user's global shard row for the day, then the user's day row. With p_create, absent
-- rows are created first, seeded from that day's ai_calls; without it nothing is created and
-- `present` is false when either row is missing. Returns the user's settled spend.
create function public._ai_spend_lock_day(p_user_id uuid, p_day date, p_create boolean,
  out user_spent numeric, out present boolean)
  language plpgsql security definer set search_path = '' as $$
declare
  v_start timestamptz := p_day::timestamp at time zone 'utc';
  v_end timestamptz := (p_day + 1)::timestamp at time zone 'utc';
begin
  if p_create and not exists (select 1 from public.ai_spend_global_days where day = p_day) then
    insert into public.ai_spend_global_days (day, shard, spent_usd)
    select p_day, g.shard, case when g.shard = 0 then coalesce((select sum(greatest(c.cost_estimate, 0))
      from public.ai_calls c where c.created_at >= v_start and c.created_at < v_end), 0) else 0 end
      from generate_series(0, 15) g(shard)
    on conflict (day, shard) do nothing;
  end if;
  perform 1 from public.ai_spend_global_days
   where day = p_day and shard = public._ai_spend_shard(p_user_id) for update;
  present := found;
  if p_create and not exists (select 1 from public.ai_spend_user_days
                               where user_id = p_user_id and day = p_day) then
    insert into public.ai_spend_user_days (user_id, day, spent_usd)
    select p_user_id, p_day, coalesce(sum(greatest(c.cost_estimate, 0)), 0)
      from public.ai_calls c
     where c.user_id = p_user_id and c.created_at >= v_start and c.created_at < v_end
    on conflict (user_id, day) do nothing;
  end if;
  select u.spent_usd into user_spent from public.ai_spend_user_days u
   where u.user_id = p_user_id and u.day = p_day for update;
  present := present and found;
end $$;

-- Adds a (possibly negative) amount to the user's shard row and day row. The caller holds both locks.
create function public._ai_spend_charge(p_user_id uuid, p_day date, p_delta numeric)
  returns void language sql security definer set search_path = '' as $$
  update public.ai_spend_global_days set spent_usd = greatest(spent_usd + p_delta, 0)
   where day = p_day and shard = public._ai_spend_shard(p_user_id);
  update public.ai_spend_user_days set spent_usd = greatest(spent_usd + p_delta, 0)
   where user_id = p_user_id and day = p_day;
$$;

-- Reconciles one expired, unsettled hold: charges the call's ai_calls cost when a row names the
-- reservation, else the whole hold. Takes the locks in the shared order and never creates a day
-- row (a missing day means its history was pruned: nothing is charged). Returns true when it
-- reconciled the hold.
create function public._ai_spend_reconcile(p_reservation_id uuid) returns boolean
  language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid;
  v_day date;
  v_amount numeric;
  v_present boolean;
  v_charge numeric;
begin
  select r.user_id, r.day, r.amount_usd into v_user_id, v_day, v_amount
    from public.ai_spend_reservations r
   where r.id = p_reservation_id and r.settled_at is null and r.expires_at < now();
  if not found then
    return false;
  end if;
  select l.present into v_present from public._ai_spend_lock_day(v_user_id, v_day, false) l;
  perform 1 from public.ai_spend_reservations
   where id = p_reservation_id and settled_at is null for update skip locked;
  if not found then
    return false;
  end if;
  select sum(greatest(c.cost_estimate, 0)) into v_charge from public.ai_calls c
   where c.spend_reservation_id = p_reservation_id;
  v_charge := coalesce(v_charge, v_amount);
  update public.ai_spend_reservations
     set settled_at = now(), actual_usd = v_charge, settled_by = 'reconcile'
   where id = p_reservation_id;
  if v_present then
    perform public._ai_spend_charge(v_user_id, v_day, v_charge);
  end if;
  return true;
end $$;

create function public.ai_spend_reserve(
  p_user_id uuid, p_amount_usd numeric, p_user_cap_usd numeric, p_global_cap_usd numeric,
  p_ttl_seconds integer default 300)
  returns table (reservation_id uuid, allowed boolean, reason text,
                 user_committed_usd numeric, global_committed_usd numeric)
  language plpgsql security definer set search_path = '' as $$
declare
  v_day date := (now() at time zone 'utc')::date;
  v_user_spent numeric;
  v_global_spent numeric;
  v_user numeric;
  v_global numeric;
  v_expired uuid;
  v_id uuid;
begin
  if p_user_id is null then
    raise exception 'ai_spend_reserve: user required' using errcode = '22023';
  end if;
  if p_amount_usd is null or p_amount_usd < 0 or p_amount_usd = 'NaN'::numeric
     or p_user_cap_usd is null or p_user_cap_usd = 'NaN'::numeric
     or p_global_cap_usd is null or p_global_cap_usd = 'NaN'::numeric then
    raise exception 'ai_spend_reserve: amount and caps must be numbers, amount >= 0'
      using errcode = '22023';
  end if;
  if p_ttl_seconds is null or p_ttl_seconds not between 30 and 900 then
    raise exception 'ai_spend_reserve: ttl 30-900 s' using errcode = '22023';
  end if;

  perform public._ai_spend_lock_day(p_user_id, v_day, true);
  -- The caller's own abandoned holds for today, reconciled under the locks already held.
  for v_expired in
    select r.id from public.ai_spend_reservations r
     where r.user_id = p_user_id and r.day = v_day and r.settled_at is null and r.expires_at < now()
     order by r.expires_at limit 100
  loop
    perform public._ai_spend_reconcile(v_expired);
  end loop;

  -- ONE statement, one snapshot: settled spend and open holds, the user's and everyone's.
  select u.spent_usd,
         u.spent_usd + coalesce((select sum(r.amount_usd) from public.ai_spend_reservations r
           where r.user_id = p_user_id and r.day = v_day and r.settled_at is null), 0),
         (select coalesce(sum(g.spent_usd), 0) from public.ai_spend_global_days g where g.day = v_day),
         (select coalesce(sum(g.spent_usd), 0) from public.ai_spend_global_days g where g.day = v_day)
           + coalesce((select sum(r.amount_usd) from public.ai_spend_reservations r
               where r.day = v_day and r.settled_at is null), 0)
    into v_user_spent, v_user, v_global_spent, v_global
    from public.ai_spend_user_days u where u.user_id = p_user_id and u.day = v_day;

  if p_user_cap_usd <= 0 or v_user_spent >= p_user_cap_usd
     or v_user + p_amount_usd > p_user_cap_usd then
    return query select null::uuid, false, 'user_cap'::text, v_user, v_global;
    return;
  end if;
  if p_global_cap_usd <= 0 or v_global_spent >= p_global_cap_usd
     or v_global + p_amount_usd > p_global_cap_usd then
    return query select null::uuid, false, 'global_cap'::text, v_user, v_global;
    return;
  end if;

  insert into public.ai_spend_reservations (user_id, day, amount_usd, expires_at)
  values (p_user_id, v_day, p_amount_usd, now() + make_interval(secs => p_ttl_seconds))
  returning id into v_id;
  return query select v_id, true, null::text, v_user + p_amount_usd, v_global + p_amount_usd;
end $$;

create function public.ai_spend_settle(p_reservation_id uuid, p_actual_usd numeric)
  returns boolean
  language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid;
  v_day date;
  v_present boolean;
  v_by text;
  v_prior numeric;
begin
  if p_reservation_id is null or p_actual_usd is null or p_actual_usd < 0
     or p_actual_usd = 'NaN'::numeric then
    raise exception 'ai_spend_settle: reservation and actual >= 0 required' using errcode = '22023';
  end if;
  select r.user_id, r.day into v_user_id, v_day from public.ai_spend_reservations r
   where r.id = p_reservation_id;
  if not found then
    return false;
  end if;
  select l.present into v_present from public._ai_spend_lock_day(v_user_id, v_day, false) l;
  select r.settled_by, r.actual_usd into v_by, v_prior from public.ai_spend_reservations r
   where r.id = p_reservation_id for update;
  if v_by = 'client' then
    return false;
  end if;
  update public.ai_spend_reservations
     set settled_at = coalesce(settled_at, now()), actual_usd = p_actual_usd, settled_by = 'client'
   where id = p_reservation_id;
  -- Unsettled: charge the actual cost. Reconciled: charge only the difference from what the sweep
  -- charged, so nothing is counted twice.
  if v_present then
    perform public._ai_spend_charge(v_user_id, v_day, p_actual_usd - coalesce(v_prior, 0));
  end if;
  return true;
end $$;

-- Returns how many expired holds it reconciled plus rows it pruned. `remaining` style callers
-- loop while it reports reconciled work (lib/ai/spend.ts sweepSpend, /api/jobs/spend-sweep).
create function public.ai_spend_sweep(p_max integer default 200) returns integer
  language plpgsql security definer set search_path = '' as $$
declare
  v_max integer := greatest(1, least(coalesce(p_max, 200), 2000));
  v_done integer := 0;
  v_deleted integer;
  r record;
begin
  -- One sweep at a time; a second caller returns at once.
  if not pg_try_advisory_xact_lock(hashtext('public.ai_spend_sweep')) then
    return 0;
  end if;
  -- Oldest day first, so a hold older than the 40-day history is reconciled (and later pruned)
  -- before its day rows can go.
  for r in
    select x.id from public.ai_spend_reservations x
     where x.settled_at is null and x.expires_at < now()
     order by x.day, public._ai_spend_shard(x.user_id), x.user_id, x.id limit v_max
  loop
    if public._ai_spend_reconcile(r.id) then
      v_done := v_done + 1;
    end if;
  end loop;

  delete from public.ai_spend_reservations x
   where x.ctid = any (array(
     select y.ctid from public.ai_spend_reservations y
      where y.settled_at is not null and y.created_at < now() - interval '2 days'
      order by y.created_at limit v_max for update skip locked));
  get diagnostics v_deleted = row_count;
  v_done := v_done + v_deleted;
  -- History older than 40 days, only once no reservation names that day.
  delete from public.ai_spend_user_days u
   where u.ctid = any (array(
     select y.ctid from public.ai_spend_user_days y
      where y.day < (now() at time zone 'utc')::date - 40
        and not exists (select 1 from public.ai_spend_reservations x where x.day = y.day)
      limit v_max for update skip locked));
  get diagnostics v_deleted = row_count;
  v_done := v_done + v_deleted;
  delete from public.ai_spend_global_days g
   where g.day < (now() at time zone 'utc')::date - 40
     and not exists (select 1 from public.ai_spend_reservations x where x.day = g.day)
     and not exists (select 1 from public.ai_spend_user_days u where u.day = g.day);
  get diagnostics v_deleted = row_count;
  return v_done + v_deleted;
end $$;

-- How many expired holds still wait for reconciliation (the cron's loop condition).
create function public.ai_spend_expired_count() returns integer
  language sql stable security definer set search_path = '' as $$
  select count(*)::integer from public.ai_spend_reservations
   where settled_at is null and expires_at < now();
$$;

revoke all on function public._ai_spend_shard(uuid) from public, anon, authenticated;
revoke all on function public._ai_spend_lock_day(uuid, date, boolean) from public, anon, authenticated;
revoke all on function public._ai_spend_reconcile(uuid) from public, anon, authenticated;
revoke all on function public.ai_spend_expired_count() from public, anon, authenticated;
revoke all on function public._ai_spend_charge(uuid, date, numeric) from public, anon, authenticated;
revoke all on function public.ai_spend_reserve(uuid, numeric, numeric, numeric, integer)
  from public, anon, authenticated;
revoke all on function public.ai_spend_settle(uuid, numeric) from public, anon, authenticated;
revoke all on function public.ai_spend_sweep(integer) from public, anon, authenticated;
grant execute on function public.ai_spend_reserve(uuid, numeric, numeric, numeric, integer)
  to service_role;
grant execute on function public.ai_spend_settle(uuid, numeric) to service_role;
grant execute on function public.ai_spend_sweep(integer) to service_role;
grant execute on function public.ai_spend_expired_count() to service_role;
