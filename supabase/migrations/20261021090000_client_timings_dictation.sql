-- T7 §1 (docs/plans/2026-09-18-t7-coach-voice.md): the coach's spoken turn has one hop the typed
-- turn does not — `dictation`, from the press on the mic to the final transcript. It joins the
-- `coach-turn` run alongside `sent`, `first-text` and `reply-done`, so one spoken turn is still
-- one run_id.
--
-- The step check is a list, so widening it means replacing it. Nothing else about the table moves.

alter table client_timings drop constraint if exists client_timings_step_check;

alter table client_timings add constraint client_timings_step_check
  check (step in ('decode','lookup','sign','upload','propose','model',
                  'ground','confirm-shown','commit','card-visible',
                  'dictation','sent','first-text','reply-done','action-applied'));
