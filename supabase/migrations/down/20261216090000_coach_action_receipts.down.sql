-- Reverse of 20261216090000_coach_action_receipts.sql. Run it in one transaction (psql -1): it
-- first takes ACCESS EXCLUSIVE locks on coach_action_receipts and coach_action_undos (bounded by
-- the lock_timeout below), then refuses, with no override, while any
-- receipt exists or any coach_action_undos row is a receipt_v1 record: a receipt is the only thing
-- a receipt_v1 record can be undone from, so dropping the table would strand those records (PR A
-- review r1 WARN 3). Run 20261216090100's down file first. Spec §7 rollback 5 keeps this step in
-- production.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

do $$
declare
  v_records boolean := false;
begin
  -- Lock both tables before the checks, so no writer can add a receipt or a receipt_v1 record
  -- between the check and the drop (PR A review r2). The locks hold to the end of the transaction.
  if to_regclass('public.coach_action_receipts') is not null then
    lock table public.coach_action_receipts in access exclusive mode;
  end if;
  lock table public.coach_action_undos in access exclusive mode;
  if to_regclass('public.coach_action_receipts') is not null
     and exists (select 1 from public.coach_action_receipts) then
    raise exception 'coach_action_receipts down: receipts exist; keep the table (spec §7 rollback 5)';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public'
              and table_name = 'coach_action_undos' and column_name = 'record_mode') then
    -- Dynamic: the column may already be gone when this runs after 20261216090100's down file.
    execute 'select exists (select 1 from public.coach_action_undos where record_mode = ''receipt_v1'')'
      into v_records;
    if v_records then
      raise exception 'coach_action_receipts down: receipt_v1 records exist; keep the table (spec §7 rollback 5)';
    end if;
  end if;
end $$;

drop table if exists public.coach_action_receipts;
drop function if exists public._coach_action_receipts_immutable();
