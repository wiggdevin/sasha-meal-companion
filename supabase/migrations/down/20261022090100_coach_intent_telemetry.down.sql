alter table client_timings drop constraint if exists client_timings_step_check;
alter table client_timings add constraint client_timings_step_check
  check (step in ('decode','lookup','sign','upload','propose','model',
                  'ground','confirm-shown','commit','card-visible',
                  'dictation','sent','first-text','reply-done','action-applied'));

drop table if exists coach_intent_events;
