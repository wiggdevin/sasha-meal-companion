-- Reverse of 20270105140200_client_timings_checks_validate.sql. Validation cannot be undone in
-- place, so put the checks back NOT VALID (what file 2 left), each in one statement.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

alter table public.client_timings
  drop constraint if exists client_timings_path_check,
  add constraint client_timings_path_check
    check (path in ('barcode','label','photo','voice','text','search-log',
                    'meal-log','coach-turn','coach-action',
                    'plan-chip:choose','plan-chip:protein','plan-chip:quick15','plan-chip:light',
                    'plan-chip:on_hand','plan-chip:surprise')) not valid,
  drop constraint if exists client_timings_step_check,
  add constraint client_timings_step_check
    check (step in ('decode','lookup','sign','upload','propose','model',
                    'ground','confirm-shown','commit','card-visible',
                    'dictation','attach','sent','first-text','reply-done','action-applied',
                    'action-failed','action-undone','server')) not valid;
