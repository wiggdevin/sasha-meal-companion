-- Undo 20261210090200_log_entries_occasion: the index, the move trigger, its function and the two
-- additive columns. Stamped occasions are derived data; dropping them loses nothing a log needs.
drop index if exists log_entries_occasion_window;
drop trigger if exists log_entries_occasion_on_move on log_entries;
drop function if exists public.log_entries_occasion_on_move();
alter table log_entries drop constraint if exists log_entries_occasion_pair;
alter table log_entries drop column if exists occasion_source, drop column if exists occasion;
