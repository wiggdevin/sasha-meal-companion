-- Reverse of 20261216090300_coach_undo_legacy_guards.sql: record_coach_undo and perform_coach_undo
-- go back to their 20261210090300 bodies (legacy save_recipe server Undo returns).
--
-- Those bodies do not know record_mode, so this file refuses while ANY receipt_v1 record exists,
-- expired or not (spec §7 rollback 4: never restore the unguarded body over a receipt record).
-- In practice it is only for a rollback before PR B (the writer) ever ran.
-- Run 20261216090400's down file first.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

do $$
begin
  if exists (select 1 from public.coach_action_undos where record_mode = 'receipt_v1') then
    raise exception 'coach_undo_legacy_guards down: receipt_v1 records exist; the unguarded bodies must never return (spec §7 rollback 4)';
  end if;
  if to_regprocedure('public._coach_undo_legacy(uuid, uuid, boolean)') is not null then
    raise exception 'coach_undo_legacy_guards down: run 20261216090400''s down file first';
  end if;
end $$;

create or replace function record_coach_undo(p_action_id text, p_kind text, p_inverse jsonb,
  p_expected_rev bigint, p_thread_id uuid, p_undone boolean,
  p_source_message uuid default null, p_source_card integer default null) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_row coach_action_undos%rowtype;
  v_message_id uuid;
  v_thread_id uuid;
  v_action jsonb;
  v_card jsonb;
  v_first_slot text;
  v_slots text[];
  v_bind jsonb := '{}'::jsonb;
  v_field text;
  v_required text[];
  v_instant timestamptz;
