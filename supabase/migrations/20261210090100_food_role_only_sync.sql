-- A confirmed meal role is a partial user_food_prefs sync update. The ordinary upsert expects
-- a full preference and would clear status, no_cook, and note when they are omitted.
-- Keep the installed function's other entity branches intact.
do $migration$
declare
  definition text;
  anchor text := 'elsif p_entity = ''user_food_prefs'' then';
  replacement text :=
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
  if position('food_role_conflict' in definition) > 0 then return; end if;
  if (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 then
    raise exception 'food_role_only_sync: expected one user_food_prefs branch';
  end if;
  execute replace(definition, anchor, replacement);
end;
$migration$;
revoke execute on function public._sync_upsert(uuid, text, text, jsonb, integer)
  from public, anon, authenticated;
grant execute on function public._sync_upsert(uuid, text, text, jsonb, integer) to service_role;
