-- Undo T6 §1. Drops only what the up file created; coach_threads itself is untouched.
alter table coach_threads drop constraint if exists coach_threads_summary_len;
alter table coach_threads drop column if exists summary;
