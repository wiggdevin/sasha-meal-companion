-- Reverse of 20261225090500_care_log_growth.sql: one function, no data to lose.
drop function if exists public.care_log_grew(uuid, uuid, text);
