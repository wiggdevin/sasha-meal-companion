-- Attachment coach turns start at `attach`, while typed turns start at `sent`. Keep the database
-- constraint equal to lib/timing.ts so an attachment mark is never rejected by telemetry storage.

alter table client_timings drop constraint if exists client_timings_step_check;

alter table client_timings add constraint client_timings_step_check
  check (step in ('decode','lookup','sign','upload','propose','model',
                  'ground','confirm-shown','commit','card-visible',
                  'dictation','attach','sent','first-text','reply-done','action-applied',
                  'action-failed','action-undone'));

-- Down (house rollback vocabulary): drop the constraint above, then recreate it without `attach`:
-- 'decode','lookup','sign','upload','propose','model','ground','confirm-shown','commit',
-- 'card-visible','dictation','sent','first-text','reply-done','action-applied','action-failed',
-- 'action-undone'. Existing `attach` telemetry rows must be deleted before narrowing the check.
