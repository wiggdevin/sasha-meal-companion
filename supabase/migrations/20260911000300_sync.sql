-- Phase 0: architecture v2.1 §3.7. One monotonic cursor per user, an append-only change feed,
-- and the duplicate-group tables. The group card ships with Phase 2; the tables ship now.
create table change_seq (user_id uuid primary key references auth.users(id) on delete cascade,
  next_seq bigint not null default 1);
create table change_log (user_id uuid not null references auth.users(id) on delete cascade,
  seq bigint not null, entity text not null, entity_key text not null, rev integer not null,
  op text not null check (op in ('create','update','delete','restore')), op_id uuid,
  current jsonb,          -- the row after the op (null for delete; tombstone fields for restore)
  at timestamptz not null default now(), primary key (user_id, seq));
create index change_log_entity on change_log (user_id, entity, entity_key);
-- Idempotency: apply_sync_op answers 'duplicate' from this index, so a retried push never
-- re-applies. Not in the §3.7 DDL block; required by the §2 op_id contract.
create unique index change_log_op_id on change_log (op_id) where op_id is not null;

create function next_change_seq(p_user_id uuid) returns bigint language sql
  security definer set search_path = public as $$
  insert into change_seq (user_id, next_seq) values (p_user_id, 2)
    on conflict (user_id) do update set next_seq = change_seq.next_seq + 1
    returning next_seq - 1; $$;
revoke execute on function next_change_seq(uuid) from public, anon, authenticated;
grant execute on function next_change_seq(uuid) to service_role;

create table duplicate_groups (id uuid primary key default gen_random_uuid(), local_date date not null,
  user_id uuid not null references auth.users(id) on delete cascade, fingerprint bytea not null,
  slot text not null, state text not null default 'open' check (state in ('open','dismissed','merged')),
  merged_into_entry_id uuid references log_entries(id), rev integer not null default 1,
  created_at timestamptz not null default now(), decided_at timestamptz, unique (user_id, fingerprint));
create table duplicate_group_members (
  group_id uuid not null references duplicate_groups(id) on delete cascade,
  entry_id uuid not null references log_entries(id) on delete cascade, primary key (group_id, entry_id));
