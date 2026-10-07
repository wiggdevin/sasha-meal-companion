-- Phase 2 spec, "Data changes". `amount` is the item's contribution in the nutrient's own unit
-- with grams already applied; `basis` records the per-100 g source, so a grams edit recomputes
-- the snapshot. null = the source did not measure it; 0 = it measured zero (architecture §3.3).
-- security invoker: the RLS of the caller applies to every table this function reads.
create or replace function compute_item_snapshot(p_food_ref_id uuid, p_grams numeric)
returns jsonb language sql stable security invoker as $$
  with ref as (select * from food_refs where id = p_food_ref_id),
  rev as (select r.id, v.source, v.version_label from catalog_food_revisions r
            join catalog_versions v on v.id = r.catalog_version_id
            join ref on ref.catalog_food_id = r.catalog_food_id where r.is_active),
  catalog_vals as (select n.nutrient_code as code, n.amount_per_100g as per100, c.unit,
           rev.source, rev.version_label, rev.id as revision_id from rev
      join catalog_food_nutrients n on n.food_revision_id = rev.id
      join catalog_nutrients c on c.code = n.nutrient_code),
  user_vals as (select kv.key as code, nullif(kv.value, 'null'::jsonb)::numeric as per100, c.unit,
           'user'::text as source, uf.rev::text as version_label, null::bigint as revision_id
      from ref join user_foods uf on uf.id = ref.user_food_id
      cross join lateral jsonb_each(uf.per_100g) kv join catalog_nutrients c on c.code = kv.key),
  vals as (select * from catalog_vals union all select * from user_vals)
  select coalesce(jsonb_object_agg(code, jsonb_build_object(
           'amount', case when per100 is null then null else round(per100*p_grams/100.0, 4) end,
           'unit', unit, 'basis', 'per_100g', 'source', source,
           'source_version', version_label, 'revision_id', revision_id)), '{}'::jsonb) from vals;
$$;
grant execute on function compute_item_snapshot(uuid, numeric) to authenticated;
grant execute on function compute_item_snapshot(uuid, numeric) to service_role;

-- Lane A's _sync_upsert (20260911000600_rpc.sql), unchanged except the log_entries branch, which
-- now mints the snapshot in SQL. Freezing rule: an item keeps its previous snapshot when its id,
-- grams and food_ref_id are all unchanged and that snapshot is non-empty. A payload carrying
-- "recompute_snapshots": true forces a recompute — scripts/verify-snapshots.ts --repair.
create or replace function _sync_upsert(p_user_id uuid, p_entity text, p_key text,
                                        p_payload jsonb, p_rev integer) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  v_prior jsonb := '{}'::jsonb;
  v_force boolean := coalesce((p_payload->>'recompute_snapshots')::boolean, false);
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
    on conflict (user_id, local_date) do update set cups = excluded.cups, rev = excluded.rev;
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
    insert into user_settings (user_id, first_opened_at, scale_warning_dismissed, training_kcal,
                               rest_kcal, protein_g, protein_locked, ramp_override, slot_times,
                               shift_minutes, changed_at, rev)
    values (p_user_id, coalesce((p_payload->>'first_opened_at')::timestamptz, now()),
            coalesce((p_payload->>'scale_warning_dismissed')::boolean, false),
            (p_payload->>'training_kcal')::integer, (p_payload->>'rest_kcal')::integer,
            (p_payload->>'protein_g')::numeric,
            coalesce((p_payload->>'protein_locked')::boolean, true),
            (p_payload->>'ramp_override')::smallint,
            coalesce(p_payload->'slot_times', '{}'::jsonb),
            coalesce((p_payload->>'shift_minutes')::integer, 0),
            (p_payload->>'changed_at')::timestamptz, p_rev)
    on conflict (user_id) do update set first_opened_at = excluded.first_opened_at,
      scale_warning_dismissed = excluded.scale_warning_dismissed,
      training_kcal = excluded.training_kcal, rest_kcal = excluded.rest_kcal,
      protein_g = excluded.protein_g, protein_locked = excluded.protein_locked,
      ramp_override = excluded.ramp_override, slot_times = excluded.slot_times,
      shift_minutes = excluded.shift_minutes, changed_at = excluded.changed_at, rev = excluded.rev;
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
  end if;
  return _sync_current(p_user_id, p_entity, p_key);
end; $$;
revoke execute on function _sync_upsert(uuid, text, text, jsonb, integer) from public, anon;
