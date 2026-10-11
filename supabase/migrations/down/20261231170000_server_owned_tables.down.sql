-- Down for 20261231170000_server_owned_tables.
--
-- It puts back only what an older app build needs to run: the coach_messages owner policy and its
-- update grant, because builds before W018 write assistant rows and the sanity write-back with the
-- session client. It deliberately does NOT re-grant insert, update or delete on target_profiles,
-- change_log, change_seq, health_sources or user_settings (the same rule as 20261228090000's
-- down): no app build ever wrote those tables with the session client, and those grants are the
-- hole the up file closes. The coach_threads guard keeps its early return: it changes no answer for
-- the account's own inserts.
set local lock_timeout = '3s';

drop policy if exists coach_messages_select on public.coach_messages;
drop policy if exists coach_messages_insert_user on public.coach_messages;
drop policy if exists coach_messages_delete on public.coach_messages;
drop policy if exists coach_messages_rw on public.coach_messages;
create policy coach_messages_rw on public.coach_messages for all to authenticated
  using (user_id = (select auth.uid())
         and exists (select 1 from public.coach_threads th
                      where th.id = coach_messages.thread_id and th.user_id = (select auth.uid())))
  with check (user_id = (select auth.uid())
         and exists (select 1 from public.coach_threads th
                      where th.id = coach_messages.thread_id and th.user_id = (select auth.uid())));
grant select, insert, update, delete on table public.coach_messages to authenticated;
