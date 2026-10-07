-- Phase 9 spec 3.2 for coach Undo records (PR #401): a coach_action_undos row must never point at
-- another account's coach thread or message. 20261210090300 created the table with two
-- non-cascading references (thread_id → coach_threads, message_id → coach_messages, both
-- ON DELETE SET NULL). Clients cannot write the table, and its one writer, record_coach_undo, takes
-- both from the caller's own message; but the repo's rule lives in the database for every writer
-- (20261103090100_same_owner_references.sql): one BEFORE INSERT OR UPDATE trigger, SECURITY
-- DEFINER with an empty search_path so it sees rows RLS hides, refusing with 42501 through
-- _refuse_cross_account. A null reference stays allowed (a deleted thread or message sets it null).
--
-- The referenced owners are already fixed: coach_threads.user_id by its owner_fixed trigger, and a
-- coach message's user_id by its own same_owner trigger (it must equal its thread's owner).
--
-- The trigger is named coach_action_undos_same_owner, not same_owner: the PR #241 production-order
-- check (tests/tenancy/pr241-production-order.test.ts) counts the triggers that migration left.
--
-- One DO block: lock the table against writes, refuse to apply over existing violating rows
-- (nothing is changed then), and install the trigger — atomic whether or not the runner wraps the
-- file in a transaction. Idempotent: create or replace, drop trigger if exists, then create.
-- Down: supabase/migrations/down/20261211090100_coach_action_undos_same_owner.down.sql.

create or replace function public._same_owner_coach_action_undos() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- "Exists and belongs to someone else", not "is not mine": both references are ON DELETE SET
  -- NULL, so while an account's threads and messages are deleted the cascade rewrites this row
  -- with one reference still naming a row the same statement already removed. The foreign keys
  -- refuse a reference to a row that does not exist.
  if new.thread_id is not null and exists (select 1 from public.coach_threads th
      where th.id = new.thread_id and th.user_id is distinct from new.user_id) then
    perform public._refuse_cross_account('coach_action_undos.thread_id');
  end if;
  if new.message_id is not null and exists (select 1 from public.coach_messages m
      where m.id = new.message_id and m.user_id is distinct from new.user_id) then
    perform public._refuse_cross_account('coach_action_undos.message_id');
  end if;
  return new;
end $$;

-- Internal: the trigger calls it, nobody else needs to.
revoke all on function public._same_owner_coach_action_undos() from public, anon, authenticated;

do $$
declare
  v_bad bigint;
begin
  lock table public.coach_action_undos in share row exclusive mode;
  select count(*) into v_bad
    from public.coach_action_undos u
    left join public.coach_threads th on th.id = u.thread_id
    left join public.coach_messages m on m.id = u.message_id
   where (u.thread_id is not null and th.user_id is distinct from u.user_id)
      or (u.message_id is not null and m.user_id is distinct from u.user_id);
  if v_bad > 0 then
    raise exception 'coach_action_undos_same_owner: % existing rows reference another account. '
      'Nothing was changed. Inspect them before applying.', v_bad using errcode = '23514';
  end if;
  drop trigger if exists coach_action_undos_same_owner on public.coach_action_undos;
  create trigger coach_action_undos_same_owner before insert or update of user_id, thread_id, message_id
    on public.coach_action_undos
    for each row execute function public._same_owner_coach_action_undos();
end $$;
