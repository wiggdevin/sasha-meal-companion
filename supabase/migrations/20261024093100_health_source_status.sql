-- One row per source, with its own newest receipt. The invoker's RLS applies to both base tables,
-- so an authenticated browser sees only its health_sources and ingest_events rows.
create view health_source_status with (security_invoker = true) as
  select s.id, s.user_id, s.kind, s.device_label, s.created_at, s.revoked_at,
    (select max(e.received_at)
       from ingest_events e
      where e.user_id = s.user_id and e.source_id = s.id) as last_received_at
  from health_sources s;

grant select on health_source_status to authenticated;
