-- T8 (docs/plans/2026-09-17-t8-water-and-weight.md) §2: the morning weight she types reaches the
-- server as a `health_samples` row, and the pill shows it.
--
-- Until now the FAB's "Morning weight" wrote `weightLb` into the legacy per-device store and stopped
-- there. `health_samples` is read-only to `authenticated` (20260925000000 revoked insert, update and
-- delete), so a typed weight could not become a sample at all: the header pill reads the ingest
-- value through `daily_health`, and the expenditure estimator reads the `weigh_ins` view over
-- `health_samples where type = 'body_mass'`. Neither ever saw a number she typed.
--
-- Two halves, in this order:
--
--   1. `health_weigh_in`, the security-definer write path. It is scoped to `auth.uid()` — the caller
--      names a day, a zone and a weight, never a user — so it cannot file a row under anyone else.
--   2. `daily_health`, re-stated so the SQL half picks the same winner the roll-up does: an INGEST
--      sample for the day beats a manual one, however much newer the manual row is.
--
-- The 'manual' source kind is not new: 20260911000400 has allowed it since Phase 0 precisely so a
-- typed weigh-in would have a source row to point at. This is the first thing to create one.

-- ---------- 1. the write path ----------------------------------------------------------
--
-- One manual row per user per local day. `vendor_sample_id = 'manual:<local_date>'` IS the natural
-- key: `dedupe_key` is `coalesce(vendor_sample_id, …)`, and 20260911000400's unique index over
-- (user_id, source_id, dedupe_key) is what makes typing a second number for the same day a
-- correction rather than a second row. `health_ingest_apply` uses the same conflict target.
--
-- 07:00 local, not `now()`: this is the morning weigh-in for a named day, and the roll-up buckets a
-- sample by `(start_time at time zone tz)::date`. A row stamped at the moment she typed it would
-- land on the wrong day whenever she types yesterday's number after midnight.
--
-- One `manual` source per user, enforced rather than looked up. The function below reads the source
-- before it writes one, and a lookup-then-insert is a race: two first-time weigh-ins arriving
-- together both read nothing, both insert, and the day then has two sources — which means two
-- samples, because the dedupe index is per (user, SOURCE, key) and neither row conflicts with the
-- other. The partial index makes the second insert a no-op the function recovers from, so the race
-- resolves to one source whichever order the two land in.
create unique index health_sources_one_manual on health_sources (user_id)
  where kind = 'manual' and revoked_at is null;

create function health_weigh_in(p_local_date date, p_tz text, p_kg numeric)
  returns table (sample_id uuid, kg numeric)
  language plpgsql security definer set search_path = public as $$
declare
  v_user   uuid := (select auth.uid());
  v_source uuid;
  v_at     timestamptz;
begin
  if v_user is null then
    raise exception 'user_required' using errcode = '22023';
  end if;
  if p_local_date is null or p_tz is null or p_kg is null then
    raise exception 'bad_weigh_in' using errcode = '22023';
  end if;
  -- A human body, in the kilograms this column stores. 20 kg is below any adult and 400 kg above
  -- any; a typo of 10 (pounds, meant as pounds) is what this actually catches.
  if p_kg < 20 or p_kg > 400 then
    raise exception 'weight_out_of_range' using errcode = '22023';
  end if;

  -- The zone must be a REAL zone name, checked against the tz database rather than by seeing
  -- whether `at time zone` complains. It does not complain nearly enough: it also accepts an
  -- interval-shaped string, so '15:00' is taken as a fixed +15:00 offset, silently shifts the day
  -- the sample lands on, and `bad_tz` never fires. A name check is the only thing that separates
  -- "America/Los_Angeles" from a number.
  if not exists (select 1 from pg_timezone_names z where z.name = p_tz) then
    raise exception 'bad_tz' using errcode = '22023';
  end if;
  v_at := (p_local_date + time '07:00') at time zone p_tz;

  -- Tomorrow is allowed — she may be a zone ahead of the server, or typing just before midnight.
  -- Two days ahead is a typed date that has not happened.
  if p_local_date > ((now() at time zone p_tz)::date + 1) then
    raise exception 'future_date' using errcode = '22023';
  end if;

  select s.id into v_source
    from health_sources s
   where s.user_id = v_user and s.kind = 'manual' and s.revoked_at is null
   limit 1;
  if v_source is null then
    -- The loser of the race inserts nothing and returns nothing, so it reads the winner's row
    -- instead. `do nothing` rather than `do update`: there is nothing on that row to correct.
    insert into health_sources (user_id, kind, device_label) values (v_user, 'manual', 'manual')
    on conflict (user_id) where kind = 'manual' and revoked_at is null do nothing
    returning id into v_source;
    if v_source is null then
      select s.id into v_source
        from health_sources s
       where s.user_id = v_user and s.kind = 'manual' and s.revoked_at is null
       limit 1;
    end if;
  end if;

  -- `device_label` rides the sample as well as the source: lib/health/daily.ts lists a day's sources
  -- by the sample's own label, and a null there reads as "unknown" on the body screen.
  return query
  insert into health_samples (user_id, source_id, type, value, unit, start_time, end_time, tz,
                              device_label, vendor_sample_id)
    values (v_user, v_source, 'body_mass', p_kg, 'kg', v_at, v_at, p_tz,
            'manual', 'manual:' || to_char(p_local_date, 'YYYY-MM-DD'))
  on conflict (user_id, source_id, dedupe_key) do update
     set value = excluded.value, unit = excluded.unit, start_time = excluded.start_time,
         end_time = excluded.end_time, tz = excluded.tz, received_at = now()
  returning health_samples.id, health_samples.value;
end; $$;
revoke execute on function health_weigh_in(date, text, numeric) from public, anon;
grant execute on function health_weigh_in(date, text, numeric) to authenticated;

-- ---------- 2. the read rule -----------------------------------------------------------
--
-- CREATE OR REPLACE VIEW can only append columns, so the nine 20261013090000 left are re-stated in
-- the same order and with the same types; only `body_mass_kg`'s expression changes. `source_kind`
-- comes from a LEFT JOIN so a sample whose source row is gone still counts as an ingest reading
-- rather than silently becoming manual.
--
-- `order by (source_kind = 'manual')` sorts false before true: every ingest sample first, her own
-- last, `start_time desc` inside each group. That is rule 1 over rule 2, and it matches
-- lib/health/daily.ts's roll-up — the two halves of the same number must not disagree.
create or replace view daily_health with (security_invoker = true) as
  with d as (select hs.user_id, hs.type, hs.value, hs.start_time, hs.end_time,
                    (hs.start_time at time zone hs.tz)::date as local_date,
                    coalesce(src.kind, 'unknown') as source_kind
               from health_samples hs
               left join health_sources src on src.id = hs.source_id)
  select user_id, local_date,
    sum(value) filter (where type = 'step_count')    as steps,
    sum(value) filter (where type = 'active_energy') as active_kcal,
    max(value) filter (where type = 'sleep_asleep')  as sleep_minutes,
    (array_agg(value order by (source_kind = 'manual'), start_time desc)
       filter (where type = 'body_mass'))[1] as body_mass_kg,
    -- `::numeric`, and never a rounding function: the renderer is the one place that rounds.
    (min(value) filter (where type = 'resting_heart_rate'))::numeric as resting_heart_rate,
    (avg(value) filter (where type = 'hrv_sdnn'))::numeric           as hrv_sdnn,
    ((array_agg(value order by end_time desc) filter (where type = 'readiness_score'))[1])::numeric
      as readiness_score
  from d group by user_id, local_date;
grant select on daily_health to authenticated;
