-- Reverse of 20261216090400_perform_coach_undo_receipts.sql: perform_coach_undo goes back to step
-- 3's body (20261216090300), which still refuses every receipt_v1 record — `local` with
-- undo_receipt_record, the server path with undo_receipt_inconsistent — so no function can read a
-- receipt record's `inverse` after this runs (spec §7 rollback 4). The two helpers are dropped.
--
-- Spec §7 rollback 3: run this only once
--   select count(*) from coach_action_undos where record_mode = 'receipt_v1' and expires_at > now();
-- returns 0. Until then the receipt-aware function is the only one that can undo those records, so
-- this file refuses while that count is above 0.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

do $$
begin
  if exists (select 1 from public.coach_action_undos
              where record_mode = 'receipt_v1' and expires_at > now()) then
    raise exception 'perform_coach_undo_receipts down: unexpired receipt_v1 records exist; keep the receipt-aware perform_coach_undo (spec §7 rollback 3)';
  end if;
end $$;

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
  -- Spec §4.5, §5 (review R2-1): this body never undoes or closes a receipt record. `local` would
  -- close it without a verified inverse; the server path needs the receipt-aware body (step 4).
  if v_row.record_mode = 'receipt_v1' then
    if p_local then raise exception 'undo_receipt_record' using errcode = 'P0001'; end if;
    raise exception 'undo_receipt_inconsistent' using errcode = 'P0001';
  end if;
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

  if v_result->>'status' not in ('applied', 'duplicate') then
    raise exception 'undo_conflict' using errcode = 'P0001';
  end if;
  update coach_action_undos set undone_at = now() where id = v_row.id;
  return jsonb_build_object('status', 'undone', 'undone_at', now());
end; $$;
revoke execute on function perform_coach_undo(uuid, boolean) from public, anon;
grant execute on function perform_coach_undo(uuid, boolean) to authenticated, service_role;

drop function if exists _coach_undo_receipt(uuid, uuid);
drop function if exists _coach_undo_legacy(uuid, uuid, boolean);
