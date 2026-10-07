-- Phase 3, contracts §3. Five `create or replace` with the Phase 0 signatures unchanged and the
-- Phase 0 semantics unchanged for every existing entity. What is new: four entities
-- (recipes, favorites_foods, favorites_recipes, favorites_meals), the recipe nutrient
-- computation, water_log's server-side max, and user_settings.water_goal_cups.

-- entity_key encoding, contracts §4. These strings must match lib/sync/keys.ts exactly.
--   user_foods | log_entries | gut_log | duplicate_groups | user_food_prefs | recipes
--     | favorites_foods | favorites_recipes | favorites_meals  -> lowercase uuid
--   plan_days | water_log                                      -> YYYY-MM-DD
--   user_settings                                              -> 'settings'
create or replace function _sync_assert_key(p_entity text, p_key text) returns void
  language plpgsql immutable as $$
begin
  if p_key is null then raise exception 'entity_key_required' using errcode = '22023'; end if;
  if p_entity in ('user_foods','log_entries','gut_log','duplicate_groups','user_food_prefs',
                  'recipes','favorites_foods','favorites_recipes','favorites_meals') then
    if p_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'bad_entity_key' using errcode = '22023';
    end if;
  elsif p_entity in ('plan_days','water_log') then
    if p_key !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'bad_entity_key' using errcode = '22023';
    end if;
  elsif p_entity = 'user_settings' then
    if p_key <> 'settings' then
      raise exception 'bad_entity_key' using errcode = '22023';
    end if;
  else
    raise exception 'unknown_entity' using errcode = '22023';
  end if;
end; $$;
revoke execute on function _sync_assert_key(text, text) from public, anon;

create or replace function _sync_current(p_user_id uuid, p_entity text, p_key text) returns jsonb
  language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  perform _sync_assert_key(p_entity, p_key);
  if p_entity = 'user_foods' then
    select to_jsonb(t) into v from user_foods t where t.user_id = p_user_id and t.id = p_key::uuid;
  elsif p_entity = 'user_food_prefs' then
    select to_jsonb(t) into v from user_food_prefs t
      where t.user_id = p_user_id and t.food_ref_id = p_key::uuid;
  elsif p_entity = 'log_entries' then
    select to_jsonb(e) || jsonb_build_object('items', coalesce(
             (select jsonb_agg(to_jsonb(i) order by i.seq) from log_items i where i.entry_id = e.id),
             '[]'::jsonb))
      into v from log_entries e where e.user_id = p_user_id and e.id = p_key::uuid;
  elsif p_entity = 'water_log' then
    select to_jsonb(t) into v from water_log t
      where t.user_id = p_user_id and t.local_date = p_key::date;
  elsif p_entity = 'plan_days' then
    select to_jsonb(t) into v from plan_days t
      where t.user_id = p_user_id and t.local_date = p_key::date;
  elsif p_entity = 'user_settings' then
    select to_jsonb(t) into v from user_settings t where t.user_id = p_user_id;
  elsif p_entity = 'gut_log' then
    select to_jsonb(t) into v from gut_log t where t.user_id = p_user_id and t.id = p_key::uuid;
  elsif p_entity = 'duplicate_groups' then
    select to_jsonb(t) || jsonb_build_object('fingerprint', encode(t.fingerprint, 'hex'))
      into v from duplicate_groups t where t.user_id = p_user_id and t.id = p_key::uuid;
  -- Phase 3. `current` has to be enough for a second device to write the row straight into
  -- IndexedDB (architecture §3.7), so a recipe carries its latest revision inline, and it
  -- carries food_ref_id: that registry row is what lib/recipes-client.ts logs a serving through,
  -- and the client has no other way to learn it.
  elsif p_entity = 'recipes' then
    select to_jsonb(r) || jsonb_build_object(
             'food_ref_id', (select fr.id from food_refs fr where fr.user_food_id = r.id),
             'revision_id', lr.id, 'revision_rev', lr.rev,
             'nutrients_per_serving', lr.nutrients_per_serving,
             'items', coalesce((select jsonb_agg(to_jsonb(i) order by i.seq)
                                  from recipe_items i where i.recipe_revision_id = lr.id),
                               '[]'::jsonb))
      into v
      from recipes r
      left join lateral (select rv.* from recipe_revisions rv
                          where rv.recipe_id = r.id order by rv.rev desc limit 1) lr on true
     where r.user_id = p_user_id and r.id = p_key::uuid;
  elsif p_entity = 'favorites_foods' then
    select to_jsonb(t) into v from favorites_foods t
      where t.user_id = p_user_id and t.food_ref_id = p_key::uuid;
  elsif p_entity = 'favorites_recipes' then
    select to_jsonb(t) into v from favorites_recipes t
      where t.user_id = p_user_id and t.recipe_id = p_key::uuid;
  elsif p_entity = 'favorites_meals' then
    select to_jsonb(m) || jsonb_build_object('items', coalesce(
             (select jsonb_agg(to_jsonb(i) order by i.seq) from favorites_meal_items i
               where i.meal_id = m.id), '[]'::jsonb))
      into v from favorites_meals m where m.user_id = p_user_id and m.id = p_key::uuid;
  end if;
  return v;
