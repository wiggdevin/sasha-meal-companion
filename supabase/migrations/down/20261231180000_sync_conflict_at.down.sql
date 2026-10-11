-- Reverse of 20261231180000_sync_conflict_at.sql: the two conflict answers of apply_sync_op lose
-- `at` first, then the helper they called. No data changes either way; a phone that reads `at`
-- falls back to the row's own columns without it.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

do $migration$
declare
  definition text;
  patched text := $a$      return jsonb_build_object('op_id', v_op_id, 'status', 'conflict', 'entity', v_entity,
                                'current_rev', (v_current->>'rev')::integer, 'current', v_current,
                                'at', public._sync_written_at(p_user_id, v_entity, v_key, v_current));$a$;
  original text := $a$      return jsonb_build_object('op_id', v_op_id, 'status', 'conflict', 'entity', v_entity,
                                'current_rev', (v_current->>'rev')::integer, 'current', v_current);$a$;
begin
  select pg_get_functiondef('public.apply_sync_op(uuid,jsonb)'::regprocedure) into definition;
  if position('_sync_written_at' in definition) = 0 then return; end if;
  if (length(definition) - length(replace(definition, patched, ''))) / length(patched) <> 2 then
    raise exception 'sync_conflict_at down (apply_sync_op): the patched conflict answers are not as written; refusing a guess';
  end if;
  execute replace(definition, patched, original);
end;
$migration$;
revoke execute on function public.apply_sync_op(uuid, jsonb) from public, anon;
grant execute on function public.apply_sync_op(uuid, jsonb) to authenticated, service_role;

drop function if exists public._sync_written_at(uuid, text, text, jsonb);
