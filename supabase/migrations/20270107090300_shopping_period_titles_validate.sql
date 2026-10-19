-- Second step of 20270107090200: validates the NOT VALID title check. Every row holds null
-- until the W7 code writes titles, so the scan is cheap; VALIDATE CONSTRAINT takes SHARE UPDATE
-- EXCLUSIVE only (reads and writes continue).
-- Down: supabase/migrations/down/20270107090300_shopping_period_titles_validate.down.sql.
set local lock_timeout = '3s';
set local statement_timeout = '120s';

alter table public.shopping_periods validate constraint shopping_periods_title_check;
