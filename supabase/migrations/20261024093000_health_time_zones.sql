-- User-local display/jobs use user_settings.time_zone. Each health source separately remembers
-- the last IANA zone it reported or was configured with, so travel does not rebucket old samples.
alter table user_settings add column time_zone text;
alter table health_sources add column time_zone text;

create function validate_health_time_zone()
  returns trigger
  language plpgsql set search_path = pg_catalog as $$
begin
  if new.time_zone is not null and not exists (
    select 1 from pg_timezone_names where name = new.time_zone
  ) then
    raise exception 'invalid_time_zone' using errcode = '22023';
  end if;
  return new;
end; $$;

create trigger user_settings_time_zone_iana
  before insert or update of time_zone on user_settings
  for each row execute function validate_health_time_zone();
create trigger health_sources_time_zone_iana
  before insert or update of time_zone on health_sources
  for each row execute function validate_health_time_zone();

create function set_health_source_time_zone(
  p_user_id uuid,
  p_source_id uuid,
  p_time_zone text
) returns void
language plpgsql security definer set search_path = public, pg_catalog as $$
begin
  if p_user_id is null or p_source_id is null then
    raise exception 'user_required' using errcode = '22023';
  end if;
  if p_time_zone is null or not exists (
    select 1 from pg_timezone_names where name = p_time_zone
  ) then
    raise exception 'invalid_time_zone' using errcode = '22023';
  end if;

  update health_sources
     set time_zone = p_time_zone
   where id = p_source_id and user_id = p_user_id and revoked_at is null;
  if not found then
    raise exception 'forbidden' using errcode = '42501';
  end if;
end; $$;
revoke execute on function set_health_source_time_zone(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function set_health_source_time_zone(uuid, uuid, text) to service_role;

create function health_ingest_time_zone_context(
  p_user_id uuid,
  p_source_id uuid
) returns table(source_time_zone text, user_time_zone text)
language plpgsql security definer set search_path = public as $$
begin
  if p_user_id is null or p_source_id is null then
    raise exception 'user_required' using errcode = '22023';
  end if;
  if not exists (
    select 1 from health_sources s
     where s.id = p_source_id and s.user_id = p_user_id and s.revoked_at is null
  ) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
    select s.time_zone, u.time_zone
      from health_sources s
      left join user_settings u on u.user_id = s.user_id
     where s.id = p_source_id and s.user_id = p_user_id;
end; $$;
revoke execute on function health_ingest_time_zone_context(uuid, uuid)
  from public, anon, authenticated;
grant execute on function health_ingest_time_zone_context(uuid, uuid) to service_role;
