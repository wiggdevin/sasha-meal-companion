-- Rollback of 20261023092000_client_timings_attach_step.
--
-- Drops the widened constraint and re-creates 20261022090100_coach_intent_telemetry's version,
-- without 'attach'. Existing `attach` telemetry rows must be deleted before narrowing the check,
-- or this migration fails on the check violation (the up migration's own comment says the same).

delete from client_timings where step = 'attach';

alter table client_timings drop constraint if exists client_timings_step_check;

alter table client_timings add constraint client_timings_step_check
  check (step in ('decode','lookup','sign','upload','propose','model',
                  'ground','confirm-shown','commit','card-visible',
                  'dictation','sent','first-text','reply-done','action-applied',
                  'action-failed','action-undone'));
