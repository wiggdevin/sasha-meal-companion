-- Reverse of 20261217090200_profile_sync_cuisines_country.sql: the sync RPC forgets cuisines and
-- country_code again (an omitted key then keeps them; nothing is dropped) and the diet_prefs taste
-- carry-forward. Runs alone; a no-op when the patch is not installed; raises on a partly patched
-- function.
-- Rollback order: revert the app deploy, then this file, 20261217090100's down, 20261217090000's down.
do $migration$
declare
  definition text;
  -- `froms[i]` is replaced by `tos[i]`; every `froms[i]` must occur exactly once before anything
  -- is replaced.
  froms text[] := array[
    $a$body_fat_measured_on, goal_rate_bp_week, meals_per_day, cuisines, country_code, rev)$a$,
    $a$(p_payload->>'meals_per_day')::smallint,
            array(select c.value from jsonb_array_elements_text(p_payload->'cuisines')
                    with ordinality as c(value, n) order by c.n),
            p_payload->>'country_code', p_rev)$a$,
    $a$else user_settings.meals_per_day end,
      cuisines = case when p_payload ? 'cuisines'
        then array(select c.value from jsonb_array_elements_text(p_payload->'cuisines')
                     with ordinality as c(value, n) order by c.n)
        else user_settings.cuisines end,
      country_code = case when p_payload ? 'country_code'
        then p_payload->>'country_code'
        else user_settings.country_code end,$a$,
    $a$raise exception 'water_goal_null: water_goal_cups_rest' using errcode = '22023';
    end if;
    -- Phase 18 W5: cuisines is NOT NULL; [] clears it, a JSON null is refused.
    if p_payload ? 'cuisines' and jsonb_typeof(p_payload->'cuisines') = 'null' then
      raise exception 'cuisines_null: send [] to clear cuisines' using errcode = '22023';$a$,
    $a$      -- Phase 18 W5: a diet_prefs object without a `taste` key (a pre-W5 client rebuilds the
      -- object from the keys it knows) keeps the stored taste; an explicit `taste` key, even an
      -- empty one, replaces it, and a JSON null still clears the whole object.
      diet_prefs = case when p_payload ? 'diet_prefs'
        then case when p_payload->>'diet_prefs' is null then null
          when jsonb_typeof(p_payload->'diet_prefs') = 'object'
            and not (p_payload->'diet_prefs' ? 'taste')
            and jsonb_typeof(user_settings.diet_prefs) = 'object'
            and user_settings.diet_prefs ? 'taste'
          then p_payload->'diet_prefs'
            || jsonb_build_object('taste', user_settings.diet_prefs->'taste')
          else p_payload->'diet_prefs' end
        else user_settings.diet_prefs end,$a$];
  tos text[] := array[
    $a$body_fat_measured_on, goal_rate_bp_week, meals_per_day, rev)$a$,
    $a$(p_payload->>'meals_per_day')::smallint, p_rev)$a$,
    $a$else user_settings.meals_per_day end,$a$,
    $a$raise exception 'water_goal_null: water_goal_cups_rest' using errcode = '22023';$a$,
    $a$      diet_prefs = case when p_payload ? 'diet_prefs'
        then case when p_payload->>'diet_prefs' is null then null
          else p_payload->'diet_prefs' end
        else user_settings.diet_prefs end,$a$];
  done_count integer := 0;
  i integer;
  occurrences integer;
begin
  select pg_get_functiondef('public._sync_upsert(uuid,text,text,jsonb,integer)'::regprocedure)
    into definition;
  -- The state is read from the patched texts only (a patched text may contain its anchor). None
  -- present: the patch is not installed, a no-op. Some but not all: a partly patched function,
  -- which raises.
  for i in 1 .. array_length(froms, 1) loop
    if (length(definition) - length(replace(definition, froms[i], ''))) / length(froms[i]) = 1 then
      done_count := done_count + 1;
    end if;
  end loop;
  if done_count = 0 then return; end if;
  if done_count < array_length(froms, 1) then
    raise exception 'profile_sync_cuisines_country down (_sync_upsert): only % of % parts patched; refusing a partial function',
      done_count, array_length(froms, 1);
  end if;
  for i in 1 .. array_length(froms, 1) loop
    occurrences := (length(definition) - length(replace(definition, froms[i], ''))) / length(froms[i]);
    if occurrences <> 1 then
      raise exception 'profile_sync_cuisines_country down (_sync_upsert): anchor % occurs % times, expected once', i, occurrences;
    end if;
  end loop;
  for i in 1 .. array_length(froms, 1) loop
    definition := replace(definition, froms[i], tos[i]);
  end loop;
  execute definition;
end;
$migration$;
revoke execute on function public._sync_upsert(uuid, text, text, jsonb, integer)
  from public, anon, authenticated;
grant execute on function public._sync_upsert(uuid, text, text, jsonb, integer)
  to service_role;
