-- Phase 18 W5b-2, step 3: validate the two checks step 2 (20261220090100) added NOT VALID.
-- VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE (reads and writes continue) for one scan of
-- coach_action_undos. Before production: `select count(*) from coach_action_undos
-- where kind = 'confirm_taste_chips' or record_mode not in ('legacy', 'receipt_v1')` must be 0.
set local lock_timeout = '3s';
set local statement_timeout = '120s';

alter table public.coach_action_undos validate constraint coach_action_undos_record_mode;
alter table public.coach_action_undos validate constraint coach_action_undos_taste_mode;
