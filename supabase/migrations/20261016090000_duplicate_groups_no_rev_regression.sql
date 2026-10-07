-- Loop 010, 2026-09-14. Follow-up to 20261014090001.
--
-- That migration stopped two devices colliding on duplicate_groups_user_id_fingerprint_key by
-- making (user_id, fingerprint) the arbiter. It converged, but its ON CONFLICT clause overwrote
-- the existing row unconditionally, so the second device's create — which always carries
-- state 'open', no merged_into_entry_id and rev 1 — walked backwards over a group the first
-- device had already decided.
--
-- Measured against the running app through POST /api/sync/ops:
--   create  GA fingerprint FP state open      -> applied rev 1
--   update  GA state merged                   -> applied rev 2   (db: merged, rev 2)
--   create  GB SAME fingerprint FP state open -> applied rev 1
--   db afterwards: GA is 'open' at rev 1, merged_into_entry_id NULL, and no GB row exists.
-- A decided merge was silently undone and the revision regressed, while the client was told
-- 'applied'. A rev going backwards also breaks the base_rev CAS every later update depends on.
--
-- The arbiter stays (user_id, fingerprint); the write now only lands when it moves the row
-- forward. A genuine update-by-id carries the same fingerprint and a higher rev, so it still
-- applies exactly as before. A second device's create is older by definition, so it converges
-- onto the decided row and leaves it alone — which is what convergence was supposed to mean.

-- Finding #96 (docs/audit/2026-09-13, branch fix-duplicate-groups-upsert-race): the
-- duplicate_groups branch of _sync_upsert only guarded the id primary key, not the
-- (user_id, fingerprint) unique constraint two devices independently creating the same
-- duplicate-group can race. _sync_upsert is replaced whole, as every prior migration touching
-- it does; only the duplicate_groups branch's ON CONFLICT arbiter changes.

create or replace function _sync_upsert(p_user_id uuid, p_entity text, p_key text,
                                        p_payload jsonb, p_rev integer) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  v_prior       jsonb   := '{}'::jsonb;
  v_force       boolean := coalesce((p_payload->>'recompute_snapshots')::boolean, false);
  v_revision_id uuid;
  v_items       integer;
  v_servings    numeric;
  v_total_grams numeric;
  v_per_serving jsonb;
  v_coverage    numeric;
  v_per_100g    jsonb;
