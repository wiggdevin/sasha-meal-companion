-- W029 (audit 2026-10-10 A140, A039): the server assigns a food membership's revision.
--
-- The 5-argument set_food_membership writes only when the caller's p_rev is above the stored rev,
-- and the phone minted p_rev from its own clock (Date.now()). A device whose clock ran ahead won
-- every later tap from a correctly clocked device, and two tabs could mint one revision in one
-- millisecond, so the second tap was reported `rejected` and the phone reverted it.
--
-- * set_food_membership(..., p_rev, p_op_id) (new overload): one sync op, applied once. Under the
--   name's lock it assigns rev = greatest(p_rev, stored rev + 1), so a tap is never refused for an
--   older or equal revision; the arrival order decides. p_rev is now the phone's hint (the last
--   server revision it saw, plus one), never a clock. The op id is recorded in
--   food_membership_ops, so a retried op answers its first result with `duplicate: true` and never
--   writes again over a later choice. The write itself is the 5-argument function, unchanged.
-- * food_membership_ops: that ledger. Owner-scoped, RLS on with no client policy (only the two
--   definer functions write or read it); rows older than 90 days are pruned per account on write.
-- * food_membership_revisions gets an owner select policy, so the phone can refresh its mark cache
--   from the server's marks on every sync pass (A039). Writes stay definer-only.
--
-- The 5-argument function is unchanged: the deployed route, perform_coach_undo and the scripts keep
-- calling it. Live-safe: a new empty table, a policy, a grant and a new function.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

create table if not exists public.food_membership_ops (
  op_id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name_norm text not null,
  result jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists food_membership_ops_user_created
  on public.food_membership_ops (user_id, created_at);
alter table public.food_membership_ops enable row level security;
revoke all on table public.food_membership_ops from public, anon, authenticated;
grant all on table public.food_membership_ops to service_role;

drop policy if exists food_membership_revisions_owner_read on public.food_membership_revisions;
create policy food_membership_revisions_owner_read on public.food_membership_revisions
  for select to authenticated using (user_id = (select auth.uid()));
grant select on table public.food_membership_revisions to authenticated;

create or replace function public.set_food_membership(p_user uuid, p_name_norm text, p_status text,
  p_note text, p_rev bigint, p_op_id uuid) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  v_name text := food_name_norm(p_name_norm);
  v_prior jsonb;
  v_owner uuid;
  v_current bigint;
  v_rev bigint;
  v_result jsonb;
begin
  perform _sync_assert_caller(p_user);
  if p_op_id is null then raise exception 'bad_food_membership_op' using errcode = '22023'; end if;
  if v_name = '' then raise exception 'food_name_required' using errcode = '22023'; end if;
  if p_rev is null or p_rev < 0 then
    raise exception 'bad_food_membership_rev' using errcode = '22023';
  end if;
  -- The same per-name lock the write takes (re-entrant in this transaction): the ledger read, the
  -- revision read and the write see one order.
  perform pg_advisory_xact_lock(hashtextextended(p_user::text || ':food-note:' || v_name, 0));
  select ops.user_id, ops.result into v_owner, v_prior from food_membership_ops ops where ops.op_id = p_op_id;
  if v_owner is not null then
    if v_owner <> p_user then raise exception 'forbidden' using errcode = '42501'; end if;
    return v_prior || jsonb_build_object('duplicate', true);
  end if;
  select membership.rev into v_current from food_membership_revisions membership
   where membership.user_id = p_user and membership.name_norm = v_name;
  v_rev := greatest(p_rev, coalesce(v_current, -1) + 1);
  v_result := set_food_membership(p_user, p_name_norm, p_status, p_note, v_rev);
  insert into food_membership_ops (op_id, user_id, name_norm, result)
  values (p_op_id, p_user, v_name, v_result);
  delete from food_membership_ops ops
   where ops.user_id = p_user and ops.created_at < now() - interval '90 days';
  return v_result || jsonb_build_object('duplicate', false);
end $$;
revoke all on function public.set_food_membership(uuid, text, text, text, bigint, uuid)
  from public, anon;
grant execute on function public.set_food_membership(uuid, text, text, text, bigint, uuid)
  to authenticated, service_role;
