-- Plan-sheet chips answer in code (POST /api/plan/ideas, owner direction 2026-10-08). Each chip is
-- its own timing path, so `pnpm timings --path plan-chip:<chip>` reads p50/p95 per chip, and the
-- route's own build time is a server-reported `server` step. Keep both checks equal to
-- lib/timing.ts (tests/speed/client-timings-migration.test.ts). Live-safe: a check widened, no
-- data moved. Order: either side of the deploy; until it is applied, POST /api/timings answers
-- 202 and the insert of a new path or step is rejected (measurements lost, never a tap).

alter table client_timings drop constraint if exists client_timings_path_check;

alter table client_timings add constraint client_timings_path_check
  check (path in ('barcode','label','photo','voice','text','search-log',
                  'meal-log','coach-turn','coach-action',
                  'plan-chip:choose','plan-chip:protein','plan-chip:quick15','plan-chip:light',
                  'plan-chip:on_hand','plan-chip:surprise'));

alter table client_timings drop constraint if exists client_timings_step_check;

alter table client_timings add constraint client_timings_step_check
  check (step in ('decode','lookup','sign','upload','propose','model',
                  'ground','confirm-shown','commit','card-visible',
                  'dictation','attach','sent','first-text','reply-done','action-applied',
                  'action-failed','action-undone','server'));
