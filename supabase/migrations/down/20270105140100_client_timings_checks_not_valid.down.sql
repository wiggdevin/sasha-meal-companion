-- Reverse of 20270105140100_client_timings_checks_not_valid.sql: put the two checks back as
-- validated constraints (what 20261229090000 left). This scans the table; run it off-peak.
set local lock_timeout = '3s';
set local statement_timeout = '120s';

alter table public.client_timings
  drop constraint if exists client_timings_path_check,
  add constraint client_timings_path_check
    check (path in ('barcode','label','photo','voice','text','search-log',
                    'meal-log','coach-turn','coach-action',
                    'plan-chip:choose','plan-chip:protein','plan-chip:quick15','plan-chip:light',
                    'plan-chip:on_hand','plan-chip:surprise')),
  drop constraint if exists client_timings_step_check,
  add constraint client_timings_step_check
    check (step in ('decode','lookup','sign','upload','propose','model',
                    'ground','confirm-shown','commit','card-visible',
                    'dictation','attach','sent','first-text','reply-done','action-applied',
                    'action-failed','action-undone','server'));