begin
  perform _sync_assert_key(p_entity, p_key);
  if p_entity = 'user_foods' then
    insert into user_foods (id, user_id, name, brand, ingredients_text, catalog_food_id, kind,
                            per_100g, allergen_tags, rev, deleted_at)
    values (p_key::uuid, p_user_id, p_payload->>'name', p_payload->>'brand',
            p_payload->>'ingredients_text', (p_payload->>'catalog_food_id')::bigint,
            coalesce(p_payload->>'kind', 'custom'),
            coalesce(p_payload->'per_100g', '{}'::jsonb),
            coalesce(array(select jsonb_array_elements_text(p_payload->'allergen_tags')), '{}'::text[]),
            p_rev, null)
    on conflict (id) do update set name = excluded.name, brand = excluded.brand,
      ingredients_text = excluded.ingredients_text, catalog_food_id = excluded.catalog_food_id,
      kind = excluded.kind, per_100g = excluded.per_100g, allergen_tags = excluded.allergen_tags,
      rev = excluded.rev
      where user_foods.user_id = p_user_id;
  elsif p_entity = 'user_food_prefs' then
    insert into user_food_prefs (user_id, food_ref_id, status, role, no_cook, note, rev, updated_at)
    values (p_user_id, p_key::uuid, p_payload->>'status', p_payload->>'role',
            coalesce((p_payload->>'no_cook')::boolean, false), p_payload->>'note', p_rev, now())
    on conflict (user_id, food_ref_id) do update set status = excluded.status,
      role = excluded.role, no_cook = excluded.no_cook, note = excluded.note,
      rev = excluded.rev, updated_at = now();
  elsif p_entity = 'log_entries' then
    insert into log_entries (id, user_id, note, media_ref, eaten_at, tz, local_date, slot, method,
                             rev, deleted_at)
    values (p_key::uuid, p_user_id, p_payload->>'note', p_payload->>'media_ref',
            (p_payload->>'eaten_at')::timestamptz, p_payload->>'tz',
            (p_payload->>'local_date')::date, p_payload->>'slot', p_payload->>'method', p_rev, null)
    on conflict (id) do update set note = excluded.note, media_ref = excluded.media_ref,
      eaten_at = excluded.eaten_at, tz = excluded.tz, local_date = excluded.local_date,
      slot = excluded.slot, method = excluded.method, rev = excluded.rev
      where log_entries.user_id = p_user_id;
    -- log_items are only touched when p_key resolves to a row p_user_id actually owns — otherwise
    -- the conflicting entry belongs to someone else (the update above was a no-op) and this must
    -- not delete or insert their items.
    if exists (select 1 from log_entries e where e.id = p_key::uuid and e.user_id = p_user_id) then
      -- Phase 2: remember what was there before the wholesale replace, so an untouched item keeps
      -- the snapshot it was logged with.
      select coalesce(jsonb_object_agg(id::text, jsonb_build_object(
               'grams', grams, 'food_ref_id', food_ref_id, 'snapshot', snapshot)), '{}'::jsonb)
        into v_prior from log_items where entry_id = p_key::uuid;

      delete from log_items where entry_id = p_key::uuid;
      insert into log_items (id, entry_id, seq, qty, unit, food_ref_id, grams, snapshot,
                             food_revision_id, portion_id, was_edited, confidence)
      select coalesce(i.id, gen_random_uuid()), p_key::uuid, i.seq, i.qty, i.unit, i.food_ref_id,
             i.grams,
             case when not v_force
                   and i.id is not null
                   and v_prior ? i.id::text
                   and (v_prior->(i.id::text)->>'grams')::numeric = i.grams
                   and (v_prior->(i.id::text)->>'food_ref_id')::uuid = i.food_ref_id
                   and coalesce(v_prior->(i.id::text)->'snapshot', '{}'::jsonb) <> '{}'::jsonb
                  then v_prior->(i.id::text)->'snapshot'
                  else compute_item_snapshot(i.food_ref_id, i.grams) end,
             i.food_revision_id, i.portion_id,
             coalesce(i.was_edited, false), i.confidence
        from jsonb_to_recordset(coalesce(p_payload->'items', '[]'::jsonb))
             as i(id uuid, seq integer, qty numeric, unit text, food_ref_id uuid, grams numeric,
                  snapshot jsonb, food_revision_id bigint, portion_id bigint,
                  was_edited boolean, confidence numeric);
    end if;
  elsif p_entity = 'water_log' then
    insert into water_log (user_id, local_date, cups, rev)
    values (p_user_id, p_key::date, coalesce((p_payload->>'cups')::integer, 0), p_rev)
    -- Phase 3, contracts §3: server-side max. Phase 0 wrote excluded.cups, which let a stale
    -- device un-drink a cup; the client merge already took the max, and now the server agrees.
    on conflict (user_id, local_date) do update
      set cups = greatest(water_log.cups, excluded.cups), rev = excluded.rev;
  elsif p_entity = 'plan_days' then
    insert into plan_days (user_id, local_date, day_type_override, floor_day, swaps, slot_notes,
                           rev, updated_at)
    values (p_user_id, p_key::date, p_payload->>'day_type_override',
            coalesce((p_payload->>'floor_day')::boolean, false),
            coalesce(p_payload->'swaps', '{}'::jsonb),
            coalesce(p_payload->'slot_notes', '{}'::jsonb), p_rev, now())
    on conflict (user_id, local_date) do update set day_type_override = excluded.day_type_override,
      floor_day = excluded.floor_day, swaps = excluded.swaps, slot_notes = excluded.slot_notes,
      rev = excluded.rev, updated_at = now();
  elsif p_entity = 'user_settings' then
    -- T6: both per-day-type goals join the column list, and this branch states the omit/null
    -- contract every later user_settings column copies (T11b adds four nullable ones):
    --   omitted key = keep the stored value; present JSON null = clear it (nullable columns) or
    --   refuse it (not-null columns). An explicit null on either goal raises 22023
    --   `water_goal_null` — a stale phone must not silently reset a goal to its default.
    -- There is no stored value to keep on the insert side, so the goals still fall back to the
    -- legacy water_goal_cups (or 8), and water_goal_cups itself keeps its Phase 3 coalesce-to-8.
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
                               sex, body_fat_pct, rev)
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
            p_payload->>'sex', (p_payload->>'body_fat_pct')::numeric, p_rev)
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
        else user_settings.body_fat_pct end, rev = excluded.rev;
  elsif p_entity = 'gut_log' then
    insert into gut_log (id, user_id, local_date, tz, state, note, rev, deleted_at)
    values (p_key::uuid, p_user_id, (p_payload->>'local_date')::date, p_payload->>'tz',
            p_payload->>'state', p_payload->>'note', p_rev, null)
    on conflict (id) do update set local_date = excluded.local_date, tz = excluded.tz,
      state = excluded.state, note = excluded.note, rev = excluded.rev
      where gut_log.user_id = p_user_id;
  elsif p_entity = 'duplicate_groups' then
    -- Finding #96: two devices independently detecting the same real-world duplicate compute the
    -- identical fingerprint (lib/sync/fingerprint.ts is a pure function of date/slot/time-bucket/
    -- items) but each mints its own random id for the create op. The arbiter here is
    -- (user_id, fingerprint), not (id): a genuine update-by-id always carries the same fingerprint
    -- as the row it is updating, so it still resolves to the same row under this arbiter, and a
    -- second device's create now converges onto the first device's row instead of raising a raw
    -- unique_violation on duplicate_groups_user_id_fingerprint_key.
    insert into duplicate_groups (id, user_id, local_date, fingerprint, slot, state,
                                  merged_into_entry_id, decided_at, rev)
    values (p_key::uuid, p_user_id, (p_payload->>'local_date')::date,
            decode(p_payload->>'fingerprint', 'hex'), p_payload->>'slot',
            coalesce(p_payload->>'state', 'open'),
            (p_payload->>'merged_into_entry_id')::uuid,
            (p_payload->>'decided_at')::timestamptz, p_rev)
    on conflict (user_id, fingerprint) do update set local_date = excluded.local_date,
      slot = excluded.slot, state = excluded.state,
      merged_into_entry_id = excluded.merged_into_entry_id, decided_at = excluded.decided_at,
      rev = excluded.rev
      where duplicate_groups.rev < excluded.rev;

  -- ---------- Phase 3 entities ---------------------------------------------------------
  elsif p_entity = 'recipes' then
    insert into recipes (id, user_id, name, servings, yield_grams, rev, updated_at, deleted_at)
    values (p_key::uuid, p_user_id, p_payload->>'name',
            coalesce((p_payload->>'servings')::numeric, 1),
            (p_payload->>'yield_grams')::numeric, p_rev, now(), null)
    on conflict (id) do update set name = excluded.name, servings = excluded.servings,
      yield_grams = excluded.yield_grams, rev = excluded.rev, updated_at = now()
      where recipes.user_id = p_user_id;

    if exists (select 1 from recipes r where r.id = p_key::uuid and r.user_id = p_user_id) then
      -- Every applied create or update writes a NEW revision at the recipe's new rev. The old
      -- revision row and every log_items snapshot taken from it are never touched (AC 7).
      insert into recipe_revisions (recipe_id, rev, nutrients_per_serving)
      values (p_key::uuid, p_rev, '{}'::jsonb)
      returning id into v_revision_id;

      insert into recipe_items (recipe_revision_id, seq, qty, unit, food_ref_id, grams,
                                food_revision_id, state)
      select v_revision_id, i.seq, i.qty, i.unit, i.food_ref_id, i.grams, i.food_revision_id,
             coalesce(i.state, 'raw')
        from jsonb_to_recordset(coalesce(p_payload->'items', '[]'::jsonb))
             as i(seq integer, qty numeric, unit text, food_ref_id uuid, grams numeric,
                  food_revision_id bigint, state text);

      select count(*), coalesce(sum(grams), 0) into v_items, v_total_grams
        from recipe_items where recipe_revision_id = v_revision_id;
      select servings, coalesce(yield_grams, v_total_grams) into v_servings, v_total_grams
        from recipes where id = p_key::uuid;

      -- Per nutrient: sum the items that measured it, ignore the ones that did not. A code is
      -- null only when NO item measured it — never 0 (architecture §3.3). Per-code coverage is
      -- measured items ÷ all items, and the scalar stored as nutrients_per_serving.coverage is
      -- the MINIMUM of that ratio across the five tracked macros, so one unmeasured item makes
      -- the recipe read as incomplete (AC 8). lib/recipes/nutrients.ts computes the same thing.
      with per_item as (
        select compute_item_snapshot(i.food_ref_id, i.grams) as snap
          from recipe_items i where i.recipe_revision_id = v_revision_id),
      vals as (
        select kv.key as code, (kv.value->>'amount')::numeric as amount
          from per_item cross join lateral jsonb_each(per_item.snap) kv),
      per_code as (
        select code, count(*) filter (where amount is not null) as measured,
               sum(amount) as total                         -- sum() already ignores nulls
          from vals group by code),
      macros as (
        select coalesce(pc.measured, 0) as measured
          from unnest(array['energy_kcal','protein','carbohydrate','fat_total','fiber_total'])
               as m(code)
          left join per_code pc on pc.code = m.code)
      select
        coalesce((select jsonb_object_agg(code, case when measured = 0 then null
                          else to_jsonb(round(total / v_servings, 4)) end) from per_code),
                 '{}'::jsonb),
        coalesce((select min(measured::numeric / nullif(v_items, 0)) from macros), 0)
        into v_per_serving, v_coverage;

      update recipe_revisions
         set nutrients_per_serving = v_per_serving || jsonb_build_object('coverage', v_coverage)
       where id = v_revision_id;

      -- The loggable twin. per_100g is the whole-recipe total × 100 ÷ the recipe's finished
      -- weight (yield_grams when she weighed it, else the input grams) — the same denominator
      -- servingGrams uses, so logging `servingGrams × servings eaten` reproduces the per-serving
      -- numbers exactly and a recipe travels the unchanged Phase 2 commit path.
      select coalesce(jsonb_object_agg(key, case when value = 'null'::jsonb then null
               else to_jsonb(round((value#>>'{}')::numeric * v_servings * 100
                                   / nullif(v_total_grams, 0), 4)) end), '{}'::jsonb)
        into v_per_100g from jsonb_each(v_per_serving);

      insert into user_foods (id, user_id, name, kind, per_100g, rev, deleted_at)
      values (p_key::uuid, p_user_id, p_payload->>'name', 'recipe', v_per_100g, p_rev, null)
      on conflict (id) do update set name = excluded.name, kind = 'recipe',
        per_100g = excluded.per_100g, rev = excluded.rev
        where user_foods.user_id = p_user_id;

      if exists (select 1 from user_foods f where f.id = p_key::uuid and f.user_id = p_user_id) then
        perform get_or_create_food_ref(p_user_id, 'user', null, p_key::uuid);
      end if;
    end if;
  elsif p_entity = 'favorites_foods' then
    -- created_at is intentionally absent from the on-conflict SET list: a re-sort touches only
    -- sort/rev/updated_at, so the row's real "date added" survives every later write.
    insert into favorites_foods (user_id, food_ref_id, sort, rev, created_at, updated_at, deleted_at)
    values (p_user_id, p_key::uuid, coalesce((p_payload->>'sort')::integer, 0), p_rev, now(), now(), null)
    on conflict (user_id, food_ref_id) do update set sort = excluded.sort,
      rev = excluded.rev, updated_at = now();
  elsif p_entity = 'favorites_recipes' then
    insert into favorites_recipes (user_id, recipe_id, sort, rev, created_at, updated_at, deleted_at)
    values (p_user_id, p_key::uuid, coalesce((p_payload->>'sort')::integer, 0), p_rev, now(), now(), null)
    on conflict (user_id, recipe_id) do update set sort = excluded.sort,
      rev = excluded.rev, updated_at = now();
  elsif p_entity = 'favorites_meals' then
    insert into favorites_meals (id, user_id, name, sort, rev, created_at, updated_at, deleted_at)
    values (p_key::uuid, p_user_id, p_payload->>'name',
            coalesce((p_payload->>'sort')::integer, 0), p_rev, now(), now(), null)
    on conflict (id) do update set name = excluded.name, sort = excluded.sort,
      rev = excluded.rev, updated_at = now()
      where favorites_meals.user_id = p_user_id;
    -- Items are replaced wholesale, like log_items, and only when the row is really hers.
    if exists (select 1 from favorites_meals m where m.id = p_key::uuid and m.user_id = p_user_id) then
      delete from favorites_meal_items where meal_id = p_key::uuid;
      insert into favorites_meal_items (meal_id, seq, food_ref_id, grams)
      select p_key::uuid, i.seq, i.food_ref_id, i.grams
        from jsonb_to_recordset(coalesce(p_payload->'items', '[]'::jsonb))
             as i(seq integer, food_ref_id uuid, grams numeric);
    end if;
  end if;
  return _sync_current(p_user_id, p_entity, p_key);
end; $$;
revoke execute on function _sync_upsert(uuid, text, text, jsonb, integer) from public, anon;
