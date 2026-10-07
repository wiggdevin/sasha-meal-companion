-- Phase 18 W5b-2, step 2: the coach Undo record of a confirmed taste-chip card points at its taste
-- receipt (20261220090000) and is undone from that receipt only.
--
--   * coach_action_undos.record_mode gains 'taste_v1': a `confirm_taste_chips` record, written only
--     by taste_chips_confirm in the confirm's own transaction (inverse '{}', no expected_rev; the
--     receipt is the taste_chip_receipts row with the same account and action id). A second check
--     ties the mode to the kind both ways. Both checks are added NOT VALID; step 3 (20261220090200)
--     validates them.
--   * perform_coach_undo sends a taste_v1 record to _coach_undo_taste, which runs the receipt Undo
--     (_taste_chips_undo_locked) under the same locks as taste_chips_undo and closes the record in
--     that transaction. `p_local` (the phone's own-token close) is refused with
--     `undo_receipt_record`, as for receipt_v1: no phone holds an inverse for it.
--   * record_coach_undo never records a `confirm_taste_chips` action (kind_mismatch) and never closes
--     a record that is not legacy (`p_undone` raises undo_receipt_record for taste_v1 as for
--     receipt_v1). Patched by exact anchors: every anchor must occur once; a run on a fully patched
--     function is a no-op; a partly patched one raises.
--
-- Live-safe: no taste_v1 record exists until the W5b-2 code ships. DROP/ADD CONSTRAINT and the
-- function replacements hold their locks for a catalog update only.
-- Down: supabase/migrations/down/20261220090100_coach_undo_taste_mode.down.sql (refuses while any
-- taste_v1 record exists).
set local lock_timeout = '3s';
set local statement_timeout = '30s';

alter table public.coach_action_undos drop constraint coach_action_undos_record_mode;
alter table public.coach_action_undos add constraint coach_action_undos_record_mode
  check (record_mode is not null and record_mode in ('legacy', 'receipt_v1', 'taste_v1')) not valid;
alter table public.coach_action_undos add constraint coach_action_undos_taste_mode
  check ((record_mode = 'taste_v1') = (kind = 'confirm_taste_chips')
         and (record_mode <> 'taste_v1' or (inverse = '{}'::jsonb and expected_rev is null))) not valid;

comment on column public.coach_action_undos.record_mode is
  'Coach Undo path: legacy = today''s inverse; receipt_v1 = the one coach_action_receipts row; taste_v1 = the taste_chip_receipts row of the same action (Phase 18 W5b-2). Immutable.';

do $migration$
declare
  definition text;
  froms text[] := array[
    $a$    if p_undone and v_row.record_mode = 'receipt_v1' then$a$,
    $a$    if v_row.kind = p_kind and v_row.record_mode = 'receipt_v1' then$a$,
    $a$  if p_source_message is not null then
    if p_kind not in ('log_meal', 'set_slot_meal', 'save_recipe') or p_source_card is null$a$];
  tos text[] := array[
    $a$    if p_undone and v_row.record_mode <> 'legacy' then$a$,
    $a$    if v_row.kind = p_kind and v_row.record_mode <> 'legacy' then$a$,
    $a$  -- Phase 18 W5b-2: a confirmed taste-chip card is recorded only by taste_chips_confirm.
  if p_kind = 'confirm_taste_chips' then return jsonb_build_object('status', 'kind_mismatch'); end if;
  if p_source_message is not null then
    if p_kind not in ('log_meal', 'set_slot_meal', 'save_recipe') or p_source_card is null$a$];
  done_count integer := 0;
  i integer;
  occurrences integer;
begin
  select pg_get_functiondef(
    'public.record_coach_undo(text,text,jsonb,bigint,uuid,boolean,uuid,integer)'::regprocedure)
    into definition;
  for i in 1 .. array_length(tos, 1) loop
    if (length(definition) - length(replace(definition, tos[i], ''))) / length(tos[i]) = 1 then
      done_count := done_count + 1;
    end if;
  end loop;
  if done_count = array_length(tos, 1) then return; end if;
  if done_count > 0 then
    raise exception 'coach_undo_taste_mode (record_coach_undo): % of % parts already patched; refusing a partial function',
      done_count, array_length(tos, 1);
  end if;
  for i in 1 .. array_length(froms, 1) loop
    occurrences := (length(definition) - length(replace(definition, froms[i], ''))) / length(froms[i]);
    if occurrences <> 1 then
      raise exception 'coach_undo_taste_mode (record_coach_undo): anchor % occurs % times, expected once',
        i, occurrences;
    end if;
  end loop;
  for i in 1 .. array_length(froms, 1) loop
    definition := replace(definition, froms[i], tos[i]);
  end loop;
  execute definition;
end;
$migration$;
revoke execute on function public.record_coach_undo(text, text, jsonb, bigint, uuid, boolean, uuid, integer)
  from public, anon;
grant execute on function public.record_coach_undo(text, text, jsonb, bigint, uuid, boolean, uuid, integer)
  to authenticated, service_role;

-- A taste_v1 record: the user_settings advisory lock first (the order taste_chips_confirm and
-- apply_sync_op take), then the record FOR UPDATE, then the receipt Undo, which closes the record.
create or replace function public._coach_undo_taste(p_user uuid, p_undo_id uuid) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  v_row coach_action_undos%rowtype;
  v_action uuid;
  v_result jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user::text || ':user_settings:settings', 0));
  select * into v_row from coach_action_undos where id = p_undo_id and user_id = p_user for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if v_row.record_mode is distinct from 'taste_v1' or v_row.kind <> 'confirm_taste_chips'
     or v_row.action_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'undo_receipt_inconsistent' using errcode = 'P0001';
  end if;
  if v_row.undone_at is not null then return jsonb_build_object('status', 'already_undone'); end if;
  if v_row.expires_at <= now() then return jsonb_build_object('status', 'expired'); end if;
  v_action := v_row.action_id::uuid;
  v_result := _taste_chips_undo_locked(p_user, v_action);
  if v_result->>'status' = 'undone' then
    return jsonb_build_object('status', 'undone', 'undone_at', v_result->'undone_at');
  end if;
  if v_result->>'status' = 'already_undone' then
    -- Undone through the taste route before this record was closed: close it now.
    update coach_action_undos set undone_at = now() where id = v_row.id;
    return jsonb_build_object('status', 'already_undone');
  end if;
  -- No receipt, or a row the receipt Undo could not read: nothing written.
  raise exception 'undo_receipt_inconsistent' using errcode = 'P0001';
end $$;
revoke all on function public._coach_undo_taste(uuid, uuid) from public, anon, authenticated, service_role;

-- Same signature, same answers: `{status: undone | not_found | already_undone | expired}` or a raise.
create or replace function public.perform_coach_undo(p_undo_id uuid, p_local boolean default false)
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
  if v_mode = 'taste_v1' then
    -- Phase 18 W5b-2: only the taste receipt's own Undo closes it.
    if p_local then raise exception 'undo_receipt_record' using errcode = 'P0001'; end if;
    return _coach_undo_taste(v_user, p_undo_id);
  end if;
  return _coach_undo_legacy(v_user, p_undo_id, p_local);
end; $$;
revoke execute on function public.perform_coach_undo(uuid, boolean) from public, anon;
grant execute on function public.perform_coach_undo(uuid, boolean) to authenticated, service_role;
