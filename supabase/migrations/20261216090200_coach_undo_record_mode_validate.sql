-- Coach Undo receipts v1, deploy step 2b: validate step 2a's checks (SHARE UPDATE EXCLUSIVE, reads
-- and writes continue during the scan), then SET NOT NULL on record_mode, which PostgreSQL proves
-- from the validated check without a second scan.
-- Down: supabase/migrations/down/20261216090200_coach_undo_record_mode_validate.down.sql.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

alter table public.coach_action_undos validate constraint coach_action_undos_record_mode;
alter table public.coach_action_undos validate constraint coach_action_undos_source;
alter table public.coach_action_undos validate constraint coach_action_undos_source_check;
alter table public.coach_action_undos validate constraint coach_action_undos_mode_shape;
alter table public.coach_action_undos alter column record_mode set not null;
