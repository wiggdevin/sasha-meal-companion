drop function if exists health_ingest_time_zone_context(uuid, uuid);
drop function if exists set_health_source_time_zone(uuid, uuid, text);
drop trigger if exists health_sources_time_zone_iana on health_sources;
drop trigger if exists user_settings_time_zone_iana on user_settings;
drop function if exists validate_health_time_zone();
alter table health_sources drop column if exists time_zone;
alter table user_settings drop column if exists time_zone;
