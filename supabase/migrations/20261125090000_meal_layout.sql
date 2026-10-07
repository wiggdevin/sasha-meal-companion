-- Every account can choose 2-6 meals. Null means derive the count from its own target revision.
-- Existing account choices and plan rows are retained. No personal default is backfilled.
set local lock_timeout = '5s';

alter table public.user_settings add column meals_per_day smallint
  constraint user_settings_meals_per_day_check check (meals_per_day between 2 and 6);

-- The sync RPC is installed by earlier migrations. Patch only its user_settings branch so omitted
-- keys retain their value and an explicit null returns the account to a derived count.
do $migration$
declare
  definition text;
  anchors text[] := array[
    'body_fat_measured_on, goal_rate_bp_week, rev)',
    '(p_payload->>''goal_rate_bp_week'')::integer, p_rev)',
    'else user_settings.goal_rate_bp_week end,'];
  replacements text[] := array[
    'body_fat_measured_on, goal_rate_bp_week, meals_per_day, rev)',
    '(p_payload->>''goal_rate_bp_week'')::integer,
            (p_payload->>''meals_per_day'')::smallint, p_rev)',
    'else user_settings.goal_rate_bp_week end,
      meals_per_day = case when p_payload ? ''meals_per_day''
        then (p_payload->>''meals_per_day'')::smallint
        else user_settings.meals_per_day end,'];
  i integer;
begin
  select pg_get_functiondef('public._sync_upsert(uuid,text,text,jsonb,integer)'::regprocedure)
    into definition;
  if position(replacements[1] in definition) > 0 then return; end if;
  for i in 1 .. array_length(anchors, 1) loop
    if (length(definition) - length(replace(definition, anchors[i], '')))
       / length(anchors[i]) <> 1 then
      raise exception 'meal_layout (_sync_upsert): anchor % does not occur exactly once', i;
    end if;
    definition := replace(definition, anchors[i], replacements[i]);
  end loop;
  execute definition;
end;
$migration$;
revoke execute on function public._sync_upsert(uuid, text, text, jsonb, integer)
  from public, anon, authenticated;
grant execute on function public._sync_upsert(uuid, text, text, jsonb, integer)
  to service_role;

-- Widen only the slot keys; retain all other validation, including timestamp and mark shape.
create or replace function public.plan_day_eaten_slots_valid(value jsonb) returns boolean
  language sql immutable set search_path = public as $$
    select jsonb_typeof(value) = 'object'
      and not exists (
        select 1 from jsonb_each(value) as slot(id, mark)
        where id not in (
          'coffee', 'pouches-pre', 'post-refuel', 'meal-1', 'meal-2', 'meal-3',
          'meal-4', 'meal-5', 'meal-6', 'hot-chocolate'
        )
          or jsonb_typeof(mark) <> 'object'
          or not mark ? 'eaten_at'
          or not mark ? 'changed_at'
          or exists (select 1 from jsonb_object_keys(mark) key
                     where key not in ('eaten_at', 'changed_at'))
          or jsonb_typeof(mark->'changed_at') <> 'string'
          or jsonb_typeof(mark->'eaten_at') not in ('string', 'null')
          or not ((mark->>'changed_at') ~
            '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$')
          or (mark->>'eaten_at' is not null and not ((mark->>'eaten_at') ~
            '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$'))
      );
  $$;
