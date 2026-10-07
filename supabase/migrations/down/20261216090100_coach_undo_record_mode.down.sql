-- Reverse of 20261216090100_coach_undo_record_mode.sql. Refuses while any receipt_v1 record exists:
-- dropping record_mode would turn it into a legacy record whose empty inverse today's bodies would
-- read. Run the down files of 20261216090400, 20261216090300 and 20261216090200 first (their
-- functions name these columns). Spec §7 rollback 5 keeps this step in production.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public'
              and table_name = 'coach_action_undos' and column_name = 'record_mode')
     and exists (select 1 from public.coach_action_undos where record_mode = 'receipt_v1') then
    raise exception 'coach_undo_record_mode down: receipt_v1 records exist; keep record_mode (spec §7 rollback 5)';
  end if;
end $$;

drop trigger if exists coach_action_undos_mode_fixed on public.coach_action_undos;
drop function if exists public._coach_action_undos_mode_fixed();
alter table public.coach_action_undos
  drop constraint if exists coach_action_undos_mode_shape,
  drop constraint if exists coach_action_undos_source_check,
  drop constraint if exists coach_action_undos_source,
  drop constraint if exists coach_action_undos_record_mode,
  drop column if exists source_check,
  drop column if exists source,
  drop column if exists record_mode;
