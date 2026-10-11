-- W026 (backlog B234, audit 2026-10-10 F15): a conflict answer says WHEN the server's row was
-- written. apply_sync_op's 'conflict' carried the row and its rev but no time of its own, and the
-- synced tables name "when" three ways (updated_at, changed_at, eaten_at) or not at all, so the
-- phone's merge (lib/sync/outbox-conflict.ts serverTimestampOf) fell back to "now" for water_log,
-- gut_log and log_items: the server won every field, even one the user changed after the server's
-- write.
--
-- Both conflict answers now carry `at`: the time of the row's last change_log entry, or its own
-- `updated_at` when that is later (a row written outside the sync path); now() only when neither
-- exists, which keeps the old tie rule (the server's row was written after the op's base).
--
-- Patches only the two conflict answers of apply_sync_op by anchor (the 20261230090400 pattern),
-- refusing a partial or ambiguous patch; the compare-and-swap, the advisory lock, the op_id
-- replay and every other answer are byte-identical. Additive: an older phone ignores the key.
-- Live-safe: CREATE FUNCTION and CREATE OR REPLACE FUNCTION take no table lock.
-- Order: apply to production BEFORE the W026 code merges (the code reads `at` when present and
-- falls back without it, so either order works; before is the rule).
-- Down: supabase/migrations/down/20261231180000_sync_conflict_at.down.sql.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

-- When the server's current row was written: its last change_log time, or its updated_at when
-- later, or now() when neither is known. A non-string updated_at is never cast.
create or replace function public._sync_written_at(p_user_id uuid, p_entity text, p_key text,
  p_current jsonb)
returns timestamptz
language sql stable
set search_path = public, pg_temp
as $fn$
  select coalesce(greatest(
    (select c.at from public.change_log c
      where c.user_id = p_user_id and c.entity = p_entity and c.entity_key = p_key
      order by c.seq desc limit 1),
    case when jsonb_typeof(p_current->'updated_at') = 'string'
         then (p_current->>'updated_at')::timestamptz end), now())
$fn$;
revoke all on function public._sync_written_at(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public._sync_written_at(uuid, text, text, jsonb) to service_role;
comment on function public._sync_written_at(uuid, text, text, jsonb) is
  'W026: when a synced row was last written (its last change_log time, or updated_at when later). '
  'apply_sync_op answers it as `at` on a conflict.';

do $migration$
declare
  definition text;
  anchor text := $a$      return jsonb_build_object('op_id', v_op_id, 'status', 'conflict', 'entity', v_entity,
                                'current_rev', (v_current->>'rev')::integer, 'current', v_current);$a$;
  patched text := $a$      return jsonb_build_object('op_id', v_op_id, 'status', 'conflict', 'entity', v_entity,
                                'current_rev', (v_current->>'rev')::integer, 'current', v_current,
                                'at', public._sync_written_at(p_user_id, v_entity, v_key, v_current));$a$;
  occurrences integer;
  done_count integer;
begin
  select pg_get_functiondef('public.apply_sync_op(uuid,jsonb)'::regprocedure) into definition;
  done_count := (length(definition) - length(replace(definition, patched, ''))) / length(patched);
  if done_count = 2 then return; end if;
  if done_count > 0 then
    raise exception 'sync_conflict_at (apply_sync_op): % of 2 conflict answers already patched; refusing a partial function',
      done_count;
  end if;
  occurrences := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if occurrences <> 2 then
    raise exception 'sync_conflict_at (apply_sync_op): conflict anchor occurs % times, expected twice', occurrences;
  end if;
  execute replace(definition, anchor, patched);
end;
$migration$;
revoke execute on function public.apply_sync_op(uuid, jsonb) from public, anon;
grant execute on function public.apply_sync_op(uuid, jsonb) to authenticated, service_role;
