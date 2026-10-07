-- Drops only what 20260925000000 created and restores Phase 0's policies and write grants.
-- Ingested observations are never deleted (spec §11): seven days of a person's life cannot be
-- re-collected, so the sample rows stay and only device_label — this migration's own column — goes.
drop function if exists health_ingest_apply(uuid, uuid, uuid, jsonb);
drop function if exists health_ingest_event(uuid, uuid, bytea, text);
drop view if exists daily_health;

drop policy if exists health_samples_ro on health_samples;
drop policy if exists ingest_events_ro on ingest_events;
create policy health_samples_rw on health_samples for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy ingest_events_rw on ingest_events for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select, insert, update, delete on table health_samples to authenticated;
grant select, insert, update, delete on table ingest_events to authenticated;

drop index if exists ingest_events_source_time;
drop index if exists health_samples_user_type_time;
alter table health_samples drop column if exists device_label;
alter table health_samples drop constraint if exists health_samples_type_ck;
