-- W010 (audit 2026-10-10 F04: A009, A081, A095, A050). Three changes to the health ingest path.
--
-- 1. `health_ingest_record`: the dedupe event and the samples in ONE transaction (A009, A081).
--    The route used to call `health_ingest_event` and then `health_ingest_apply` as two PostgREST
--    requests, so two transactions. When the apply failed (a timeout, a deploy window), the event
--    row stayed committed and the exporter's identical retry hit its unique (source_id,
--    payload_hash) key: is_new = false, answered "duplicate", the samples never written. Now one
--    function call does both, and PostgREST runs one call as one transaction, so a failed apply
--    rolls the event back with it and the retry is a new payload again. A concurrent resend still
--    waits on the first insert's unique key and then sees whichever outcome committed.
--
-- 2. The correction upsert in `health_ingest_apply` also moves `start_time` and `tz` (A095). With a
--    vendor_sample_id (every HAE, Shortcut and Oura sample) the dedupe key holds no times, so a
--    re-export with an earlier bedtime or another zone kept the first version's start and zone
--    while its value and end moved: a window that never existed. `health_weigh_in` already updates
--    both. The key is unchanged by this: on the vendor branch it holds no times, and on the
--    computed branch the times ARE the key, so a conflicting row already has the same ones.
--
-- 3. `weigh_ins` appends `source_kind` (A050), so the estimator can apply the dashboard's rule — a
--    scale beats a number the user typed (lib/health/daily.ts rollUpDay, `daily_health` since
--    20261019090000) — instead of taking the median of both. A column appended at the end, as
--    CREATE OR REPLACE VIEW requires; every existing reader names its columns.
--
-- Live-safe: functions replaced and one added, one view replaced (a brief lock on the view only),
-- no data moved. Order: apply to production BEFORE the W010 code merges — that code calls
-- `health_ingest_record` and selects `weigh_ins.source_kind`. The older code keeps working against
-- it (it calls the two older functions, both still here).

set local lock_timeout = '3s';
set local statement_timeout = '30s';

-- ---------- 2. the correction upsert ----------------------------------------------------------
-- 20261013090200's body, with `start_time` and `tz` added to the DO UPDATE SET list.
create or replace function health_ingest_apply(p_user_id uuid, p_source_id uuid, p_event_id uuid,
                                    p_samples jsonb)
  returns table (accepted int, updated int, skipped int)
  language plpgsql security definer set search_path = public as $$
declare v_total int; v_accepted int; v_updated int;
begin
  if p_user_id is null or p_source_id is null then
    raise exception 'user_required' using errcode = '22023';
  end if;
  if not exists (select 1 from health_sources s
                  where s.id = p_source_id and s.user_id = p_user_id and s.revoked_at is null) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select count(*) into v_total from jsonb_array_elements(coalesce(p_samples, '[]'::jsonb));

  with parsed as (
    select * from jsonb_to_recordset(coalesce(p_samples, '[]'::jsonb)) as x(
      type text, value numeric, unit text, start_time timestamptz, end_time timestamptz,
      tz text, vendor_sample_id text, vendor_updated_at timestamptz, device_label text)
  ),
  -- ON CONFLICT DO UPDATE cannot touch the same row twice in one statement, so a payload that
  -- repeats a dedupe key keeps only its newest entry; the rest fall out as skipped.
  incoming as (
    select distinct on (p.type || ':' || coalesce(p.vendor_sample_id,
             (extract(epoch from (p.start_time - timestamptz 'epoch')))::bigint::text
             || '|' || (extract(epoch from (p.end_time   - timestamptz 'epoch')))::bigint::text
             || '|' || coalesce(p.device_label, '')))
           p.*
      from parsed p
     order by p.type || ':' || coalesce(p.vendor_sample_id,
             (extract(epoch from (p.start_time - timestamptz 'epoch')))::bigint::text
             || '|' || (extract(epoch from (p.end_time   - timestamptz 'epoch')))::bigint::text
             || '|' || coalesce(p.device_label, '')),
           p.vendor_updated_at desc nulls last
  ),
  written as (
    insert into health_samples (user_id, source_id, type, value, unit, start_time, end_time, tz,
                                vendor_sample_id, vendor_updated_at, device_label, ingest_event_id)
    select p_user_id, p_source_id, i.type, i.value, i.unit, i.start_time, i.end_time,
           coalesce(i.tz, 'UTC'), i.vendor_sample_id, i.vendor_updated_at, i.device_label, p_event_id
      from incoming i
    on conflict (user_id, source_id, dedupe_key) do update
       set value = excluded.value, unit = excluded.unit,
           start_time = excluded.start_time, end_time = excluded.end_time, tz = excluded.tz,
           device_label = excluded.device_label, ingest_event_id = excluded.ingest_event_id,
           vendor_updated_at = excluded.vendor_updated_at
     where excluded.vendor_updated_at is null
        or health_samples.vendor_updated_at is null
        or excluded.vendor_updated_at > health_samples.vendor_updated_at
    returning (xmax::text::bigint = 0) as inserted
  )
  select count(*) filter (where w.inserted)::int,
         count(*) filter (where not w.inserted)::int
    into v_accepted, v_updated
    from written w;

  accepted := coalesce(v_accepted, 0);
  updated  := coalesce(v_updated, 0);
  skipped  := v_total - accepted - updated;
  return next;
