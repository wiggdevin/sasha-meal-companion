-- UI-NEEDS SPROUT-CARE item 6 (coord.md 2026-10-07T04:15Z): "a confirmed 'log grew on the
-- current day' event the phone can listen to (operation id + kind + date), so Sprout cheers only
-- for a real new log, not a synced correction." lib/server/log.ts's commit path already writes
-- exactly this distinction to `change_log` (`op` is 'create' for a brand-new entry, 'update' for
-- an edit; `op_id` is the client's own deterministic id, `lib/log/contract.ts opIdFor`) -- this
-- migration reads that record rather than keeping a second copy of it.
--
-- `change_log` carries RLS "for all" for `authenticated` on its own `user_id` (20260911000500),
-- which is enough to keep a row to its own account but NOT enough to trust its `current` jsonb as
-- proof a log entry was really created: a client could, in principle, INSERT a row directly under
-- its own account with a fabricated `current` snapshot. `care_log_grew` never reads `current` for
-- the answer; it cross-checks the op's `entity_key` against a REAL, undeleted `log_entries` row
-- for the SAME account before saying anything grew.
--
-- Live-safe: one new function, no table changes.
-- Down: supabase/migrations/down/20261225090500_care_log_growth.down.sql.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

-- Answers `{opId, kind, localDate, grew}`: `kind`/`localDate` are null and `grew` is false when no
-- change_log row of this account names that op id for `log_entries`. `grew` is true only for a
-- 'create' op whose named entry really exists, is not soft-deleted, and whose `local_date` is the
-- account's own current local day in `p_zone`.
create function public.care_log_grew(p_user_id uuid, p_op_id uuid, p_zone text) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  v_change change_log%rowtype;
  v_local_date date;
  v_today date;
begin
  perform _sync_assert_caller(p_user_id);
  if p_op_id is null then raise exception 'op_id_required' using errcode = '22023'; end if;
  if p_zone is null or char_length(p_zone) = 0 or char_length(p_zone) > 64 then
    raise exception 'zone_required' using errcode = '22023';
  end if;

  select * into v_change from change_log
   where user_id = p_user_id and op_id = p_op_id and entity = 'log_entries';
  if v_change.user_id is null then
    return jsonb_build_object('opId', p_op_id, 'kind', null, 'localDate', null, 'grew', false);
  end if;

  -- The real row's own local_date, never change_log's `current` snapshot: a client that inserted
  -- a change_log row directly (its own RLS "for all" allows that, 20260911000500) could fabricate
  -- `current`, but not a log_entries row that does not exist. `entity_key` is plain text (not a
  -- uuid column) and that same direct insert could write a non-uuid value; guard the cast rather
  -- than let a malformed key raise 22P02 back to the caller -- it only ever hurts the caller's own
  -- account, but "no log_entries row names this op" should still answer `grew: false`, not 500.
  if v_change.entity_key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    select local_date into v_local_date from log_entries
     where id = v_change.entity_key::uuid and user_id = p_user_id and deleted_at is null;
  end if;
  v_today := (now() at time zone p_zone)::date;

  return jsonb_build_object('opId', p_op_id, 'kind', v_change.op, 'localDate', v_local_date,
    'grew', v_change.op = 'create' and v_local_date is not null and v_local_date = v_today);
end $$;
revoke all on function public.care_log_grew(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.care_log_grew(uuid, uuid, text) to authenticated, service_role;
