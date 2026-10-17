-- W048 step 1 (scale step 8): replay receipts. apply_sync_op answered 'duplicate' only while the
-- op's change_log row existed (the unique change_log_op_id index), so change_log could never be
-- pruned without letting an old retried op apply twice. sync_op_receipts holds one row per applied
-- op_id, written by one trigger on change_log insert, so every writer that stamps an op_id is
-- covered without touching it: apply_sync_op (and through it the log commit, whose op id is
-- lib/log/op-id.ts opIdFor), write_target_revision, approve_target_proposal, the expenditure and
-- target-authority writers, recipe_log_consumed / recipe_undo_consumed, save_food_note and
-- taste_chips_confirm. coach_save_turn (20270104120000) writes no change_log row.
--
-- apply_sync_op's replay check now reads the receipt instead of change_log; that is the only
-- change to it (anchor patch, the 20261231180000 pattern, refusing a partial or ambiguous patch).
-- _sync_written_at still reads change_log and is unchanged. Nothing is pruned here: compaction,
-- snapshots and the client's stale-cursor path are later W048 steps.
--
-- A receipt insert is a plain insert, so a second change_log row with an op_id that already has a
-- receipt fails with unique_violation, exactly as the change_log_op_id index does today (the index
-- fires first while the row exists; the receipt keeps the rule once it is pruned).
--
-- Live-safe: a new table, a policy, a trigger and a function replacement. The backfill and the
-- trigger run under one SHARE ROW EXCLUSIVE lock on change_log, so no op lands between them; a
-- sync write waits for the migration to commit (lock_timeout 3s to take the lock).
-- Order: APPLY TO PRODUCTION BEFORE THIS CODE DEPLOYS. The app code does not read the table, but
-- the receipt has to exist before any later step prunes change_log.
-- Down: supabase/migrations/down/20270105110000_sync_op_receipts.down.sql.
set local lock_timeout = '3s';
set local statement_timeout = '120s';

create table if not exists public.sync_op_receipts (
  op_id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  outcome text not null default 'applied' check (outcome in ('applied')),
  at timestamptz not null default now()
);
create index if not exists sync_op_receipts_user_at on public.sync_op_receipts (user_id, at);
alter table public.sync_op_receipts enable row level security;
revoke all on table public.sync_op_receipts from public, anon, authenticated;
grant select on table public.sync_op_receipts to authenticated;
grant all on table public.sync_op_receipts to service_role;
drop policy if exists sync_op_receipts_owner_read on public.sync_op_receipts;
create policy sync_op_receipts_owner_read on public.sync_op_receipts
  for select to authenticated using (user_id = (select auth.uid()));
comment on table public.sync_op_receipts is
  'W048: one row per applied op_id, written by the change_log insert trigger. apply_sync_op answers '
  '''duplicate'' from it, so a replay stays a duplicate after its change_log row is gone.';

create or replace function public._sync_op_receipt() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $fn$
begin
  insert into public.sync_op_receipts (op_id, user_id, outcome, at)
  values (new.op_id, new.user_id, 'applied', new.at);
  return null;
end;
$fn$;
revoke all on function public._sync_op_receipt() from public, anon, authenticated;

lock table public.change_log in share row exclusive mode;

insert into public.sync_op_receipts (op_id, user_id, outcome, at)
select c.op_id, c.user_id, 'applied', c.at from public.change_log c where c.op_id is not null
on conflict (op_id) do nothing;

drop trigger if exists change_log_op_receipt on public.change_log;
create trigger change_log_op_receipt after insert on public.change_log
  for each row when (new.op_id is not null) execute function public._sync_op_receipt();

do $migration$
declare
  definition text;
  anchor text := $a$  if exists (select 1 from change_log where op_id = v_op_id) then$a$;
  patched text := $a$  if exists (select 1 from public.sync_op_receipts where op_id = v_op_id) then$a$;
  occurrences integer;
begin
  select pg_get_functiondef('public.apply_sync_op(uuid,jsonb)'::regprocedure) into definition;
  if position(patched in definition) > 0 then
    if position(anchor in definition) > 0 then
      raise exception 'sync_op_receipts (apply_sync_op): both replay checks present; refusing a partial function';
    end if;
    return;
  end if;
  occurrences := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if occurrences <> 1 then
    raise exception 'sync_op_receipts (apply_sync_op): replay anchor occurs % times, expected once', occurrences;
  end if;
  execute replace(definition, anchor, patched);
end;
$migration$;
revoke execute on function public.apply_sync_op(uuid, jsonb) from public, anon;
grant execute on function public.apply_sync_op(uuid, jsonb) to authenticated, service_role;
