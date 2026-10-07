-- T6 §1: the thread remembers.
--
-- One column. A coach turn sends the last twelve messages verbatim plus this rolling summary, so
-- a reload, a new device or a thread that has outgrown the window continues with the same memory.
-- The model writes it itself, in the final envelope's `memory` field; there is no second model
-- call and no background job.
--
-- Nullable, and never backfilled: a thread that has not produced a summary yet simply sends its
-- messages, which is exactly what every thread did before this migration.

alter table coach_threads add column if not exists summary text;

alter table coach_threads drop constraint if exists coach_threads_summary_len;
alter table coach_threads add constraint coach_threads_summary_len
  check (summary is null or char_length(summary) <= 600);
