-- Coach Undo receipts v1, deploy step 4 (docs/specs/coach-undo-receipt.md §4, §7).
--
-- The receipt-aware perform_coach_undo. It keeps its signature and answers and branches on the
-- record's immutable `record_mode`, never on whether a receipt happens to exist (spec §4.1):
--
--   * receipt_v1 → _coach_undo_receipt: the inverse is built from the record's one receipt only;
--     `local` is refused (`undo_receipt_record`). Refusals: undo_receipt_inconsistent (not exactly
--     one receipt of the record's kind), undo_source_mismatch (source_check is not 'match'),
--     undo_not_synced, undo_conflict (the revision moved or the row was deleted),
--     undo_receipt_mismatch (same revision, other identity). The inverse op id is random, and the
--     record closes only when the inverse applied and a re-read shows the receipt's `before`.
--   * legacy → _coach_undo_legacy: step 3's body (save_recipe phone-only, receipt records refused),
--     with one change: the target's advisory lock is taken before the record and target row locks
--     (spec §4.3), so it never holds a record row while it waits on a target another transaction
--     holds; and, as for receipts, the inverse op id is random and the record closes only when the
--     inverse applied and a re-read shows the restored state.
--
-- Live-safe: no receipt_v1 record exists yet, so every call takes the legacy branch.
--
-- Rollback (spec §7): keep this file until no unexpired receipt_v1 record remains. Its down file
-- restores step 3's body, which still refuses every receipt_v1 record; never restore the
-- unguarded 20261210090300 body.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

-- Today's path for every record that is not receipt_v1 (spec §5).
create function _coach_undo_legacy(p_user uuid, p_undo_id uuid, p_local boolean)
  returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := p_user;
  v_peek coach_action_undos%rowtype;
  v_row coach_action_undos%rowtype;
  v_lock text;
  v_check boolean;
  v_inv jsonb;
  v_op_id uuid;
  v_result jsonb;
  v_rev bigint;
  v_deleted timestamptz;
  v_cups integer;
  v_day plan_days%rowtype;
  v_overrides jsonb;
  v_previous jsonb;
  v_slot text;
  v_name text;
  v_set text;
  v_restore text;
  v_now_status text;
  v_now_rev bigint;
  v_date date;
  v_eaten timestamptz;
begin
  -- 1. The record without a lock: its target names the advisory lock.
  select * into v_peek from coach_action_undos where id = p_undo_id and user_id = v_user;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if v_peek.record_mode is distinct from 'legacy' then
    if p_local then raise exception 'undo_receipt_record' using errcode = 'P0001'; end if;
    raise exception 'undo_receipt_inconsistent' using errcode = 'P0001';
  end if;
  -- 2. The target's advisory lock, under the key its own write takes (apply_sync_op's
  --    user:entity:key; set_food_membership's user:food-note:name), before any row lock.
  if not p_local then
    v_lock := case
      when v_peek.kind = 'log_meal' and v_peek.inverse->>'entryId' is not null
        then v_user::text || ':log_entries:' || (v_peek.inverse->>'entryId')
      when v_peek.kind = 'log_water' and v_peek.inverse->>'date' is not null
        then v_user::text || ':water_log:' || (v_peek.inverse->>'date')
      when v_peek.kind in ('skip_slot', 'restore_slot') and v_peek.inverse->>'date' is not null
        then v_user::text || ':plan_days:' || (v_peek.inverse->>'date')
      when v_peek.kind in ('add_to_avoid', 'remove_from_avoid', 'add_to_eats', 'remove_from_eats')
           and v_peek.inverse->>'nameNorm' is not null
        then v_user::text || ':food-note:' || food_name_norm(food_name_norm(v_peek.inverse->>'nameNorm'))
    end;
    if v_lock is not null then perform pg_advisory_xact_lock(hashtextextended(v_lock, 0)); end if;
  end if;
  -- 3. The record row, then today's checks.
  select * into v_row from coach_action_undos
   where id = p_undo_id and user_id = v_user for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if v_row.undone_at is not null then
    return jsonb_build_object('status', 'already_undone', 'undone_at', v_row.undone_at);
  end if;
  if p_local then
    update coach_action_undos set undone_at = now() where id = v_row.id;
    return jsonb_build_object('status', 'undone', 'undone_at', now());
  end if;
  if v_row.expires_at <= now() then return jsonb_build_object('status', 'expired'); end if;
  -- The lock above was taken for the inverse read in step 1; a record rewritten since (only the
  -- scrub does, and only past expiry) is left alone.
  if v_row.inverse is distinct from v_peek.inverse then
    raise exception 'undo_conflict' using errcode = 'P0001';
  end if;

  v_inv := v_row.inverse;
  -- Unpredictable, never derived from the record (PR A review r1 BLOCK 1, applied to legacy too):
  -- a guessable id could be pre-submitted so that the inverse answers `duplicate` unwritten.
  v_op_id := gen_random_uuid();

  if v_row.kind = 'log_meal' then
    if v_row.expected_rev is null or v_inv->>'entryId' is null then
      raise exception 'undo_local_only' using errcode = 'P0001';
    end if;
    select rev, deleted_at, local_date, slot, eaten_at into v_rev, v_deleted, v_date, v_slot, v_eaten from log_entries
     where user_id = v_user and id = (v_inv->>'entryId')::uuid for update;
    if not found then raise exception 'undo_not_synced' using errcode = 'P0001'; end if;
    -- The entry must be the one the issued action describes — its date, slot and the exact foods
    -- and grams it logged; otherwise only the phone may decide. (A token the owner forges to name
    -- another of their own identical entries deletes an identical meal: a self-only edit, confined
    -- by RLS, with the same effect on the day — accepted, review t4r10 #3 and the O2 ruling.)
    if not (v_row.bind ? 'slot') or not (v_row.bind ? 'items') or not (v_row.bind ? 'date')
       or v_date is distinct from (v_row.bind->>'date')::date
       or v_slot is distinct from v_row.bind->>'slot'
       or (v_row.bind ? 'eatenAt' and v_eaten is distinct from (v_row.bind->>'eatenAt')::timestamptz)
       or v_row.bind->'items' is distinct from (
            select jsonb_agg(jsonb_build_array(li.food_ref_id::text, li.grams::numeric)
                             order by li.food_ref_id::text, li.grams::numeric)
              from log_items li where li.entry_id = (v_inv->>'entryId')::uuid) then
      raise exception 'undo_local_only' using errcode = 'P0001';
    end if;
    if v_deleted is not null or v_rev <> v_row.expected_rev then
      raise exception 'undo_conflict' using errcode = 'P0001';
    end if;
    v_result := apply_sync_op(v_user, jsonb_build_object('op_id', v_op_id, 'entity', 'log_entries',
      'entity_id', v_inv->>'entryId', 'kind', 'delete', 'base_rev', v_rev, 'payload', '{}'::jsonb,
      'client_ts', now()));

  -- save_recipe is phone-only (spec §5): its check was the recipe's name, which can match another
  -- same-name recipe. It falls through to undo_local_only below; the phone keeps its token.
  elsif v_row.kind = 'log_water' then
    if jsonb_typeof(v_inv->'cups') is distinct from 'number'
       or jsonb_typeof(v_inv->'after') is distinct from 'number'
       or (v_inv->>'cups')::int <= 0 or (v_inv->>'after')::int < (v_inv->>'cups')::int then
      raise exception 'undo_local_only' using errcode = 'P0001';
    end if;
    select cups, rev into v_cups, v_rev from water_log
     where user_id = v_user and local_date = (v_inv->>'date')::date for update;
    if not found then raise exception 'undo_not_synced' using errcode = 'P0001'; end if;
    -- The row revision the add left (review t4r9 #5, t4r10 #4): the same count after a later edit
    -- (6 → 5 → 6) is not the row the add left. Without it, only the phone may decide.
    if v_row.expected_rev is null then raise exception 'undo_local_only' using errcode = 'P0001'; end if;
    if v_rev < v_row.expected_rev then
      raise exception 'undo_not_synced' using errcode = 'P0001';
    end if;
    if v_rev > v_row.expected_rev then
      raise exception 'undo_conflict' using errcode = 'P0001';
    end if;
    -- Additive: only exactly the cups the add left prove nothing else (an Undo included) ran.
    if v_cups = (v_inv->>'after')::int - (v_inv->>'cups')::int then
      raise exception 'undo_not_synced' using errcode = 'P0001';
    end if;
    if v_cups <> (v_inv->>'after')::int then raise exception 'undo_conflict' using errcode = 'P0001'; end if;
    v_result := apply_sync_op(v_user, jsonb_build_object('op_id', v_op_id, 'entity', 'water_log',
      'entity_id', v_inv->>'date', 'kind', 'update', 'base_rev', v_rev,
      'payload', jsonb_build_object('local_date', v_inv->>'date',
        'cups', v_cups - (v_inv->>'cups')::int), 'client_ts', now()));

  elsif v_row.kind in ('skip_slot', 'restore_slot') then
    if v_inv->>'slot' is null or not (v_inv ? 'applied') or not (v_inv ? 'previous') then
      raise exception 'undo_local_only' using errcode = 'P0001';
    end if;
    v_slot := v_inv->>'slot';
    select * into v_day from plan_days
     where user_id = v_user and local_date = (v_inv->>'date')::date for update;
    if _coach_undo_slot_state(v_day.item_overrides->v_slot)
       is distinct from _coach_undo_slot_state(v_inv->'applied') then
      -- Still what was there before the action: its own write has not arrived (or was undone).
      if _coach_undo_slot_state(v_day.item_overrides->v_slot)
         = _coach_undo_slot_state(v_inv->'previous') then
        raise exception 'undo_not_synced' using errcode = 'P0001';
      end if;
      raise exception 'undo_conflict' using errcode = 'P0001';
    end if;
    if v_day.local_date is null then raise exception 'undo_not_synced' using errcode = 'P0001'; end if;
    v_previous := v_inv->'previous';
    if v_previous is null or jsonb_typeof(v_previous) = 'null' then
      v_overrides := coalesce(v_day.item_overrides, '{}'::jsonb) - v_slot;
    else
      -- The same mutation stamp saveItemOverride gives a non-plan override (lib/plan-day-client.ts).
      if coalesce(v_previous->'followPlan', 'false'::jsonb) <> 'true'::jsonb
         or v_previous->'cleared' = 'true'::jsonb or v_previous->'removed' = 'true'::jsonb
         or v_previous->'added' = 'true'::jsonb then
        v_previous := v_previous || jsonb_build_object('mutationId', gen_random_uuid());
      end if;
      v_overrides := jsonb_set(coalesce(v_day.item_overrides, '{}'::jsonb), array[v_slot], v_previous);
    end if;
    -- Every plan_days op carries the five plan fields; eaten_slots and day_complete_at are kept.
    v_result := apply_sync_op(v_user, jsonb_build_object('op_id', v_op_id, 'entity', 'plan_days',
      'entity_id', v_inv->>'date', 'kind', 'update', 'base_rev', v_day.rev,
      'payload', jsonb_build_object('local_date', v_inv->>'date',
        'day_type_override', v_day.day_type_override, 'floor_day', v_day.floor_day,
        'swaps', v_day.swaps, 'slot_notes', v_day.slot_notes, 'item_overrides', v_overrides),
      'client_ts', now()));

  elsif v_row.kind in ('add_to_avoid', 'remove_from_avoid', 'add_to_eats', 'remove_from_eats') then
    -- nameNorm is stamped by the record route (lib/foods/normalize.ts); a mark that also changed
    -- the food's note is phone-only (restoring it is a second write the phone owns).
    if v_inv->>'nameNorm' is null or v_row.expected_rev is null
       or (v_inv ? 'appliedNote' and v_inv->'previous'->>'status' is not null) then
      raise exception 'undo_local_only' using errcode = 'P0001';
    end if;
    v_name := food_name_norm(v_inv->>'nameNorm');
    v_set := case v_row.kind when 'add_to_avoid' then 'avoid' when 'add_to_eats' then 'eats' end;
    v_restore := v_inv->'previous'->>'status';
    select status, rev into v_now_status, v_now_rev from food_membership_revisions
     where user_id = v_user and name_norm = v_name for update;
    -- The membership revision the action's own mark wrote (review t4r4 #2): older means the mark
    -- has not arrived; newer means a later choice exists, even one back to the same status.
    if v_now_rev is null or v_now_rev < v_row.expected_rev then
      raise exception 'undo_not_synced' using errcode = 'P0001';
    end if;
    if v_now_rev > v_row.expected_rev or v_now_status is distinct from v_set then
      raise exception 'undo_conflict' using errcode = 'P0001';
    end if;
    -- Newer than any mark the phone stamped, whatever its clock.
    v_rev := greatest((extract(epoch from clock_timestamp()) * 1000)::bigint, coalesce(v_now_rev, -1) + 1);
    v_result := set_food_membership(v_user, v_name, v_restore, v_inv->'previous'->>'note', v_rev);
    if (v_result->>'rev')::bigint is distinct from v_rev
       or (v_result->>'status') is distinct from v_restore then
      raise exception 'undo_conflict' using errcode = 'P0001';
    end if;
    v_result := jsonb_build_object('status', 'applied');

  else
    raise exception 'undo_local_only' using errcode = 'P0001';
  end if;

  -- Only a written inverse closes the record: `applied`, and a re-read of the target shows the
  -- state the inverse restores. Anything else raises, which rolls back the write and leaves the
  -- record open.
  if v_result->>'status' is distinct from 'applied' then
    raise exception 'undo_conflict' using errcode = 'P0001';
  end if;
  if v_row.kind = 'log_meal' then
    select deleted_at is not null and rev = v_rev + 1 into v_check from log_entries
     where user_id = v_user and id = (v_inv->>'entryId')::uuid;
  elsif v_row.kind = 'log_water' then
    select cups = v_cups - (v_inv->>'cups')::int and rev = v_rev + 1 into v_check from water_log
     where user_id = v_user and local_date = (v_inv->>'date')::date;
  elsif v_row.kind in ('skip_slot', 'restore_slot') then
    -- The overrides written, and every other column as it stood.
    select t.rev = v_day.rev + 1 and t.item_overrides = v_overrides
           and (to_jsonb(t) - 'rev' - 'updated_at' - 'item_overrides')
             = (to_jsonb(v_day) - 'rev' - 'updated_at' - 'item_overrides')
      into v_check from plan_days t where t.user_id = v_user and t.local_date = (v_inv->>'date')::date;
  else
    select status is not distinct from v_restore and rev = v_rev into v_check
      from food_membership_revisions where user_id = v_user and name_norm = v_name;
  end if;
  if v_check is not true then
    raise exception 'undo_conflict' using errcode = 'P0001';
  end if;
  update coach_action_undos set undone_at = now() where id = v_row.id;
  return jsonb_build_object('status', 'undone', 'undone_at', now());
end; $$;
revoke all on function _coach_undo_legacy(uuid, uuid, boolean) from public, anon, authenticated, service_role;

-- A receipt record's Undo (spec §4.2, §4.3), built from its one receipt only; the record's
-- `inverse`, `expected_rev` and `bind` are never read. Lock order: the record and receipt without
-- locks (the receipt is immutable), the target's advisory lock, the record row, the target row.
create function _coach_undo_receipt(p_user uuid, p_undo_id uuid)
  returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := p_user;
  v_peek coach_action_undos%rowtype;
  v_row coach_action_undos%rowtype;
  v_receipt coach_action_receipts%rowtype;
  v_receipts integer;
  v_entity text;
  v_key text;
  v_ok boolean;
  v_app jsonb;
  v_op_id uuid;
  v_result jsonb;
  v_rev bigint;
  v_deleted timestamptz;
  v_date date;
  v_slot text;
  v_eaten timestamptz;
  v_revision uuid;
  v_day plan_days%rowtype;
  v_before jsonb;
  v_overrides jsonb;
  v_check boolean;
begin
  -- 1. The record and its receipt, without locks.
  select * into v_peek from coach_action_undos where id = p_undo_id and user_id = v_user;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  select count(*) into v_receipts from coach_action_receipts
   where user_id = v_user and action_id = v_peek.action_id;
  select * into v_receipt from coach_action_receipts
   where user_id = v_user and action_id = v_peek.action_id;
  v_entity := case v_peek.kind when 'log_meal' then 'log_entries' when 'save_recipe' then 'recipes'
                               when 'set_slot_meal' then 'plan_days' end;
  -- Exactly one receipt, of the record's own kind and entity (spec §4.1).
  v_ok := v_peek.record_mode = 'receipt_v1' and v_receipts = 1 and v_entity is not null
          and v_receipt.kind = v_peek.kind and v_receipt.entity = v_entity;
  v_key := v_receipt.entity_id;
  -- 2. The target's advisory lock: apply_sync_op's own key for this entity and key.
  if v_ok then
    perform pg_advisory_xact_lock(hashtextextended(v_user::text || ':' || v_entity || ':' || v_key, 0));
  end if;
  -- 3. The record row; still open and unexpired.
  select * into v_row from coach_action_undos
   where id = p_undo_id and user_id = v_user for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if v_row.undone_at is not null then
    return jsonb_build_object('status', 'already_undone', 'undone_at', v_row.undone_at);
  end if;
  if v_row.expires_at <= now() then return jsonb_build_object('status', 'expired'); end if;
  if not v_ok then raise exception 'undo_receipt_inconsistent' using errcode = 'P0001'; end if;
  if v_receipt.source_check is distinct from 'match' then
    raise exception 'undo_source_mismatch' using errcode = 'P0001';
  end if;

  v_app := v_receipt.applied;
  -- Unpredictable, never derived from the record or the action (PR A review r1 BLOCK 1): a client
  -- that could guess it could pre-submit it and make the inverse answer `duplicate` unwritten.
  v_op_id := gen_random_uuid();

  -- 4. The target row, checked against the receipt (spec §4.2), then the inverse write through the
  --    sync RPC the phone's own op uses.
  if v_row.kind = 'log_meal' then
    if v_app->>'entryId' is distinct from v_key or jsonb_typeof(v_app->'rev') is distinct from 'number'
       or jsonb_typeof(v_app->'items') is distinct from 'array' then
      raise exception 'undo_receipt_inconsistent' using errcode = 'P0001';
    end if;
    select rev, deleted_at, local_date, slot, eaten_at into v_rev, v_deleted, v_date, v_slot, v_eaten
      from log_entries where user_id = v_user and id = v_key::uuid for update;
    if not found then raise exception 'undo_not_synced' using errcode = 'P0001'; end if;
    if v_deleted is not null or v_rev <> (v_app->>'rev')::bigint then
      raise exception 'undo_conflict' using errcode = 'P0001';
    end if;
    -- Same revision: the entry must still be the one the receipt read — date, slot, instant and the
    -- (item id, food, grams) set.
    if v_date::text is distinct from v_app->>'date' or v_slot is distinct from v_app->>'slot'
       or v_eaten is distinct from _coach_undo_instant(v_app->>'eatenAt')
       or (select jsonb_agg(jsonb_build_array(li.id::text, li.food_ref_id::text, li.grams::numeric)
                            order by li.id::text collate "C")
             from log_items li where li.entry_id = v_key::uuid)
          is distinct from
          (select jsonb_agg(jsonb_build_array(lower(i->>'itemId'), lower(i->>'foodRefId'),
                                              (i->>'grams')::numeric)
                            order by lower(i->>'itemId') collate "C")
             from jsonb_array_elements(v_app->'items') i) then
      raise exception 'undo_receipt_mismatch' using errcode = 'P0001';
    end if;
    v_result := apply_sync_op(v_user, jsonb_build_object('op_id', v_op_id, 'entity', 'log_entries',
      'entity_id', v_key, 'kind', 'delete', 'base_rev', v_rev, 'payload', '{}'::jsonb,
      'client_ts', now()));

  elsif v_row.kind = 'save_recipe' then
    if v_app->>'recipeId' is distinct from v_key or jsonb_typeof(v_app->'rev') is distinct from 'number'
       or v_app->>'revisionId' is null or jsonb_typeof(v_app->'items') is distinct from 'array' then
      raise exception 'undo_receipt_inconsistent' using errcode = 'P0001';
    end if;
    select rev, deleted_at into v_rev, v_deleted from recipes
     where user_id = v_user and id = v_key::uuid for update;
    if not found then raise exception 'undo_not_synced' using errcode = 'P0001'; end if;
    if v_deleted is not null or v_rev <> (v_app->>'rev')::bigint then
      raise exception 'undo_conflict' using errcode = 'P0001';
    end if;
    -- Same revision: its current revision must be the receipt's, with the same ingredient list.
    select id into v_revision from recipe_revisions where recipe_id = v_key::uuid and rev = v_rev;
    if v_revision::text is distinct from lower(v_app->>'revisionId')
       or (select jsonb_agg(jsonb_build_array(ri.seq, ri.food_ref_id::text, ri.grams::numeric)
                            order by ri.seq)
             from recipe_items ri where ri.recipe_revision_id = v_revision)
          is distinct from
          (select jsonb_agg(jsonb_build_array((i->>'seq')::integer, lower(i->>'foodRefId'),
                                              (i->>'grams')::numeric)
                            order by (i->>'seq')::integer)
             from jsonb_array_elements(v_app->'items') i) then
      raise exception 'undo_receipt_mismatch' using errcode = 'P0001';
    end if;
    -- _sync_tombstone also tombstones the recipe's user_foods twin, with its own change_log row.
    v_result := apply_sync_op(v_user, jsonb_build_object('op_id', v_op_id, 'entity', 'recipes',
      'entity_id', v_key, 'kind', 'delete', 'base_rev', v_rev, 'payload', '{}'::jsonb,
      'client_ts', now()));

  else -- set_slot_meal
    v_slot := v_app->>'slot';
    if v_app->>'date' is distinct from v_key or v_slot is null
       or jsonb_typeof(v_app->'rev') is distinct from 'number'
       or jsonb_typeof(v_app->'after') is distinct from 'object' or not (v_app ? 'before') then
      raise exception 'undo_receipt_inconsistent' using errcode = 'P0001';
    end if;
    select * into v_day from plan_days
     where user_id = v_user and local_date = v_key::date for update;
    if not found then raise exception 'undo_not_synced' using errcode = 'P0001'; end if;
    -- The day's revision (review R3-2): any later write to the date, another slot's too, refuses.
    if v_day.rev <> (v_app->>'rev')::bigint then
      raise exception 'undo_conflict' using errcode = 'P0001';
    end if;
    -- Same revision: the slot must hold exactly what the write left, its mutationId included.
    if _coach_undo_slot_state(v_day.item_overrides->v_slot)
       is distinct from _coach_undo_slot_state(v_app->'after') then
      raise exception 'undo_receipt_mismatch' using errcode = 'P0001';
    end if;
    v_before := v_app->'before';
    if v_before is null or jsonb_typeof(v_before) = 'null' then
      v_overrides := coalesce(v_day.item_overrides, '{}'::jsonb) - v_slot;
    else
      -- The same mutation stamp saveItemOverride gives a non-plan override (as the skip Undo does).
      if coalesce(v_before->'followPlan', 'false'::jsonb) <> 'true'::jsonb
         or v_before->'cleared' = 'true'::jsonb or v_before->'removed' = 'true'::jsonb
         or v_before->'added' = 'true'::jsonb then
        v_before := v_before || jsonb_build_object('mutationId', gen_random_uuid());
      end if;
      v_overrides := jsonb_set(coalesce(v_day.item_overrides, '{}'::jsonb), array[v_slot], v_before);
    end if;
    -- Only item_overrides is sent: every other field stays as it stands (omitted keys are kept).
    v_result := apply_sync_op(v_user, jsonb_build_object('op_id', v_op_id, 'entity', 'plan_days',
      'entity_id', v_key, 'kind', 'update', 'base_rev', v_day.rev,
      'payload', jsonb_build_object('local_date', v_key, 'item_overrides', v_overrides),
      'client_ts', now()));
  end if;

  -- 5. Only a written inverse closes the record: `applied`, and a re-read of the target shows the
  --    receipt's `before` state. Anything else raises, which rolls back the write and leaves the
  --    record open (PR A review r1 BLOCK 1).
  if v_result->>'status' is distinct from 'applied' then
    raise exception 'undo_conflict' using errcode = 'P0001';
  end if;
  if v_row.kind = 'log_meal' then
    select deleted_at is not null and rev = v_rev + 1 into v_check from log_entries
     where user_id = v_user and id = v_key::uuid;
  elsif v_row.kind = 'save_recipe' then
    -- The recipe and its loggable user_foods twin are both gone.
    select r.deleted_at is not null and r.rev = v_rev + 1
           and not exists (select 1 from user_foods f where f.user_id = v_user and f.id = r.id
                             and f.deleted_at is null)
      into v_check from recipes r where r.user_id = v_user and r.id = v_key::uuid;
  else
    -- The slot holds `before` in every field but mutationId (a restore writes it fresh), and the
    -- rest of the row is what it was.
    select t.rev = v_day.rev + 1
           and jsonb_strip_nulls(jsonb_build_object('s', _coach_undo_slot_state(t.item_overrides->v_slot)))
                 #- '{s,mutationId}'
               = jsonb_strip_nulls(jsonb_build_object('s', _coach_undo_slot_state(v_app->'before')))
                 #- '{s,mutationId}'
           and (t.item_overrides - v_slot) = (coalesce(v_day.item_overrides, '{}'::jsonb) - v_slot)
           and t.eaten_slots = v_day.eaten_slots and t.slot_notes = v_day.slot_notes
           and t.swaps = v_day.swaps and t.floor_day = v_day.floor_day
           and t.day_type_override is not distinct from v_day.day_type_override
           and t.day_complete_at is not distinct from v_day.day_complete_at
      into v_check from plan_days t where t.user_id = v_user and t.local_date = v_key::date;
  end if;
  if v_check is not true then
    raise exception 'undo_conflict' using errcode = 'P0001';
  end if;
  -- 6. Close the record in the same transaction.
  update coach_action_undos set undone_at = now() where id = v_row.id;
  return jsonb_build_object('status', 'undone', 'undone_at', now());
end; $$;
revoke all on function _coach_undo_receipt(uuid, uuid) from public, anon, authenticated, service_role;

-- Same signature, same answers: `{status: undone | not_found | already_undone | expired}` or a raise.
create or replace function perform_coach_undo(p_undo_id uuid, p_local boolean default false)
  returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_mode text;
begin
  if v_user is null then raise exception 'forbidden' using errcode = '42501'; end if;
  select record_mode into v_mode from coach_action_undos where id = p_undo_id and user_id = v_user;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if v_mode = 'receipt_v1' then
    -- Only a verified inverse closes a receipt record (review R2-1).
    if p_local then raise exception 'undo_receipt_record' using errcode = 'P0001'; end if;
    return _coach_undo_receipt(v_user, p_undo_id);
  end if;
  return _coach_undo_legacy(v_user, p_undo_id, p_local);
end; $$;
revoke execute on function perform_coach_undo(uuid, boolean) from public, anon;
grant execute on function perform_coach_undo(uuid, boolean) to authenticated, service_role;
