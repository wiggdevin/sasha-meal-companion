-- Reverse of 20261028090000_body_fat_provenance.sql: the sync contract first, then the trigger,
-- then the columns. The provenance values are dropped with the columns; the build this rolls back
-- to never reads them, and it uses Katch-McArdle for any stored body fat, as before.
-- Refuse to drop data written since the forward migration unless the operator says so for this
-- transaction: `set local app.allow_down_data_loss = 'on';` before running this file.
do $refuse$
begin
  if coalesce(current_setting('app.allow_down_data_loss', true), '') <> 'on'
     and (exists (select 1 from user_settings
              where body_fat_source is not null or body_fat_measured_on is not null)) then
    raise exception 'body_fat_provenance down: user_settings.body_fat_source / body_fat_measured_on hold data; set app.allow_down_data_loss = on to drop it'
      using errcode = '55000';
  end if;
end;
$refuse$;

do $migration$
declare
  definition text;
  anchors text[] := array[
    'height_unit, weight_unit, time_zone, body_fat_source,
                               body_fat_measured_on, rev)',
    'p_payload->>''time_zone'', p_payload->>''body_fat_source'',
            (p_payload->>''body_fat_measured_on'')::date, p_rev)',
    'else user_settings.time_zone end,
      body_fat_source = case when p_payload ? ''body_fat_source''
        then p_payload->>''body_fat_source''
        else user_settings.body_fat_source end,
      body_fat_measured_on = case when p_payload ? ''body_fat_measured_on''
        then (p_payload->>''body_fat_measured_on'')::date
        else user_settings.body_fat_measured_on end,'];
  replacements text[] := array[
    'height_unit, weight_unit, time_zone, rev)',
    'p_payload->>''time_zone'', p_rev)',
    'else user_settings.time_zone end,'];
  i integer;
begin
  select pg_get_functiondef(
    'public._sync_upsert(uuid,text,text,jsonb,integer)'::regprocedure
  ) into definition;
  if position(anchors[1] in definition) = 0 then
    return;
  end if;
  for i in 1 .. array_length(anchors, 1) loop
    if (length(definition) - length(replace(definition, anchors[i], '')))
       / length(anchors[i]) <> 1 then
      raise exception 'body_fat_provenance down: anchor % does not occur exactly once', i;
    end if;
    definition := replace(definition, anchors[i], replacements[i]);
  end loop;
  execute definition;
end;
$migration$;
revoke execute on function _sync_upsert(uuid, text, text, jsonb, integer) from public, anon, authenticated;

drop trigger if exists user_settings_body_fat_provenance on user_settings;
drop function if exists user_settings_body_fat_provenance();
alter table user_settings drop column body_fat_measured_on, drop column body_fat_source;
