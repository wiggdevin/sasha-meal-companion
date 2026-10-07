-- Reverse of 20261216090200_coach_undo_record_mode_validate.sql: record_mode goes back to nullable,
-- still checked by the (now validated) constraint. Harmless to run alone.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public'
              and table_name = 'coach_action_undos' and column_name = 'record_mode') then
    alter table public.coach_action_undos alter column record_mode drop not null;
  end if;
end $$;