begin
  if v_user is null then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_row from coach_action_undos
   where user_id = v_user and action_id = p_action_id for update;
  if found then
    if v_row.kind <> p_kind then return jsonb_build_object('status', 'kind_mismatch'); end if;
    if p_undone and v_row.undone_at is null then
      update coach_action_undos set undone_at = now() where id = v_row.id returning * into v_row;
    end if;
    return jsonb_build_object('status', 'ok', 'row', to_jsonb(v_row));
  end if;

  if p_source_message is not null then
    if p_kind not in ('log_meal', 'set_slot_meal', 'save_recipe') or p_source_card is null
       or p_source_card < 0 then
      return jsonb_build_object('status', 'kind_mismatch');
    end if;
    select m.id, m.thread_id, m.tool_calls->'composed'->p_source_card
      into v_message_id, v_thread_id, v_card
      from coach_messages m
     where m.id = p_source_message and m.user_id = v_user
       and (p_thread_id is null or m.thread_id = p_thread_id)
       and jsonb_typeof(m.tool_calls->'composed') = 'array'
       and jsonb_array_length(m.tool_calls->'composed') > p_source_card;
    if v_message_id is null then return jsonb_build_object('status', 'unknown_action'); end if;
    -- A card with no foods renders nothing, so it offers no button (review t4r7 #5).
    if jsonb_typeof(v_card->'items') is distinct from 'array' or jsonb_array_length(v_card->'items') = 0 then
      return jsonb_build_object('status', 'kind_mismatch');
    end if;
    -- The buttons this card offers (lib/coach/composed-buttons.ts, the card's own rule): Log it
    -- (a snack now) and Save as recipe always; Put it in <slot> only for the slots it offers.
    if p_kind = 'log_meal' then
      -- "Log it" logs a snack at the tap: the entry's local date and its exact instant, as the
      -- phone recorded them, bind it (review t4r9 #1, #2). The instant must be plausible on the
      -- server's clock — not in the future, and no older than the record's own seven-day lifetime
      -- (review t4r10 #6), so a tap recorded offline stays recordable as long as it is undoable.
      v_instant := _coach_undo_instant(p_inverse->>'eatenAt');
      if coalesce(p_inverse->>'date', '') !~ '^\d{4}-\d{2}-\d{2}$' or v_instant is null
         or v_instant > now() + interval '5 minutes' or v_instant < now() - interval '7 days' then
        return jsonb_build_object('status', 'target_mismatch');
      end if;
      v_bind := jsonb_build_object('slot', 'snack', 'items', _coach_undo_items(v_card->'items'),
        'date', p_inverse->>'date', 'eatenAt', v_instant);
    elsif p_kind = 'save_recipe' then
      v_bind := jsonb_build_object('name', left(coalesce(v_card->>'wish', ''), 80));
    else
      v_first_slot := coalesce(v_card->>'slot', v_card->'pendingSlots'->0->>'slot');
      if v_first_slot is null then return jsonb_build_object('status', 'kind_mismatch'); end if;
      v_slots := array[v_first_slot];
      if jsonb_typeof(v_card->'pendingSlots') = 'array'
         and jsonb_array_length(v_card->'pendingSlots') > 1 then
        v_slots := v_slots || array(select e->>'slot' from jsonb_array_elements(v_card->'pendingSlots') e);
      end if;
      if p_inverse->>'slot' is null or not (p_inverse->>'slot' = any(v_slots)) then
        return jsonb_build_object('status', 'target_mismatch');
      end if;
      v_bind := jsonb_build_object('slot', p_inverse->>'slot');
    end if;
  else
    select m.id, m.thread_id,
           (select a from jsonb_array_elements(m.tool_calls->'actions') a
             where a->>'actionId' = p_action_id limit 1)
      into v_message_id, v_thread_id, v_action
      from coach_messages m
     where m.user_id = v_user
       and m.tool_calls @> jsonb_build_object('actions',
             jsonb_build_array(jsonb_build_object('actionId', p_action_id)))
       and (p_thread_id is null or m.thread_id = p_thread_id)
     limit 1;
    if v_message_id is null then return jsonb_build_object('status', 'unknown_action'); end if;
    if v_action->>'kind' is distinct from p_kind then
      return jsonb_build_object('status', 'kind_mismatch');
    end if;
    -- For every kind the server can undo, the fields that identify the target are REQUIRED in the
    -- token and must equal what the issued action names (review t4r6 #2); what the token cannot
    -- carry (a meal's slot, a recipe's name) is bound for perform_coach_undo to check.
    v_required := case
      when p_kind = 'log_meal' then array['date']
      when p_kind = 'log_water' then array['date']
      when p_kind in ('skip_slot', 'restore_slot') then array['date', 'slot']
      when p_kind in ('add_to_avoid', 'remove_from_avoid', 'add_to_eats', 'remove_from_eats')
        then array['name']
      else array[]::text[] end;
    -- Water: the amount is the issued action's own (review t4r8 #3), in the phone's whole cups
    -- (lib/water.ts wholeCups, 240 ml).
    if p_kind = 'log_water' and (jsonb_typeof(v_action->'ml') is distinct from 'number'
        or jsonb_typeof(p_inverse->'cups') is distinct from 'number'
        or (p_inverse->>'cups')::numeric <> round((v_action->>'ml')::numeric / 240)) then
      return jsonb_build_object('status', 'target_mismatch');
    end if;
    foreach v_field in array v_required loop
      -- A water log the coach issued for "today" names no date; then there is nothing to bind.
      continue when p_kind = 'log_water' and jsonb_typeof(v_action->v_field) is distinct from 'string';
      if p_inverse->>v_field is null or p_inverse->>v_field is distinct from v_action->>v_field then
        return jsonb_build_object('status', 'target_mismatch');
      end if;
    end loop;
    if p_kind = 'log_meal' then
      v_bind := jsonb_strip_nulls(jsonb_build_object('date', v_action->>'date', 'slot', v_action->>'slot',
        'items', _coach_undo_items(v_action->'items'),
        'eatenAt', _coach_undo_instant(p_inverse->>'eatenAt')));
    elsif p_kind = 'save_recipe' then
      v_bind := jsonb_strip_nulls(jsonb_build_object('name', v_action->>'name'));
    end if;
  end if;

  -- A racing record of the same action: its row is the record, and an undone mark is never lost
  -- (review t4r6 #4) — it closes the row, and nothing here ever reopens one.
  insert into coach_action_undos (user_id, thread_id, message_id, action_id, kind, inverse,
                                  expected_rev, bind, undone_at)
  values (v_user, v_thread_id, v_message_id, p_action_id, p_kind, p_inverse, p_expected_rev, v_bind,
          case when p_undone then now() end)
  on conflict (user_id, action_id) do update
     set undone_at = coalesce(coach_action_undos.undone_at, case when p_undone then now() end)
   where coach_action_undos.kind = p_kind
  returning * into v_row;
  if v_row.id is null then return jsonb_build_object('status', 'kind_mismatch'); end if;
  return jsonb_build_object('status', 'ok', 'row', to_jsonb(v_row));
end; $$;
revoke execute on function record_coach_undo(text, text, jsonb, bigint, uuid, boolean, uuid, integer)
  from public, anon;
grant execute on function record_coach_undo(text, text, jsonb, bigint, uuid, boolean, uuid, integer)
  to authenticated, service_role;

create or replace function perform_coach_undo(p_undo_id uuid, p_local boolean default false)
  returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_row coach_action_undos%rowtype;
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
  if v_user is null then raise exception 'forbidden' using errcode = '42501'; end if;
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

  v_inv := v_row.inverse;
  v_op_id := md5('coach-undo:' || v_row.id::text)::uuid;

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

  elsif v_row.kind = 'save_recipe' then
    if v_row.expected_rev is null or v_inv->>'recipeId' is null then
      raise exception 'undo_local_only' using errcode = 'P0001';
    end if;
    select rev, deleted_at, name into v_rev, v_deleted, v_name from recipes
     where user_id = v_user and id = (v_inv->>'recipeId')::uuid for update;
    if not found then raise exception 'undo_not_synced' using errcode = 'P0001'; end if;
    -- (An owner-forged token naming another of their own same-name recipes is a self-only edit,
    -- confined by RLS — accepted, review t4r11 #3 and the O2 ruling.)
    if v_name is distinct from v_row.bind->>'name' then
      raise exception 'undo_local_only' using errcode = 'P0001';
    end if;
    if v_deleted is not null or v_rev <> v_row.expected_rev then
      raise exception 'undo_conflict' using errcode = 'P0001';
    end if;
    v_result := apply_sync_op(v_user, jsonb_build_object('op_id', v_op_id, 'entity', 'recipes',
      'entity_id', v_inv->>'recipeId', 'kind', 'delete', 'base_rev', v_rev, 'payload', '{}'::jsonb,
      'client_ts', now()));

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

  if v_result->>'status' not in ('applied', 'duplicate') then
    raise exception 'undo_conflict' using errcode = 'P0001';
  end if;
  update coach_action_undos set undone_at = now() where id = v_row.id;
  return jsonb_build_object('status', 'undone', 'undone_at', now());
end; $$;
revoke execute on function perform_coach_undo(uuid, boolean) from public, anon;
grant execute on function perform_coach_undo(uuid, boolean) to authenticated, service_role;
