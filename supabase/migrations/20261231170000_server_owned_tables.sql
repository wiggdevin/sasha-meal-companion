-- W018 (audit 2026-10-10 F19: A068, A097, A120, A146, A147, A148, P16, P17; backlog B100).
-- Lock down tables the server owns from direct PostgREST writes by a signed-in user.
--
-- Phase 0's pattern-1 loop (20260911000500_rls.sql) gave each owner table a `for all` policy and
-- select, insert, update and delete to `authenticated`. For the tables below that was never the
-- write path: every app writer is the service-role client or a SECURITY DEFINER function owned by
-- the migration role, and neither is affected by these grants.
--
--   target_profiles  write_target_revision* / approve_target_proposal (service role only since
--                    20261228090000). A direct insert skipped every floor and pace hold (A068, A097).
--   change_log       apply_sync_op, write_target_revision, recipe_*_consumed, save_food_note,
--   change_seq       _taste_chips_write, next_change_seq: all SECURITY DEFINER. A forged feed row
--                    reached every device; a lowered next_seq broke sync for the account (A148).
--   health_sources   the admin client (token issuance, Oura) and health_weigh_in (DEFINER). A direct
--                    write could mint or un-revoke an ingest token (P17).
--   user_settings    apply_sync_op/_sync_upsert, taste_*, shopping_focus_*, the day-mark trigger,
--                    the condition gate (all DEFINER) and the admin client (food world). Direct
--                    update rewound day_marks_started_on (A120); delete and re-insert reset every
--                    server-owned marker (A147).
--   coach_messages   the user's own row is still written with the session client (RLS proves the
--                    thread is the caller's); every assistant row and its sanity write-back go through the
--                    service role, so a stored assistant message is proof the server wrote it (P16).
-- health_samples has been select-only since 20260925000000 (B100's remaining path is closed there).
--
-- ORDER: apply AFTER the code that writes assistant coach rows with the service role is live
-- (PR "fix: W018 ..."). The old build writes assistant rows with the session client and would fail
-- every coach turn once this runs. Every other table here already had no session-client writer.
set local lock_timeout = '3s';

-- ---------- 1. select-only tables -----------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['target_profiles', 'change_log', 'change_seq', 'health_sources',
                           'user_settings']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_rw', t);
    execute format('drop policy if exists %I on public.%I', t || '_ro', t);
    execute format($f$create policy %I on public.%I for select to authenticated
      using (user_id = (select auth.uid()))$f$, t || '_ro', t);
    execute format('revoke insert, update, delete, truncate on table public.%I from anon, authenticated', t);
    execute format('grant select on table public.%I to authenticated', t);
  end loop;
end $$;

-- ---------- 2. coach_messages: read and delete own rows; insert only the caller's own question ----
-- The user row of a turn carries `[]` or `{ "attachments": [...] }` as tool_calls; nothing a
-- server check reads (actions, composed, tasteChips, blocks, provenance) may come from the user.
drop policy if exists coach_messages_rw on public.coach_messages;
drop policy if exists coach_messages_select on public.coach_messages;
drop policy if exists coach_messages_insert_user on public.coach_messages;
drop policy if exists coach_messages_delete on public.coach_messages;
create policy coach_messages_select on public.coach_messages for select to authenticated
  using (user_id = (select auth.uid())
         and exists (select 1 from public.coach_threads th
                      where th.id = coach_messages.thread_id and th.user_id = (select auth.uid())));
create policy coach_messages_insert_user on public.coach_messages for insert to authenticated
  with check (user_id = (select auth.uid())
         and role = 'user'
         and model_id is null and ai_call_id is null
         and (tool_calls is null
              or tool_calls = '[]'::jsonb
              or (jsonb_typeof(tool_calls) = 'object' and (tool_calls - 'attachments') = '{}'::jsonb))
         and exists (select 1 from public.coach_threads th
                      where th.id = coach_messages.thread_id and th.user_id = (select auth.uid())));
create policy coach_messages_delete on public.coach_messages for delete to authenticated
  using (user_id = (select auth.uid())
         and exists (select 1 from public.coach_threads th
                      where th.id = coach_messages.thread_id and th.user_id = (select auth.uid())));
revoke update, truncate on table public.coach_messages from anon, authenticated;
grant select, insert, delete on table public.coach_messages to authenticated;

-- ---------- 3. coach_threads: the cap guard answers only for the caller's own account -------------
-- SECURITY DEFINER and BEFORE INSERT, it ran ahead of the RLS check: for another account's id it
-- took that account's advisory lock and answered coach_chat_limit or not, an oracle on that account's chat
-- count (A146). A signed-in caller inserting for another id now returns at once, so the RLS error
-- wins. The service role (no JWT subject) still runs the cap, as before.
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
  if auth.uid() is not null and new.user_id is distinct from auth.uid() then
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
revoke all on function public._coach_chat_insert_guard() from public, anon, authenticated;
