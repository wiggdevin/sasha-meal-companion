-- Reverse of 20270105110000_sync_op_receipts.sql: apply_sync_op reads change_log for a replay
-- again, then the trigger, its function and the table go. Run it only while every receipt still
-- has its change_log row (no compaction has run): a receipt is the only record of a pruned op.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

do $migration$
declare
  definition text;
  patched text := $a$  if exists (select 1 from public.sync_op_receipts where op_id = v_op_id) then$a$;
  original text := $a$  if exists (select 1 from change_log where op_id = v_op_id) then$a$;
begin
  select pg_get_functiondef('public.apply_sync_op(uuid,jsonb)'::regprocedure) into definition;
  if position(patched in definition) = 0 then return; end if;
  if (length(definition) - length(replace(definition, patched, ''))) / length(patched) <> 1 then
    raise exception 'sync_op_receipts down (apply_sync_op): the patched replay check is not as written; refusing a guess';
  end if;
  execute replace(definition, patched, original);
end;
$migration$;
revoke execute on function public.apply_sync_op(uuid, jsonb) from public, anon;
grant execute on function public.apply_sync_op(uuid, jsonb) to authenticated, service_role;

drop trigger if exists change_log_op_receipt on public.change_log;
drop function if exists public._sync_op_receipt();
drop table if exists public.sync_op_receipts;
