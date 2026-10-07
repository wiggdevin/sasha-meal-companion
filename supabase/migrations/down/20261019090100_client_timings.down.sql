-- Rollback of 20261019090100_client_timings.
--
-- The table holds measurements and nothing she typed, so dropping it loses a p95 table and
-- nothing else. Identity, ai_calls and every other table this migration never touched stay put.

drop policy if exists client_timings_insert on client_timings;
drop index if exists client_timings_run;
drop index if exists client_timings_path_at;
drop table if exists client_timings;
