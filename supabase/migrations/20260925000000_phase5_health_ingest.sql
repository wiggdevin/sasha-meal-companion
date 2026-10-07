-- Phase 5 (spec §4). Phase 0 already ships health_sources, ingest_events and health_samples with the
-- generated dedupe_key. This migration constrains them, adds the read view, and moves every write
-- behind two security-definer RPCs, because ingest identity is a source token, not a JWT (§2.2).

alter table health_samples add constraint health_samples_type_ck check (type in
  ('body_mass','step_count','active_energy','basal_energy','sleep_asleep','sleep_in_bed',
   'resting_heart_rate','hrv_sdnn','readiness_score'));

-- One Health Auto Export source delivers Watch rows and phone rows; the §3.5 overlap rule needs to
-- tell them apart, so the label lives on the sample, not only on the source.
alter table health_samples add column device_label text;

create index health_samples_user_type_time on health_samples (user_id, type, start_time desc);
create index ingest_events_source_time on ingest_events (source_id, received_at desc);

-- Phase 0's pattern-1 loop gave both tables a full _rw policy and all four grants. Observations are
-- written only by the privileged boundary, so the browser keeps select and nothing else.
drop policy health_samples_rw on health_samples;
drop policy ingest_events_rw on ingest_events;
create policy health_samples_ro on health_samples for select to authenticated
  using (user_id = (select auth.uid()));
create policy ingest_events_ro on ingest_events for select to authenticated
  using (user_id = (select auth.uid()));
revoke insert, update, delete on table health_samples from authenticated;
revoke insert, update, delete on table ingest_events from authenticated;
-- health_sources keeps its Phase 0 _rw policy: she manages her own sources.

create view daily_health with (security_invoker = true) as
  with d as (select user_id, type, value, start_time,
                    (start_time at time zone tz)::date as local_date from health_samples)
  select user_id, local_date,
    sum(value) filter (where type = 'step_count')    as steps,
    sum(value) filter (where type = 'active_energy') as active_kcal,
    max(value) filter (where type = 'sleep_asleep')  as sleep_minutes,
    (array_agg(value order by start_time desc) filter (where type = 'body_mass'))[1] as body_mass_kg
  from d group by user_id, local_date;
grant select on daily_health to authenticated;

-- One event row per payload. unique (source_id, payload_hash) makes a resend land on the existing
-- row, which the conflict branch flips to 'duplicate'. The same statement returns xmax = 0, so the
-- caller learns whether *its own* attempt inserted the row without a later read: two concurrent
-- resends cannot both see the loser's update and skip apply. Mirrors health_ingest_apply below.
create function health_ingest_event(p_user_id uuid, p_source_id uuid,
                                    p_payload_hash bytea, p_status text)
  returns table(id uuid, is_new boolean)
  language plpgsql security definer set search_path = public as $$
begin
  if p_user_id is null or p_source_id is null then
    raise exception 'user_required' using errcode = '22023';
  end if;
  if not exists (select 1 from health_sources s
                  where s.id = p_source_id and s.user_id = p_user_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
    insert into ingest_events (user_id, source_id, payload_hash, status)
      values (p_user_id, p_source_id, p_payload_hash, coalesce(p_status, 'applied'))
    on conflict (source_id, payload_hash) do update
      set status = 'duplicate'
    returning ingest_events.id, (xmax = 0);
end; $$;
revoke execute on function health_ingest_event(uuid, uuid, bytea, text)
  from public, anon, authenticated;
grant execute on function health_ingest_event(uuid, uuid, bytea, text) to service_role;

-- The §3.5 correction upsert. xmax = 0 on a RETURNING row means the row was inserted, not updated,
-- which is how accepted and updated are separated without a pre-select. Rows that conflict and fail
-- the freshness WHERE are not returned at all, so they fall out as skipped.
create function health_ingest_apply(p_user_id uuid, p_source_id uuid, p_event_id uuid,
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
    select distinct on (coalesce(p.vendor_sample_id,
             p.type || '|' || (extract(epoch from (p.start_time - timestamptz 'epoch')))::bigint::text
                    || '|' || (extract(epoch from (p.end_time   - timestamptz 'epoch')))::bigint::text))
           p.*
      from parsed p
     order by coalesce(p.vendor_sample_id,
             p.type || '|' || (extract(epoch from (p.start_time - timestamptz 'epoch')))::bigint::text
                    || '|' || (extract(epoch from (p.end_time   - timestamptz 'epoch')))::bigint::text),
           p.vendor_updated_at desc nulls last
  ),
  written as (
    insert into health_samples (user_id, source_id, type, value, unit, start_time, end_time, tz,
                                vendor_sample_id, vendor_updated_at, device_label, ingest_event_id)
    select p_user_id, p_source_id, i.type, i.value, i.unit, i.start_time, i.end_time,
           coalesce(i.tz, 'UTC'), i.vendor_sample_id, i.vendor_updated_at, i.device_label, p_event_id
      from incoming i
    on conflict (user_id, source_id, dedupe_key) do update
       set value = excluded.value, unit = excluded.unit, end_time = excluded.end_time,
           device_label = excluded.device_label, ingest_event_id = excluded.ingest_event_id,
           vendor_updated_at = excluded.vendor_updated_at
     where excluded.vendor_updated_at is not null
       and (health_samples.vendor_updated_at is null
            or excluded.vendor_updated_at > health_samples.vendor_updated_at)
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
