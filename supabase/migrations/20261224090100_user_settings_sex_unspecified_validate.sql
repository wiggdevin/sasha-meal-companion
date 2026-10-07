-- Step 3: validate the check step 2 (20261224090000) added NOT VALID. VALIDATE CONSTRAINT takes
-- SHARE UPDATE EXCLUSIVE (reads and writes continue) for one scan of user_settings.
-- Before production: `select count(*) from user_settings where sex is not null
-- and sex not in ('female', 'male', 'unspecified')` must be 0 (always true today; no caller
-- writes anything else).
set local lock_timeout = '3s';
set local statement_timeout = '120s';

alter table public.user_settings validate constraint user_settings_sex_check;
