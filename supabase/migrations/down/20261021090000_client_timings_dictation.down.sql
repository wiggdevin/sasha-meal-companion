-- Back to the T0 §1 vocabulary: `dictation` is no longer an accepted step.
--
-- Rows already carrying it would fail the narrower constraint, so they go first. They are
-- telemetry — a p95 the report can recompute from the next spoken turn — and losing them is the
-- price of undoing the migration that allowed them.

delete from client_timings where step = 'dictation';

alter table client_timings drop constraint if exists client_timings_step_check;

alter table client_timings add constraint client_timings_step_check
  check (step in ('decode','lookup','sign','upload','propose','model',
                  'ground','confirm-shown','commit','card-visible',
                  'sent','first-text','reply-done','action-applied'));
