-- Rollback of 20261126090000_coach_conversations.
--
-- Restores the prior constraint, policy and schema exactly:
-- - coach_threads_kind_check back to 20261001000000_phase7_coach's inline column check
--   (kind in ('chat','weekly_review')) — drops 'plan'. Any thread with kind = 'plan' must be
--   deleted or recategorized before this migration, or the check add fails.
-- - the four split RLS policies (select/insert/update/delete) replaced by the single
--   pattern-1 owner policy coach_threads_rw (20260911000500_rls.sql).
-- - the chat-cap insert guard trigger and function removed.
-- - the full-text search index removed.

delete from public.coach_threads where kind = 'plan';

alter table public.coach_threads drop constraint if exists coach_threads_kind_check;
alter table public.coach_threads add constraint coach_threads_kind_check
  check (kind in ('chat', 'weekly_review'));

drop trigger if exists coach_chat_insert_guard on public.coach_threads;
drop function if exists public._coach_chat_insert_guard();

drop policy if exists coach_threads_select on public.coach_threads;
drop policy if exists coach_threads_insert on public.coach_threads;
drop policy if exists coach_threads_update on public.coach_threads;
drop policy if exists coach_threads_delete on public.coach_threads;
create policy coach_threads_rw on public.coach_threads for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop index if exists public.coach_messages_content_fts;
