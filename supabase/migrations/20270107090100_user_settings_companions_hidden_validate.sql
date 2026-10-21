-- Second step of 20270107090000: validates the NOT VALID check added there. A live table only
-- holds the '{}' default at that point, so the scan is cheap; VALIDATE CONSTRAINT takes SHARE UPDATE
-- EXCLUSIVE only (reads and writes continue), the discipline of 20261225090010.
-- Down: supabase/migrations/down/20270107090100_user_settings_companions_hidden_validate.down.sql.
set local lock_timeout = '3s';
set local statement_timeout = '120s';

alter table public.user_settings validate constraint user_settings_companions_hidden_check;
