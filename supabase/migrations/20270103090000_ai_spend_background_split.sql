-- OD01 (owner decisions 2026-10-12): background AI work gets its own daily ceiling, and part of
-- each account's daily cap is kept for that account's own interactive turns.
--
-- The $50 global ceiling and the $2 account cap stay (20261218090100). On top of them:
--   * Every reservation is marked `background` or not. Background is a model call no person is
--     waiting on (the weekly review, facet warming; lib/ai/call-registry.ts BACKGROUND_PURPOSES).
--   * Background calls, across every account, may commit at most p_background_cap_usd a UTC day
--     (lib/ai/spend.ts: AI_BACKGROUND_DAILY_SPEND_CAP_USD, default $10). Refused: `background_cap`.
--   * One account's background calls may commit at most its cap less p_interactive_reserve_usd
--     (AI_INTERACTIVE_RESERVE_USD, default $1 of the $2), so background work can never use up the
--     share kept for the person's own turns. Refused: `background_user_cap`.
--   * Both splits count open reservations: committed = every settled background hold's actual
--     cost plus every unsettled background hold's amount, read in the same one-statement snapshot
--     as the existing checks. The account split is exact (the account's day row is locked); the
--     global background split has the same bounded term as the global ceiling (reservations in
--     flight on other shards at the same moment). Interactive calls are checked exactly as before.
--   * On the day this is applied, background spend from before it (and holds opened before it)
--     counts only toward the overall caps, not the background splits: a one-day gap.
--   * A refused weekly review falls back to the logged-days review for that week
--     (lib/coach/weekly-review.ts), as for any model failure.
--
-- ai_spend_reserve_split is the new entry point. The old five-argument ai_spend_reserve stays and
-- now calls it as an interactive reservation, so a build from before this migration keeps working
-- unchanged, and the new build needs this migration: APPLY TO PRODUCTION BEFORE THE CODE MERGES.
--
-- Live-safe: one boolean column with a constant default (no rewrite), one partial index on a
-- small table, new and replaced functions. Down:
-- supabase/migrations/down/20270103090000_ai_spend_background_split.down.sql.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

alter table public.ai_spend_reservations add column background boolean not null default false;
comment on column public.ai_spend_reservations.background is
  'A model call no person is waiting on (OD01); counted against the background splits.';
create index ai_spend_reservations_background_day on public.ai_spend_reservations (day, user_id)
  where background;

create function public.ai_spend_reserve_split(
  p_user_id uuid, p_amount_usd numeric, p_user_cap_usd numeric, p_global_cap_usd numeric,
  p_ttl_seconds integer, p_background boolean, p_background_cap_usd numeric,
  p_interactive_reserve_usd numeric)
  returns table (reservation_id uuid, allowed boolean, reason text,
                 user_committed_usd numeric, global_committed_usd numeric)
  language plpgsql security definer set search_path = '' as $$
declare
  v_day date := (now() at time zone 'utc')::date;
  v_user_spent numeric;
  v_global_spent numeric;
  v_user numeric;
  v_global numeric;
  v_user_background numeric;
  v_background numeric;
  v_expired uuid;
  v_id uuid;
begin
  if p_user_id is null then
    raise exception 'ai_spend_reserve_split: user required' using errcode = '22023';
  end if;
  if p_amount_usd is null or p_amount_usd < 0 or p_amount_usd = 'NaN'::numeric
     or p_user_cap_usd is null or p_user_cap_usd = 'NaN'::numeric
     or p_global_cap_usd is null or p_global_cap_usd = 'NaN'::numeric
     or p_background is null
     or p_background_cap_usd is null or p_background_cap_usd = 'NaN'::numeric
     or p_interactive_reserve_usd is null or p_interactive_reserve_usd < 0
     or p_interactive_reserve_usd = 'NaN'::numeric then
    raise exception 'ai_spend_reserve_split: amount, caps and reserve must be numbers, amount and reserve >= 0'
      using errcode = '22023';
  end if;
  if p_ttl_seconds is null or p_ttl_seconds not between 30 and 900 then
    raise exception 'ai_spend_reserve_split: ttl 30-900 s' using errcode = '22023';
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

  -- ONE statement, one snapshot: settled spend and open holds, the user's and everyone's, and
  -- what background calls have committed (settled actuals plus open holds), the user's and everyone's.
  select u.spent_usd,
         u.spent_usd + coalesce((select sum(r.amount_usd) from public.ai_spend_reservations r
           where r.user_id = p_user_id and r.day = v_day and r.settled_at is null), 0),
         (select coalesce(sum(g.spent_usd), 0) from public.ai_spend_global_days g where g.day = v_day),
         (select coalesce(sum(g.spent_usd), 0) from public.ai_spend_global_days g where g.day = v_day)
           + coalesce((select sum(r.amount_usd) from public.ai_spend_reservations r
               where r.day = v_day and r.settled_at is null), 0),
         coalesce((select sum(coalesce(r.actual_usd, r.amount_usd)) from public.ai_spend_reservations r
           where r.background and r.day = v_day and r.user_id = p_user_id), 0),
         coalesce((select sum(coalesce(r.actual_usd, r.amount_usd)) from public.ai_spend_reservations r
           where r.background and r.day = v_day), 0)
    into v_user_spent, v_user, v_global_spent, v_global, v_user_background, v_background
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
  if p_background then
    if p_user_cap_usd - p_interactive_reserve_usd <= 0
       or v_user_background + p_amount_usd > p_user_cap_usd - p_interactive_reserve_usd then
      return query select null::uuid, false, 'background_user_cap'::text, v_user, v_global;
      return;
    end if;
    if p_background_cap_usd <= 0 or v_background + p_amount_usd > p_background_cap_usd then
      return query select null::uuid, false, 'background_cap'::text, v_user, v_global;
      return;
    end if;
  end if;

  insert into public.ai_spend_reservations (user_id, day, amount_usd, expires_at, background)
  values (p_user_id, v_day, p_amount_usd, now() + make_interval(secs => p_ttl_seconds), p_background)
  returning id into v_id;
  return query select v_id, true, null::text, v_user + p_amount_usd, v_global + p_amount_usd;
end $$;

-- The pre-OD01 entry point: an interactive reservation, unchanged for an older build.
create or replace function public.ai_spend_reserve(
  p_user_id uuid, p_amount_usd numeric, p_user_cap_usd numeric, p_global_cap_usd numeric,
  p_ttl_seconds integer default 300)
  returns table (reservation_id uuid, allowed boolean, reason text,
                 user_committed_usd numeric, global_committed_usd numeric)
  language sql security definer set search_path = '' as $$
  select * from public.ai_spend_reserve_split(p_user_id, p_amount_usd, p_user_cap_usd,
    p_global_cap_usd, p_ttl_seconds, false, 0, 0);
$$;

revoke all on function public.ai_spend_reserve_split(uuid, numeric, numeric, numeric, integer,
  boolean, numeric, numeric) from public, anon, authenticated;
revoke all on function public.ai_spend_reserve(uuid, numeric, numeric, numeric, integer)
  from public, anon, authenticated;
grant execute on function public.ai_spend_reserve_split(uuid, numeric, numeric, numeric, integer,
  boolean, numeric, numeric) to service_role;
grant execute on function public.ai_spend_reserve(uuid, numeric, numeric, numeric, integer)
  to service_role;
