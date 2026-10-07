-- Reverse of 20261026090100_neutral_user_defaults.sql: schema and functions only, never data.
--
-- The constraint_profiles backfill is NOT undone. It moved a restriction that used to be enforced
-- from code into the row that was already relying on it; deleting those keys on a rollback would
-- drop a real restriction from a real account, which is the one outcome the forward migration
-- exists to prevent. The application it rolls back to injects the same keys in memory anyway, so
-- leaving them stored changes nothing for that build.

-- ---------- 1. user_settings.time_zone leaves the sync contract -----------------------------
--
-- Replace only the user_settings branch of the installed definition, so the plan_days branch from
-- 20261026090000 is carried forward untouched. After this the RPC ignores a queued time_zone
-- again: the column and its IANA trigger stay, they simply stop being written through sync.
do $migration$
declare
  definition text;
  replaced text;
begin
  select pg_get_functiondef(
    'public._sync_upsert(uuid,text,text,jsonb,integer)'::regprocedure
  ) into definition;
  if position('time_zone' in definition) = 0 then
    return;
  end if;
  replaced := regexp_replace(
    definition,
    $pattern$  elsif p_entity = 'user_settings' then.*?  elsif p_entity = 'gut_log' then$pattern$,
    $branch$  elsif p_entity = 'user_settings' then
    if p_payload ? 'water_goal_cups_training'
       and p_payload->>'water_goal_cups_training' is null then
      raise exception 'water_goal_null: water_goal_cups_training' using errcode = '22023';
    end if;
    if p_payload ? 'water_goal_cups_rest'
       and p_payload->>'water_goal_cups_rest' is null then
      raise exception 'water_goal_null: water_goal_cups_rest' using errcode = '22023';
    end if;
    insert into user_settings (user_id, first_opened_at, scale_warning_dismissed, training_kcal,
                               rest_kcal, protein_g, protein_locked, ramp_override, slot_times,
                               shift_minutes, changed_at, water_goal_cups,
                               water_goal_cups_training, water_goal_cups_rest, height_cm, birth_year,
                               sex, body_fat_pct, weight_kg, activity_level, goal,
                               training_weekdays, diet_prefs, onboarded_at,
                               height_unit, weight_unit, rev)
    values (p_user_id, coalesce((p_payload->>'first_opened_at')::timestamptz, now()),
            coalesce((p_payload->>'scale_warning_dismissed')::boolean, false),
            (p_payload->>'training_kcal')::integer, (p_payload->>'rest_kcal')::integer,
            (p_payload->>'protein_g')::numeric,
            coalesce((p_payload->>'protein_locked')::boolean, true),
            (p_payload->>'ramp_override')::smallint,
            coalesce(p_payload->'slot_times', '{}'::jsonb),
            coalesce((p_payload->>'shift_minutes')::integer, 0),
            (p_payload->>'changed_at')::timestamptz,
            coalesce((p_payload->>'water_goal_cups')::integer, 8),
            coalesce((p_payload->>'water_goal_cups_training')::integer,
                     (p_payload->>'water_goal_cups')::integer, 8),
            coalesce((p_payload->>'water_goal_cups_rest')::integer,
                     (p_payload->>'water_goal_cups')::integer, 8),
            (p_payload->>'height_cm')::numeric, (p_payload->>'birth_year')::integer,
            p_payload->>'sex', (p_payload->>'body_fat_pct')::numeric,
            (p_payload->>'weight_kg')::numeric, p_payload->>'activity_level', p_payload->>'goal',
            case when p_payload->>'training_weekdays' is null then null
              else array(select value::smallint
                from jsonb_array_elements_text(p_payload->'training_weekdays')) end,
            case when p_payload->>'diet_prefs' is null then null
              else p_payload->'diet_prefs' end,
            (p_payload->>'onboarded_at')::timestamptz,
            p_payload->>'height_unit', p_payload->>'weight_unit', p_rev)
    on conflict (user_id) do update set first_opened_at = excluded.first_opened_at,
      scale_warning_dismissed = excluded.scale_warning_dismissed,
      training_kcal = excluded.training_kcal, rest_kcal = excluded.rest_kcal,
      protein_g = excluded.protein_g, protein_locked = excluded.protein_locked,
      ramp_override = excluded.ramp_override, slot_times = excluded.slot_times,
      shift_minutes = excluded.shift_minutes, changed_at = excluded.changed_at,
      water_goal_cups = excluded.water_goal_cups,
      water_goal_cups_training = case when p_payload ? 'water_goal_cups_training'
        then (p_payload->>'water_goal_cups_training')::integer
        else user_settings.water_goal_cups_training end,
      water_goal_cups_rest = case when p_payload ? 'water_goal_cups_rest'
        then (p_payload->>'water_goal_cups_rest')::integer
        else user_settings.water_goal_cups_rest end,
      height_cm = case when p_payload ? 'height_cm'
        then (p_payload->>'height_cm')::numeric
        else user_settings.height_cm end,
      birth_year = case when p_payload ? 'birth_year'
        then (p_payload->>'birth_year')::integer
        else user_settings.birth_year end,
      sex = case when p_payload ? 'sex'
        then p_payload->>'sex'
        else user_settings.sex end,
      body_fat_pct = case when p_payload ? 'body_fat_pct'
        then (p_payload->>'body_fat_pct')::numeric
        else user_settings.body_fat_pct end,
      weight_kg = case when p_payload ? 'weight_kg'
        then (p_payload->>'weight_kg')::numeric
        else user_settings.weight_kg end,
      activity_level = case when p_payload ? 'activity_level'
        then p_payload->>'activity_level'
        else user_settings.activity_level end,
      goal = case when p_payload ? 'goal'
        then p_payload->>'goal'
        else user_settings.goal end,
      training_weekdays = case when p_payload ? 'training_weekdays'
        then case when p_payload->>'training_weekdays' is null then null
          else array(select value::smallint
            from jsonb_array_elements_text(p_payload->'training_weekdays')) end
        else user_settings.training_weekdays end,
      diet_prefs = case when p_payload ? 'diet_prefs'
        then case when p_payload->>'diet_prefs' is null then null
          else p_payload->'diet_prefs' end
        else user_settings.diet_prefs end,
      onboarded_at = case when p_payload ? 'onboarded_at'
        then (p_payload->>'onboarded_at')::timestamptz
        else user_settings.onboarded_at end,
      height_unit = case when p_payload ? 'height_unit'
        then p_payload->>'height_unit'
        else user_settings.height_unit end,
      weight_unit = case when p_payload ? 'weight_unit'
        then p_payload->>'weight_unit'
        else user_settings.weight_unit end,
      rev = excluded.rev;
  elsif p_entity = 'gut_log' then$branch$,
    'is'
  );
  if replaced = definition then
    raise exception 'Could not restore _sync_upsert user_settings branch';
  end if;
  execute replaced;
end;
$migration$;
revoke execute on function _sync_upsert(uuid, text, text, jsonb, integer) from public, anon;

-- ---------- 2. The column defaults the build being rolled back to expects -------------------
alter table constraint_profiles
  alter column avoid_allergens set default '{gluten,dairy,apple}',
  alter column banned_categories
    set default '{raw_cruciferous,raw_leafy_greens,onion_garlic,beans,simple_sugars}';
