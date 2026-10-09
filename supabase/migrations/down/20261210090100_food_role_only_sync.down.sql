-- Rollback of 20261210090100_food_role_only_sync.
--
-- Removes the inserted role-only user_food_prefs branch from _sync_upsert, restoring the prior
-- body in which every user_food_prefs sync update goes through the ordinary full-preference
-- upsert branch. Keeps the installed function's other entity branches intact, exactly as the up
-- migration promised to.
do $migration$
declare
  definition text;
  anchor text := 'elsif p_entity = ''user_food_prefs'' then';
  installed text :=
    'elsif p_entity = ''user_food_prefs''
      and p_payload = jsonb_build_object(''role'', p_payload->''role'')
      and p_payload->>''role'' in (''protein'', ''carb'', ''fat'') then
    update user_food_prefs set role = p_payload->>''role'', rev = p_rev, updated_at = now()
      where user_id = p_user_id and food_ref_id = p_key::uuid and rev = p_rev - 1;
    if not found then
      raise exception ''food_role_conflict'' using errcode = ''P0001'';
    end if;
  elsif p_entity = ''user_food_prefs'' then';
begin
  select pg_get_functiondef('public._sync_upsert(uuid,text,text,jsonb,integer)'::regprocedure)
    into definition;
  if position('food_role_conflict' in definition) = 0 then return; end if;
  if (length(definition) - length(replace(definition, installed, ''))) / length(installed) <> 1 then
    raise exception 'food_role_only_sync_down: expected exactly one installed branch';
  end if;
  execute replace(definition, installed, anchor);
end;
$migration$;
revoke execute on function public._sync_upsert(uuid, text, text, jsonb, integer)
  from public, anon, authenticated;
grant execute on function public._sync_upsert(uuid, text, text, jsonb, integer) to service_role;