end; $$;
revoke execute on function _sync_current(uuid, text, text) from public, anon;

create or replace function _sync_tombstone(p_user_id uuid, p_entity text, p_key text,
                                           p_kind text, p_rev integer) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare v_deleted_at timestamptz := case when p_kind = 'delete' then now() else null end;
begin
  perform _sync_assert_key(p_entity, p_key);
  if p_entity = 'user_foods' then
    update user_foods set deleted_at = v_deleted_at, rev = p_rev
      where user_id = p_user_id and id = p_key::uuid;
  elsif p_entity = 'log_entries' then
    update log_entries set deleted_at = v_deleted_at, rev = p_rev
      where user_id = p_user_id and id = p_key::uuid;
  elsif p_entity = 'gut_log' then
    update gut_log set deleted_at = v_deleted_at, rev = p_rev
      where user_id = p_user_id and id = p_key::uuid;
  elsif p_entity = 'recipes' then
    update recipes set deleted_at = v_deleted_at, rev = p_rev, updated_at = now()
      where user_id = p_user_id and id = p_key::uuid;
    -- The recipe's loggable twin follows it, so a deleted recipe stops appearing in search.
    -- Existing log_items keep their own snapshots either way (architecture §3.3). rev moves with
    -- it so the change_log row apply_sync_op emits for this twin (below) carries the true rev,
    -- not the stale one from its last direct write.
    update user_foods set deleted_at = v_deleted_at, rev = p_rev
      where user_id = p_user_id and id = p_key::uuid and kind = 'recipe';
  elsif p_entity = 'favorites_foods' then
    update favorites_foods set deleted_at = v_deleted_at, rev = p_rev, updated_at = now()
      where user_id = p_user_id and food_ref_id = p_key::uuid;
  elsif p_entity = 'favorites_recipes' then
    update favorites_recipes set deleted_at = v_deleted_at, rev = p_rev, updated_at = now()
      where user_id = p_user_id and recipe_id = p_key::uuid;
  elsif p_entity = 'favorites_meals' then
    update favorites_meals set deleted_at = v_deleted_at, rev = p_rev, updated_at = now()
      where user_id = p_user_id and id = p_key::uuid;
  end if;
  return _sync_current(p_user_id, p_entity, p_key);
end; $$;
revoke execute on function _sync_tombstone(uuid, text, text, text, integer) from public, anon;

