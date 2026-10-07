-- Drops only what 20261001000000_phase7_coach.sql created. The three tables stay:
-- Phase 4 reads constraint_profiles and Phase 0 owns all three.
drop index if exists coach_messages_thread;
alter table coach_messages drop constraint if exists coach_messages_thread_seq;
alter table coach_messages drop column if exists seq;
alter table coach_messages drop column if exists ai_call_id;
alter table coach_messages drop column if exists model_id;
alter table coach_messages drop column if exists deflected;
alter table coach_messages drop column if exists user_id;
alter table coach_messages alter column content drop not null;
alter table coach_messages alter column content drop default;
alter table coach_messages alter column tool_calls drop not null;
alter table coach_messages alter column tool_calls drop default;
alter table coach_messages alter column policy_checks drop not null;
alter table coach_messages alter column policy_checks drop default;

drop index if exists coach_threads_one_weekly;
drop index if exists coach_threads_user;
alter table coach_threads drop column if exists deleted_at;
alter table coach_threads drop column if exists last_message_at;
alter table coach_threads drop column if exists rev;
alter table coach_threads drop column if exists kind;

alter table constraint_profiles drop column if exists updated_at;
