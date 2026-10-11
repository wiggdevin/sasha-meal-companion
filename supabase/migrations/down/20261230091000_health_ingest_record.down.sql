-- Down for 20261230091000_health_ingest_record. Run it only after the code that calls
-- `health_ingest_record` and selects `weigh_ins.source_kind` is gone. No data moves: stored samples
-- keep whatever start_time and tz the corrections wrote.

set local lock_timeout = '3s';
set local statement_timeout = '30s';

drop function if exists health_ingest_record(uuid, uuid, bytea, jsonb);

-- 20261013090200's apply body: the correction upsert without start_time and tz.
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
       set value = excluded.value, unit = excluded.unit, end_time = excluded.end_time,
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

-- CREATE OR REPLACE VIEW cannot drop a column, so the view is re-created as 20260911000500 had it.
drop view weigh_ins;
create view weigh_ins with (security_invoker = true) as
  select user_id, id, start_time, (start_time at time zone tz)::date as local_date, value, unit
    from health_samples where type = 'body_mass';
revoke all on weigh_ins from anon, authenticated;
grant select on weigh_ins to authenticated;
