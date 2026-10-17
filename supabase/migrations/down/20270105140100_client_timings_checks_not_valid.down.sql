-- Reverse of 20270105140100_client_timings_checks_not_valid.sql: leave the two checks validated, as
-- 20261229090000 left them, with the same vocabularies.
--
-- Down files run in reverse order, so 20270105140200's down file runs first and puts both checks
-- back NOT VALID (a quick drop and re-add, no scan). This file is the second step: it only
-- validates them, in its own transaction, which takes SHARE UPDATE EXCLUSIVE for one scan, so
-- inserts keep flowing. Re-adding the checks here would hold ACCESS EXCLUSIVE for that whole scan
-- (Sol WARN on #192). Run on its own, against checks that are already validated, it changes
-- nothing.
set local lock_timeout = '3s';
set local statement_timeout = '120s';

alter table public.client_timings validate constraint client_timings_path_check;
alter table public.client_timings validate constraint client_timings_step_check;
