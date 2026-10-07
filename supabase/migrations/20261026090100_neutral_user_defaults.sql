-- Neutral defaults for a new account, and the account's own time zone.
--
-- Three changes, in this order, and the order matters:
--
--   1. Carry the code floor into every EXISTING constraint_profiles row. lib/policy/constraints.ts
--      used to inject gluten, dairy, apple and five banned categories in memory for any account
--      whose row did not name them (its DEFAULT_PROFILE, :20-35). The application drops that
--      constant in this release, so a restriction that was only ever enforced from code has to
--      become a row first, or an account silently loses it (driver amendment A3).
--   2. Only then make the column defaults neutral, so a row created from here on starts empty.
--   3. Teach _sync_upsert about user_settings.time_zone, so the zone a device captures on first
--      open actually lands (D1 §6.4). The column and its IANA trigger already exist
--      (20261024093000_health_time_zones.sql); the RPC simply never carried it, so every queued
--      zone was dropped on the floor.
--
-- Runs after 20261026090000_plan_days_eaten_slots.sql and depends on it: step 3 rewrites only the
-- user_settings branch of whatever _sync_upsert is installed, so that migration's plan_days branch
-- — the eaten_slots validation and its omit/keep, present-null/clear cases — is carried forward
-- byte for byte rather than retyped.
--
-- user_settings.ramp_override stays where it is, nullable and unread. Nothing writes it once the
-- authored ramp is gone; its physical drop is post-READY schema housekeeping, not this release.

-- ---------- 1. Preserve what the code floor was enforcing ---------------------------------
--
-- Merge, never replace: array_agg(distinct) keeps whatever else the row already names, adds only
-- the missing keys, and leaves conditions, notes and avoid_food_ref_ids untouched. Re-running
-- changes nothing, because the WHERE clause stops matching once both sets are contained.
--
-- rev IS bumped for a row this actually changes, and that is deliberate. rev is the
-- compare-and-swap arbiter for PUT /api/constraints (lib/server/constraints.ts): a tab that
-- loaded the profile before this migration still holds the shorter arrays at the older rev, and
-- saving a condition from it afterwards would write them back and undo the merge. The bump makes
-- that save answer conflict instead, which components/AvoidRules.tsx already renders.
update constraint_profiles
   set avoid_allergens = (
         select coalesce(array_agg(distinct key order by key), '{}'::text[])
           from unnest(avoid_allergens || '{gluten,dairy,apple}'::text[]) as key),
       banned_categories = (
         select coalesce(array_agg(distinct key order by key), '{}'::text[])
           from unnest(banned_categories
                       || '{raw_cruciferous,raw_leafy_greens,onion_garlic,beans,simple_sugars}'::text[])
                as key),
       rev = rev + 1,
       updated_at = now()
 where not (avoid_allergens @> '{gluten,dairy,apple}'::text[]
            and banned_categories
                @> '{raw_cruciferous,raw_leafy_greens,onion_garlic,beans,simple_sugars}'::text[]);

-- ---------- 2. A new row restricts nothing -------------------------------------------------
--
-- PRD R2: no person's rules live in shared defaults. Onboarding always PUTs the row now, so a
-- finished account owns an explicit empty row rather than inheriting one.
alter table constraint_profiles
  alter column avoid_allergens set default '{}'::text[],
  alter column banned_categories set default '{}'::text[];

-- ---------- 3. user_settings.time_zone joins the sync contract ------------------------------
--
-- Replace ONLY the user_settings branch of the installed definition. Keeping the rest byte for
-- byte is what preserves the preceding migration's plan_days branch and avoids restating a large
-- cross-entity function in every additive migration.
--
-- time_zone takes the same contract every other nullable user_settings column has: an omitted key
-- keeps the stored value, a present JSON null clears it, and an insert with the key omitted
-- stores null. The IANA trigger installed by 20261024093000 still rejects a zone that is not a
-- pg_timezone_names entry with 22023 invalid_time_zone.
do $migration$
declare
  definition text;
  replaced text;
begin
  select pg_get_functiondef(
    'public._sync_upsert(uuid,text,text,jsonb,integer)'::regprocedure
  ) into definition;
  if position('time_zone' in definition) > 0 then
    return;
  end if;
  replaced := regexp_replace(
    definition,
    $pattern$  elsif p_entity = 'user_settings' then.*?  elsif p_entity = 'gut_log' then$pattern$,
    $branch$  elsif p_entity = 'user_settings' then
    -- The omit/null contract every user_settings column follows: an omitted key keeps the stored
    -- value; a present JSON null clears it (nullable columns) or refuses it (not-null columns).
    -- An explicit null on either water goal raises 22023 water_goal_null, because a stale phone
    -- must not silently reset a goal to its default.
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
                               height_unit, weight_unit, time_zone, rev)
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
            p_payload->>'height_unit', p_payload->>'weight_unit',
            p_payload->>'time_zone', p_rev)
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
      time_zone = case when p_payload ? 'time_zone'
        then p_payload->>'time_zone'
        else user_settings.time_zone end,
      rev = excluded.rev;
  elsif p_entity = 'gut_log' then$branch$,
    'is'
  );
  if replaced = definition then
    raise exception 'Could not replace _sync_upsert user_settings branch';
  end if;
  execute replaced;
end;
$migration$;
revoke execute on function _sync_upsert(uuid, text, text, jsonb, integer) from public, anon;
