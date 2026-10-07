-- Reverse of 20261220090100_coach_undo_taste_mode.sql (and of its validate step, which has nothing
-- of its own to undo). Refuses while any taste_v1 record exists: only the taste-aware
-- perform_coach_undo can undo one, and the old mode check would refuse the row.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

do $$
begin
  if exists (select 1 from public.coach_action_undos
              where record_mode = 'taste_v1' or kind = 'confirm_taste_chips') then
    raise exception 'coach_undo_taste_mode down: taste_v1 records exist';
  end if;
end $$;

-- perform_coach_undo as 20261216090400 left it.
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
  return _coach_undo_legacy(v_user, p_undo_id, p_local);
end; $$;
revoke execute on function public.perform_coach_undo(uuid, boolean) from public, anon;
grant execute on function public.perform_coach_undo(uuid, boolean) to authenticated, service_role;

drop function if exists public._coach_undo_taste(uuid, uuid);

do $migration$
declare
  definition text;
  froms text[] := array[
    $a$    if p_undone and v_row.record_mode <> 'legacy' then$a$,
    $a$    if v_row.kind = p_kind and v_row.record_mode <> 'legacy' then$a$,
    $a$  -- Phase 18 W5b-2: a confirmed taste-chip card is recorded only by taste_chips_confirm.
  if p_kind = 'confirm_taste_chips' then return jsonb_build_object('status', 'kind_mismatch'); end if;
  if p_source_message is not null then
    if p_kind not in ('log_meal', 'set_slot_meal', 'save_recipe') or p_source_card is null$a$];
  tos text[] := array[
    $a$    if p_undone and v_row.record_mode = 'receipt_v1' then$a$,
    $a$    if v_row.kind = p_kind and v_row.record_mode = 'receipt_v1' then$a$,
    $a$  if p_source_message is not null then
    if p_kind not in ('log_meal', 'set_slot_meal', 'save_recipe') or p_source_card is null$a$];
  done_count integer := 0;
  i integer;
begin
  select pg_get_functiondef(
    'public.record_coach_undo(text,text,jsonb,bigint,uuid,boolean,uuid,integer)'::regprocedure)
    into definition;
  -- Patched parts still present; none means already reversed (a no-op), some a partial function.
  for i in 1 .. array_length(froms, 1) loop
    if (length(definition) - length(replace(definition, froms[i], ''))) / length(froms[i]) = 1 then
      done_count := done_count + 1;
    end if;
  end loop;
  if done_count = 0 then return; end if;
  if done_count <> array_length(froms, 1) then
    raise exception 'coach_undo_taste_mode down (record_coach_undo): only % of % parts patched',
      done_count, array_length(froms, 1);
  end if;
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

alter table public.coach_action_undos drop constraint if exists coach_action_undos_taste_mode;
alter table public.coach_action_undos drop constraint coach_action_undos_record_mode;
alter table public.coach_action_undos add constraint coach_action_undos_record_mode
  check (record_mode is not null and record_mode in ('legacy', 'receipt_v1'));

comment on column public.coach_action_undos.record_mode is
  'Coach Undo path (docs/specs/coach-undo-receipt.md §4.1): legacy = today''s inverse; receipt_v1 = the one receipt. Immutable.';
