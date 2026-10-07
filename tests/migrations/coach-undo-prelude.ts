/**
 * The throwaway-Postgres stand-in for the Supabase pieces the coach Undo functions call (auth.uid()
 * from the JWT claim, the owner tables, and `apply_sync_op` / `set_food_membership` with their
 * compare-and-swap contract), shared by tests/migrations/coach-undo-sql.test.ts and
 * tests/migrations/coach-undo-receipt-sql.test.ts. Never connects to any Supabase project.
 */

/** The coach Undo migrations in apply order (docs/specs/coach-undo-receipt.md §7, steps 1–4). */
export const COACH_UNDO_MIGRATIONS = [
  "20261210090300_coach_action_undos.sql",
  "20261216090000_coach_action_receipts.sql",
  "20261216090100_coach_undo_record_mode.sql",
  "20261216090200_coach_undo_record_mode_validate.sql",
  "20261216090300_coach_undo_legacy_guards.sql",
  "20261216090400_perform_coach_undo_receipts.sql",
] as const;

export function coachUndoPrelude(a: string, b: string): string {
  return String.raw`
-- Roles are cluster-wide: a second database in the same cluster reuses them. service_role
-- bypasses RLS, as Supabase's does.
do $roles$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin; create role anon nologin; create role service_role nologin bypassrls;
  end if;
end $roles$;
create extension if not exists pgcrypto;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to authenticated;
grant execute on function auth.uid() to authenticated;
create table coach_threads (id uuid primary key, user_id uuid);
create table coach_messages (id uuid primary key, thread_id uuid, user_id uuid, tool_calls jsonb);
create table log_entries (id uuid primary key, user_id uuid, rev int not null default 1,
  deleted_at timestamptz, local_date date, slot text, eaten_at timestamptz);
create table log_items (id uuid primary key default gen_random_uuid(), entry_id uuid,
  food_ref_id uuid, grams numeric);
create table recipes (id uuid primary key, user_id uuid, rev int not null default 1,
  deleted_at timestamptz, name text);
create table water_log (user_id uuid, local_date date, cups int not null, rev int not null default 1,
  primary key (user_id, local_date));
create table plan_days (user_id uuid, local_date date, day_type_override text,
  floor_day boolean not null default false, swaps jsonb not null default '{}',
  slot_notes jsonb not null default '{}', item_overrides jsonb not null default '{}',
  rev int not null default 1, primary key (user_id, local_date));
create table food_membership_revisions (user_id uuid, name_norm text, status text, note text,
  rev bigint not null, primary key (user_id, name_norm));
create function food_name_norm(p text) returns text language sql immutable as $$ select lower(btrim(p)) $$;
create table seen_ops (op_id uuid primary key);
-- The real RPC's contract: caller check, op-id idempotency, base_rev compare-and-swap.
create function apply_sync_op(p_user_id uuid, p_op jsonb) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare v_rev int; v_key text := p_op->>'entity_id'; v_base int := (p_op->>'base_rev')::int;
begin
  if auth.uid() is distinct from p_user_id then raise exception 'forbidden'; end if;
  insert into seen_ops values ((p_op->>'op_id')::uuid) on conflict do nothing;
  if not found then return jsonb_build_object('status', 'duplicate'); end if;
  case p_op->>'entity'
    when 'log_entries' then
      select rev into v_rev from log_entries where id = v_key::uuid and user_id = p_user_id;
      if v_rev is distinct from v_base then return jsonb_build_object('status', 'conflict'); end if;
      update log_entries set deleted_at = now(), rev = rev + 1 where id = v_key::uuid;
    when 'recipes' then
      select rev into v_rev from recipes where id = v_key::uuid and user_id = p_user_id;
      if v_rev is distinct from v_base then return jsonb_build_object('status', 'conflict'); end if;
      update recipes set deleted_at = now(), rev = rev + 1 where id = v_key::uuid;
    when 'water_log' then
      select rev into v_rev from water_log where local_date = v_key::date and user_id = p_user_id;
      if v_rev is distinct from v_base then return jsonb_build_object('status', 'conflict'); end if;
      update water_log set cups = (p_op->'payload'->>'cups')::int, rev = rev + 1
       where local_date = v_key::date and user_id = p_user_id;
    when 'plan_days' then
      select rev into v_rev from plan_days where local_date = v_key::date and user_id = p_user_id;
      if v_rev is distinct from v_base then return jsonb_build_object('status', 'conflict'); end if;
      update plan_days set item_overrides = p_op->'payload'->'item_overrides',
        slot_notes = p_op->'payload'->'slot_notes', rev = rev + 1
       where local_date = v_key::date and user_id = p_user_id;
    else return jsonb_build_object('status', 'unsupported');
  end case;
  return jsonb_build_object('status', 'applied');
end; $$;
create function set_food_membership(p_user uuid, p_name_norm text, p_status text, p_note text,
  p_rev bigint) returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  if auth.uid() is distinct from p_user then raise exception 'forbidden'; end if;
  insert into food_membership_revisions as m values (p_user, p_name_norm, p_status, p_note, p_rev)
  on conflict (user_id, name_norm) do update set status = excluded.status,
    note = coalesce(excluded.note, m.note), rev = excluded.rev where m.rev < excluded.rev;
  select jsonb_build_object('rev', rev, 'status', status) into v from food_membership_revisions
   where user_id = p_user and name_norm = p_name_norm;
  return v;
end; $$;
insert into auth.users values ('${a}'), ('${b}');
`;
}
