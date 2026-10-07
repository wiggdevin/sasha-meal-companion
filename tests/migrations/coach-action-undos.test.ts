// Server-recorded coach Undo (audit 2026-10-04 P1 #6): the record table is owner-only, has no
// delete path for a client, and only `undone_at` can change after a row is recorded.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const sqlOnly = (t: string) =>
  t.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

const UP = sqlOnly(read("supabase/migrations/20261210090300_coach_action_undos.sql"));
const DOWN = sqlOnly(read("supabase/migrations/down/20261210090300_coach_action_undos.down.sql"));

describe("20261210090300_coach_action_undos", () => {
  it("creates the account-owned record with its inverse, revision and lifetime", () => {
    expect(UP).toContain("create table coach_action_undos");
    for (const column of ["user_id uuid not null references auth.users(id) on delete cascade",
      "thread_id uuid references coach_threads(id)", "message_id uuid references coach_messages(id)",
      "action_id text not null", "kind text not null", "inverse jsonb not null",
      "expected_rev bigint", "created_at timestamptz not null default now()",
      "undone_at timestamptz", "expires_at timestamptz not null default (now() + interval '7 days')",
      "unique (user_id, action_id)"]) {
      expect(UP).toContain(column);
    }
  });

  it("is owner-only select: no client insert, update or delete; records come from record_coach_undo", () => {
    expect(UP).toContain("alter table coach_action_undos enable row level security");
    expect(UP).toMatch(/for select to authenticated\s+using \(user_id = \(select auth\.uid\(\)\)\)/);
    expect(UP).not.toMatch(/for (all|insert|update|delete) to/);
    expect(UP).toContain("revoke all on table coach_action_undos from public, anon, authenticated");
    expect(UP).toContain("grant select on table coach_action_undos to authenticated");
    expect(UP).not.toMatch(/grant [^;]*(insert|update|delete)[^;]*to authenticated/);
    expect(UP).toContain("create or replace function record_coach_undo(p_action_id text");
    expect(UP).toContain("where m.user_id = v_user");
    expect(UP).toContain("expected_rev bigint");
  });

  it("list-mark Undo requires the membership revision the mark wrote", () => {
    expect(UP).toContain("if v_now_rev > v_row.expected_rev or v_now_status is distinct from v_set then");
  });

  it("builds the inverse from the stored record: the function takes only the id and a mark flag", () => {
    expect(UP).toContain("create or replace function perform_coach_undo(p_undo_id uuid, p_local boolean default false)");
    expect(UP).toContain("where id = p_undo_id and user_id = v_user for update");
    expect(UP).toContain("v_inv := v_row.inverse");
    expect(UP).not.toMatch(/p_op/);
    expect(UP).toContain("grant execute on function perform_coach_undo(uuid, boolean) to authenticated");
  });

  it("down drops the functions, then the table", () => {
    expect(DOWN.indexOf("drop function if exists perform_coach_undo(uuid, boolean)"))
      .toBeLessThan(DOWN.indexOf("drop table if exists coach_action_undos"));
    expect(DOWN).toContain("drop function if exists _coach_undo_slot_state(jsonb)");
  });
});

describe("20261211090100_coach_action_undos_same_owner", () => {
  const GUARD = sqlOnly(read("supabase/migrations/20261211090100_coach_action_undos_same_owner.sql"));
  const GUARD_DOWN = sqlOnly(read(
    "supabase/migrations/down/20261211090100_coach_action_undos_same_owner.down.sql"));

  it("refuses a thread or message of another account for every writer, revoked from clients", () => {
    expect(GUARD).toContain("create or replace function public._same_owner_coach_action_undos()");
    expect(GUARD).toContain("language plpgsql security definer set search_path = ''");
    expect(GUARD).toContain("perform public._refuse_cross_account('coach_action_undos.thread_id')");
    expect(GUARD).toContain("perform public._refuse_cross_account('coach_action_undos.message_id')");
    expect(GUARD).toContain("revoke all on function public._same_owner_coach_action_undos() from public, anon, authenticated");
    expect(GUARD).toMatch(/create trigger coach_action_undos_same_owner before insert or update of user_id, thread_id, message_id\s+on public\.coach_action_undos/);
    expect(GUARD).toContain("lock table public.coach_action_undos in share row exclusive mode");
  });

  it("down drops the trigger and its function", () => {
    expect(GUARD_DOWN).toContain("drop trigger if exists coach_action_undos_same_owner on public.coach_action_undos");
    expect(GUARD_DOWN).toContain("drop function if exists public._same_owner_coach_action_undos()");
  });
});
