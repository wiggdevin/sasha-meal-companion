-- Reverse of 20261217120300_job_cursors.sql. Safe at any time: without the function every job's
-- claim fails (logged) and the run walks the whole listing, and the per-user job_runs locks skip
-- whoever is done. Deploy the code that stops calling it first if the log noise matters.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

drop function if exists public.claim_job_cursor(text, text, uuid, integer, boolean);
drop table if exists public.job_cursors;
