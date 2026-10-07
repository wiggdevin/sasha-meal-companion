-- Second step of 20261225090000: validates the NOT VALID check added there. A live table only
-- ever holds 'sprout' today, so the scan is free; VALIDATE CONSTRAINT takes SHARE UPDATE
-- EXCLUSIVE only (reads and writes continue), same discipline as 20261220090100 /
-- 20261224090100. Down: supabase/migrations/down/20261225090010_user_settings_mascot_validate.down.sql.
set local lock_timeout = '3s';
set local statement_timeout = '120s';

alter table public.user_settings validate constraint user_settings_mascot_check;
