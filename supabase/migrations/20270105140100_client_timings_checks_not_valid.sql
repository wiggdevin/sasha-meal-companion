-- W070, file 2 of 4: re-add the client_timings path and step checks NOT VALID.
--
-- Every earlier widening (20261021090000, 20261023092000, 20261229090000) dropped and re-added a
-- check in a plain `add constraint`, which scans the whole table under an ACCESS EXCLUSIVE lock and
-- with no lock timeout. This file puts the same two checks back NOT VALID (new and changed rows only,
-- no scan) under a 3 s lock timeout; file 3 (20270105140200) validates them, which takes only a
-- SHARE UPDATE EXCLUSIVE lock, so inserts keep flowing. Future widenings follow the same two steps.
-- The vocabularies are unchanged and stay equal to lib/timing.ts
-- (tests/speed/client-timings-migration.test.ts).
--
-- Each check is dropped and re-added in one statement, so there is no window without it.
-- Live-safe; order: either side of the deploy.
-- Down: supabase/migrations/down/20270105140100_client_timings_checks_not_valid.down.sql.
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
