-- Coach Undo receipts v1, deploy step 1 (docs/specs/coach-undo-receipt.md §6.1, §7).
--
-- One immutable row per receipt action (`log_meal` create, `save_recipe` create, one-date
-- `set_slot_meal`): what the coach write applied, read by the server from the rows the op changed
-- in the op's own transaction. The only writer will be `apply_coach_op` (step 6, PR B); until then
-- the table stays empty in production, so this step is live-safe: a new, empty table.
--
--   * One receipt per action and per op: unique (user_id, action_id) and unique (user_id, op_id).
--   * Immutable: a BEFORE UPDATE trigger raises 42501 `receipt_immutable` for every role. There is
--     no delete trigger, so the account cascade (auth.users ON DELETE CASCADE) still works; no
--     client role and not service_role holds DELETE, UPDATE or TRUNCATE.
--   * No foreign key to coach_messages or coach_threads: their ON DELETE SET NULL would rewrite a
--     receipt. The message id lives inside `source`, checked as the caller's own at write time.
--   * Owner-only select for `authenticated`; `service_role` select and insert only.
--   * The daily scrub (`scrub_coach_action_undos`) never touches this table. Rows live as long as
--     the account.
--
-- Apply order: 20261216090000 .. 20261216090400, each file in its own transaction.
-- Down: supabase/migrations/down/20261216090000_coach_action_receipts.down.sql (refuses while any
-- receipt exists).
set local lock_timeout = '3s';
set local statement_timeout = '30s';

do $$
begin
  if to_regclass('public.coach_action_receipts') is not null then
    raise exception '20261216090000_coach_action_receipts: already applied';
  end if;
end $$;

create table public.coach_action_receipts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  action_id text not null check (char_length(action_id) between 1 and 128),
  kind text not null check (kind in ('log_meal', 'save_recipe', 'set_slot_meal')),
  op_id uuid not null,
  entity text not null,
  entity_id text not null check (char_length(entity_id) between 1 and 64),
  source jsonb check (source is null or jsonb_typeof(source) = 'object'),
  source_check text not null check (source_check in ('match', 'mismatch', 'none')),
  applied jsonb not null check (jsonb_typeof(applied) = 'object'
                                and pg_column_size(applied) <= 32768),
  created_at timestamptz not null default now(),
  -- Each kind writes exactly one entity (spec §3.2).
  constraint coach_action_receipts_entity check (
       (kind = 'log_meal' and entity = 'log_entries')
    or (kind = 'save_recipe' and entity = 'recipes')
    or (kind = 'set_slot_meal' and entity = 'plan_days')),
  constraint coach_action_receipts_op unique (user_id, op_id),
  -- One receipt per action (spec §2, review R1-3, R1-6).
  constraint coach_action_receipts_action unique (user_id, action_id)
);
comment on table public.coach_action_receipts is
  'Coach Undo receipt v1 (docs/specs/coach-undo-receipt.md): what one coach write applied. Immutable; written only by apply_coach_op.';

-- Raises on every update, whoever runs it (the owner and service_role included).
create function public._coach_action_receipts_immutable() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'receipt_immutable' using errcode = '42501';
end $$;
revoke all on function public._coach_action_receipts_immutable() from public, anon, authenticated;

create trigger coach_action_receipts_immutable before update on public.coach_action_receipts
  for each row execute function public._coach_action_receipts_immutable();

alter table public.coach_action_receipts enable row level security;
create policy coach_action_receipts_select on public.coach_action_receipts for select to authenticated
  using (user_id = (select auth.uid()));
-- Hosted default privileges grant ALL on a new table to anon, authenticated and service_role.
revoke all on table public.coach_action_receipts from public, anon, authenticated, service_role;
grant select on table public.coach_action_receipts to authenticated;
grant select, insert on table public.coach_action_receipts to service_role;
