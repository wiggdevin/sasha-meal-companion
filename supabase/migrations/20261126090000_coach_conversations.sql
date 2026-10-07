-- Eight saved Coach chats per account. PlanSheet's private working threads have their own kind.
-- Existing chats (including accounts already over eight) and every message stay untouched.
alter table public.coach_threads drop constraint if exists coach_threads_kind_check;
alter table public.coach_threads add constraint coach_threads_kind_check
  check (kind in ('chat', 'plan', 'weekly_review'));

-- One account's inserts serialize before counting; simultaneous ninth requests cannot both pass.
create or replace function public._coach_chat_insert_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.kind is distinct from old.kind then
      raise exception 'coach_thread_kind_fixed' using errcode = 'P0001';
    end if;
    if old.deleted_at is not null and new.deleted_at is null then
      raise exception 'coach_thread_restore_forbidden' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if new.kind = 'chat' and new.deleted_at is null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.user_id::text, 26090000));
    if (select count(*) from public.coach_threads
      where user_id = new.user_id and kind = 'chat' and deleted_at is null) >= 8 then
      raise exception 'coach_chat_limit' using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists coach_chat_insert_guard on public.coach_threads;
create trigger coach_chat_insert_guard before insert or update on public.coach_threads
  for each row execute function public._coach_chat_insert_guard();
revoke all on function public._coach_chat_insert_guard() from public, anon, authenticated;

-- Direct authenticated API writes cannot forge plan/weekly threads to bypass the chat cap.
-- Server-owned PlanSheet and weekly-review inserts use the service-role client.
drop policy if exists coach_threads_rw on public.coach_threads;
create policy coach_threads_select on public.coach_threads for select to authenticated
  using (user_id = (select auth.uid()));
create policy coach_threads_insert on public.coach_threads for insert to authenticated
  with check (user_id = (select auth.uid()) and kind = 'chat');
create policy coach_threads_update on public.coach_threads for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy coach_threads_delete on public.coach_threads for delete to authenticated
  using (user_id = (select auth.uid()));

-- Indexed search over the complete retained transcript; pagination remains seq-based.
create index if not exists coach_messages_content_fts
  on public.coach_messages using gin (pg_catalog.to_tsvector('english'::regconfig, content));