-- Insert-or-update one synced row. apply_sync_op has already decided create vs update, so a
-- single upsert per entity keeps the write path to one statement.
--
-- entity_key is client-generated and caller-supplied, so an id can collide with a row another
-- user already owns. Every ON CONFLICT DO UPDATE below is guarded by `where <table>.user_id =
-- p_user_id`: when the conflicting row belongs to someone else, the guard fails, Postgres treats
-- the upsert as DO NOTHING, and the other user's row is left untouched instead of overwritten.
-- No caller check (_sync_assert_caller) here: p_user_id is trusted from the caller, deferred to
-- apply_sync_op, which authenticates it before calling this function.
--
-- Phase 2: remember what was there before the wholesale replace, so an untouched item keeps
-- the snapshot it was logged with. A payload carrying "recompute_snapshots": true forces a
-- recompute — scripts/verify-snapshots.ts --repair.
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
    -- Phase 3: water_goal_cups joins the column list. Every column is replaced from the payload,
    -- so lib/water-client.ts setGoal sends the whole settings row, never just the goal.
    insert into user_settings (user_id, first_opened_at, scale_warning_dismissed, training_kcal,
                               rest_kcal, protein_g, protein_locked, ramp_override, slot_times,
                               shift_minutes, changed_at, water_goal_cups, rev)
    values (p_user_id, coalesce((p_payload->>'first_opened_at')::timestamptz, now()),
            coalesce((p_payload->>'scale_warning_dismissed')::boolean, false),
            (p_payload->>'training_kcal')::integer, (p_payload->>'rest_kcal')::integer,
            (p_payload->>'protein_g')::numeric,
            coalesce((p_payload->>'protein_locked')::boolean, true),
            (p_payload->>'ramp_override')::smallint,
            coalesce(p_payload->'slot_times', '{}'::jsonb),
            coalesce((p_payload->>'shift_minutes')::integer, 0),
            (p_payload->>'changed_at')::timestamptz,
            coalesce((p_payload->>'water_goal_cups')::integer, 8), p_rev)
    on conflict (user_id) do update set first_opened_at = excluded.first_opened_at,
      scale_warning_dismissed = excluded.scale_warning_dismissed,
      training_kcal = excluded.training_kcal, rest_kcal = excluded.rest_kcal,
      protein_g = excluded.protein_g, protein_locked = excluded.protein_locked,
      ramp_override = excluded.ramp_override, slot_times = excluded.slot_times,
      shift_minutes = excluded.shift_minutes, changed_at = excluded.changed_at,
      water_goal_cups = excluded.water_goal_cups, rev = excluded.rev;
  elsif p_entity = 'gut_log' then
    insert into gut_log (id, user_id, local_date, tz, state, note, rev, deleted_at)
    values (p_key::uuid, p_user_id, (p_payload->>'local_date')::date, p_payload->>'tz',
            p_payload->>'state', p_payload->>'note', p_rev, null)
    on conflict (id) do update set local_date = excluded.local_date, tz = excluded.tz,
      state = excluded.state, note = excluded.note, rev = excluded.rev
      where gut_log.user_id = p_user_id;
  elsif p_entity = 'duplicate_groups' then
    insert into duplicate_groups (id, user_id, local_date, fingerprint, slot, state,
                                  merged_into_entry_id, decided_at, rev)
    values (p_key::uuid, p_user_id, (p_payload->>'local_date')::date,
            decode(p_payload->>'fingerprint', 'hex'), p_payload->>'slot',
            coalesce(p_payload->>'state', 'open'),
            (p_payload->>'merged_into_entry_id')::uuid,
            (p_payload->>'decided_at')::timestamptz, p_rev)
    on conflict (id) do update set local_date = excluded.local_date,
      fingerprint = excluded.fingerprint, slot = excluded.slot, state = excluded.state,
      merged_into_entry_id = excluded.merged_into_entry_id, decided_at = excluded.decided_at,
      rev = excluded.rev
      where duplicate_groups.user_id = p_user_id;

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

-- One op, one transaction, contracts §2. The caller (app/api/sync/ops/route.ts) issues one RPC
-- per op in array order; PostgREST wraps each call in its own transaction.
--
-- Phase 0's body, unchanged except the delete/restore allowlist (contracts §3).
create or replace function apply_sync_op(p_user_id uuid, p_op jsonb) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  v_op_id   uuid    := (p_op->>'op_id')::uuid;
  v_entity  text    := p_op->>'entity';
  v_key     text    := p_op->>'entity_id';
  v_kind    text    := p_op->>'kind';
  v_base    integer := (p_op->>'base_rev')::integer;
  v_current jsonb;
  v_rev     integer;
  v_seq     bigint;
  v_after   jsonb;
  v_twin    jsonb;
