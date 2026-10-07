-- Audit 2026-09-13, findings #19/#42/#91 (fix branch fix-health-dedupe-key-integrity).
--
-- #19: dedupe_key ignored device_label, so two devices (Apple Watch + iPhone, the common Health
-- Auto Export case) reporting the same type in the same hour collided on one key and one device's
-- reading silently vanished. #91: dedupe_key used vendor_sample_id ALONE when present, so two
-- different sample types sharing one vendor id (e.g. sleep_asleep/sleep_in_bed from one exported
-- record) collided and the second sample's type was silently discarded. Both are fixed by folding
-- type in unconditionally and device_label into the computed branch — see lib/health/dedupe.ts,
-- which this generated column must stay byte-identical to.
--
-- A generated column's expression can't be ALTERed in place, so it is dropped and recreated; the
-- unique index that depends on it is dropped along with the column and is recreated here too.
alter table health_samples drop column dedupe_key;
alter table health_samples add column dedupe_key text generated always as (
  type || ':' || coalesce(vendor_sample_id,
    (extract(epoch from (start_time - timestamptz 'epoch')))::bigint::text
    || '|' || (extract(epoch from (end_time - timestamptz 'epoch')))::bigint::text
    || '|' || coalesce(device_label, ''))) stored;
create unique index health_samples_dedupe on health_samples (user_id, source_id, dedupe_key);

-- health_ingest_apply: mirror the same widened key in the incoming CTE's distinct-on/order-by (so an
-- intra-payload collision resolves on the same identity the unique index now enforces), and fix #42
-- (correction upsert never fires for HAE or Oura samples) by widening the vendor_updated_at freshness
-- gate on the ON CONFLICT DO UPDATE instead of dropping it. Neither normalizeHealthAutoExport nor
-- lib/oura/map.ts ever sets vendor_updated_at, so the old gate (which required the incoming value to
-- be non-null) was permanently closed for both real sources; but normalizeShortcut DOES pass
-- vendor_updated_at through for apple_health_shortcut, and ordering must still be enforced there — a
-- stale correction must not clobber a fresher stored reading. So the gate now fires the update when
-- either side has no vendor_updated_at to compare (HAE/Oura, or a first-ever value), and otherwise
-- only when the incoming value is newer.
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
