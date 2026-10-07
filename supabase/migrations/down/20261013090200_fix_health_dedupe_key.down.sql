-- Down for 20261013090200_fix_health_dedupe_key.sql. Restores the original (device/type-blind)
-- dedupe_key formula and the original vendor_updated_at-gated health_ingest_apply. Any rows written
-- post-fix that only differ by device_label, or by type under a shared vendor_sample_id, collide
-- under the original formula, so the original unique index can't be recreated until they are
-- collapsed to one row each -- exactly the silent loss the original formula always caused, made
-- explicit here (kept row: most recently received per colliding group).
delete from health_samples hs using (
  select id, row_number() over (
    partition by user_id, source_id, coalesce(vendor_sample_id,
      type || '|' || (extract(epoch from (start_time - timestamptz 'epoch')))::bigint::text
           || '|' || (extract(epoch from (end_time - timestamptz 'epoch')))::bigint::text)
    order by received_at desc, id) as rn
  from health_samples
) dupes
where hs.id = dupes.id and dupes.rn > 1;

alter table health_samples drop column dedupe_key;
alter table health_samples add column dedupe_key text generated always as (coalesce(vendor_sample_id,
    type || '|' || (extract(epoch from (start_time - timestamptz 'epoch')))::bigint::text
         || '|' || (extract(epoch from (end_time - timestamptz 'epoch')))::bigint::text)) stored;
create unique index health_samples_dedupe on health_samples (user_id, source_id, dedupe_key);

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
