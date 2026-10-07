-- Reverse of 20261225090000_user_settings_mascot.sql: the sync branch first, then the column.
-- Refuses while any account has chosen a mascot other than the default, unless
-- app.allow_down_data_loss = on: dropping the column would silently forget that choice.
do $$
begin
  if coalesce(current_setting('app.allow_down_data_loss', true), '') <> 'on'
     and exists (select 1 from information_schema.columns where table_schema = 'public'
                  and table_name = 'user_settings' and column_name = 'mascot')
     and exists (select 1 from public.user_settings where mascot is distinct from 'sprout') then
    raise exception 'user_settings_mascot down: accounts have chosen a mascot; set app.allow_down_data_loss = on to drop it'
      using errcode = '55000';
  end if;
end $$;

do $migration$
declare
  definition text;
  pairs text[][] := array[
    [$a$cuisines, country_code, mascot, rev)$a$, $a$cuisines, country_code, rev)$a$],
    [$a$p_payload->>'country_code', coalesce(p_payload->>'mascot', 'sprout'), p_rev)$a$,
     $a$p_payload->>'country_code', p_rev)$a$],
    [$a$else user_settings.country_code end,
      mascot = coalesce(p_payload->>'mascot', user_settings.mascot),$a$,
     $a$else user_settings.country_code end,$a$]];
  i integer;
begin
  select pg_get_functiondef('public._sync_upsert(uuid,text,text,jsonb,integer)'::regprocedure)
    into definition;
  if position('mascot' in definition) = 0 then return; end if;
  for i in 1 .. array_length(pairs, 1) loop
    definition := replace(definition, pairs[i][1], pairs[i][2]);
  end loop;
  execute definition;
end;
$migration$;
revoke execute on function public._sync_upsert(uuid, text, text, jsonb, integer)
  from public, anon, authenticated;
grant execute on function public._sync_upsert(uuid, text, text, jsonb, integer) to service_role;

alter table public.user_settings drop constraint if exists user_settings_mascot_check;
alter table public.user_settings drop column if exists mascot;
