-- W070, file 3 of 4: validate the two client_timings checks file 2 re-added NOT VALID. VALIDATE
-- takes a SHARE UPDATE EXCLUSIVE lock, so inserts keep landing while it scans. Every stored row
-- already passed the same lists, so this cannot fail on data the checks let in.
-- Order: after 20270105140100, either side of the deploy.
-- Down: supabase/migrations/down/20270105140200_client_timings_checks_validate.down.sql.
set local lock_timeout = '3s';
set local statement_timeout = '120s';

alter table public.client_timings validate constraint client_timings_path_check;
alter table public.client_timings validate constraint client_timings_step_check;