begin
  perform _sync_assert_caller(p_user_id);
  if v_op_id is null then raise exception 'op_id_required' using errcode = '22023'; end if;
  if v_kind not in ('create','update','delete','restore') then
    raise exception 'bad_op_kind' using errcode = '22023';
  end if;
  perform _sync_assert_key(v_entity, v_key);

  -- Tombstone-capable entities. Phase 3 adds recipes and the three favorites kinds; everything
  -- else still answers 'unsupported' and writes nothing, never raising.
  if v_kind in ('delete', 'restore') and v_entity not in
       ('user_foods', 'log_entries', 'gut_log', 'recipes',
        'favorites_foods', 'favorites_recipes', 'favorites_meals') then
    return jsonb_build_object('op_id', v_op_id, 'status', 'unsupported');
  end if;

  -- Compare-and-swap must be atomic across the read below and the write it gates: two callers
  -- racing the same (user, entity, entity_key) with the same base_rev would otherwise both read
  -- the same current rev, both pass the check, and the second write silently clobbers the first
  -- (no error, no conflict — the loser's caller sees 'applied' and never learns its write was
  -- overwritten). pg_advisory_xact_lock blocks until acquired and releases automatically at the
  -- end of this transaction (one op, one transaction, per the comment above), so the second
  -- concurrent call waits here, then re-reads the just-committed row and correctly sees a
  -- conflict (or, for a concurrent 'create', sees the row the first call just inserted).
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || v_entity || ':' || v_key, 0));

  -- The op_id duplicate check must run AFTER the lock, not before: two callers retrying the same
  -- op_id concurrently would otherwise both pass this check before either commits (contracts §2
  -- says an already-logged op_id answers 'duplicate' unconditionally), then serialize on the lock
  -- above. Checked only here, the loser re-reads a state that has already moved past its own
  -- base_rev/current check and answers 'conflict' instead of the contracted 'duplicate' for its
  -- own op — a retry gets fed a real-looking conflict for a write that already succeeded.
  if exists (select 1 from change_log where op_id = v_op_id) then
    return jsonb_build_object('op_id', v_op_id, 'status', 'duplicate');
  end if;

  v_current := _sync_current(p_user_id, v_entity, v_key);

  if v_kind = 'create' then
    if v_current is not null then
      return jsonb_build_object('op_id', v_op_id, 'status', 'conflict', 'entity', v_entity,
                                'current_rev', (v_current->>'rev')::integer, 'current', v_current);
    end if;
    v_rev := 1;
  else
    if v_current is null then
      return jsonb_build_object('op_id', v_op_id, 'status', 'gone');
    end if;
    if v_current->>'deleted_at' is not null and v_kind <> 'restore' then
      return jsonb_build_object('op_id', v_op_id, 'status', 'deleted', 'entity', v_entity,
                                'deleted_at', v_current->>'deleted_at');
    end if;
    -- A restore on a row that was never tombstoned already satisfies the client's intent (this
    -- row is not deleted) — idempotent no-op, no change_log row, and NOT a new seq.
    if v_kind = 'restore' and v_current->>'deleted_at' is null then
      return jsonb_build_object('op_id', v_op_id, 'status', 'applied',
        'rev', (v_current->>'rev')::integer,
        'seq', coalesce((select max(seq) from change_log
                           where user_id = p_user_id and entity = v_entity and entity_key = v_key), 0));
    end if;
    if v_base is null or v_base <> (v_current->>'rev')::integer then
      return jsonb_build_object('op_id', v_op_id, 'status', 'conflict', 'entity', v_entity,
                                'current_rev', (v_current->>'rev')::integer, 'current', v_current);
    end if;
    v_rev := (v_current->>'rev')::integer + 1;
  end if;

  if v_kind in ('create','update') then
    v_after := _sync_upsert(p_user_id, v_entity, v_key, coalesce(p_op->'payload', '{}'::jsonb), v_rev);
  else
    v_after := _sync_tombstone(p_user_id, v_entity, v_key, v_kind, v_rev);
  end if;

  v_seq := next_change_seq(p_user_id);
  insert into change_log (user_id, seq, entity, entity_key, rev, op, op_id, current)
  values (p_user_id, v_seq, v_entity, v_key, v_rev, v_kind, v_op_id,
          case when v_kind = 'delete' then null else v_after end);

  -- A recipe's loggable `user_foods` twin (_sync_upsert / _sync_tombstone above) is a first-class
  -- entity in its own right — every other write path to user_foods logs its own change_log row,
  -- and a pulling client's local user_foods mirror only ever learns about a row from this table.
  -- Without this, a device that has synced user_foods before never hears the twin was created,
  -- edited or deleted; it would have to re-derive it from the recipes entity, which nothing but
  -- this lane's own client code does today. op_id must be distinct from v_op_id (change_log has a
  -- unique index on op_id): this row is synthetic, one write generated by the primary op, not a
  -- second client op, so it carries its own fresh id and is never itself looked up for dedup.
  if v_entity = 'recipes' then
    v_twin := _sync_current(p_user_id, 'user_foods', v_key);
    if v_twin is not null then
      insert into change_log (user_id, seq, entity, entity_key, rev, op, op_id, current)
      values (p_user_id, next_change_seq(p_user_id), 'user_foods', v_key,
              (v_twin->>'rev')::integer, v_kind, gen_random_uuid(),
              case when v_kind = 'delete' then null else v_twin end);
    end if;
  end if;

  return jsonb_build_object('op_id', v_op_id, 'status', 'applied', 'rev', v_rev, 'seq', v_seq);
end; $$;
revoke execute on function apply_sync_op(uuid, jsonb) from public, anon;
grant execute on function apply_sync_op(uuid, jsonb) to authenticated, service_role;
