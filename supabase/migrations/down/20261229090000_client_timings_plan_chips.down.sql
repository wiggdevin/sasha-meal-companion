-- Down for 20261229090000_client_timings_plan_chips. Keeps every telemetry row: the narrower
-- checks come back NOT VALID, so rows already stored under a `plan-chip:*` path or the `server`
-- step stay, and only new inserts are held to the old vocabulary. A later re-up replaces both
-- checks again.

alter table client_timings drop constraint if exists client_timings_path_check;
alter table client_timings add constraint client_timings_path_check
  check (path in ('barcode','label','photo','voice','text','search-log',
                  'meal-log','coach-turn','coach-action')) not valid;

alter table client_timings drop constraint if exists client_timings_step_check;
alter table client_timings add constraint client_timings_step_check
  check (step in ('decode','lookup','sign','upload','propose','model',
                  'ground','confirm-shown','commit','card-visible',
                  'dictation','attach','sent','first-text','reply-done','action-applied',
                  'action-failed','action-undone')) not valid;