end; $$;
revoke execute on function health_ingest_apply(uuid, uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function health_ingest_apply(uuid, uuid, uuid, jsonb) to service_role;

-- ---------- 1. event and samples, one transaction ---------------------------------------------
-- The two existing functions, called in order inside this one. A completed payload's resend is
-- answered is_new = false with zero counts and nothing applied, exactly as before; only a payload
-- whose apply never committed is now applied on the retry. The Oura pull keeps its two calls: it
-- re-applies whatever is_new says (lib/server/oura.ts), so it never had this loss.
create function health_ingest_record(p_user_id uuid, p_source_id uuid, p_payload_hash bytea,
                                     p_samples jsonb)
  returns table (event_id uuid, is_new boolean, accepted int, updated int, skipped int)
  language plpgsql security definer set search_path = public as $$
declare v_event uuid; v_new boolean;
begin
  select e.id, e.is_new into v_event, v_new
    from health_ingest_event(p_user_id, p_source_id, p_payload_hash, 'applied') e;
  event_id := v_event;
  is_new := v_new;
  if not v_new then
    accepted := 0; updated := 0; skipped := 0;
    return next;
    return;
  end if;
  select a.accepted, a.updated, a.skipped into accepted, updated, skipped
    from health_ingest_apply(p_user_id, p_source_id, v_event, p_samples) a;
  return next;
end; $$;
revoke execute on function health_ingest_record(uuid, uuid, bytea, jsonb)
  from public, anon, authenticated;
grant execute on function health_ingest_record(uuid, uuid, bytea, jsonb) to service_role;

-- ---------- 3. weigh_ins names the source kind ------------------------------------------------
-- The six columns 20260911000500 defined, in order and type, then `source_kind`. A LEFT JOIN and
-- 'unknown', as `daily_health` does, so a sample whose source row is gone reads as an ingest
-- reading rather than silently becoming manual. security_invoker is restated so the replace keeps
-- the base tables' RLS (her own samples, her own sources).
create or replace view weigh_ins with (security_invoker = true) as
  select hs.user_id, hs.id, hs.start_time, (hs.start_time at time zone hs.tz)::date as local_date,
         hs.value, hs.unit, coalesce(src.kind, 'unknown') as source_kind
    from health_samples hs
    left join health_sources src on src.id = hs.source_id
   where hs.type = 'body_mass';
revoke all on weigh_ins from anon, authenticated;
grant select on weigh_ins to authenticated;
