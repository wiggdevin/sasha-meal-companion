import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const UP = readFileSync(path.join(ROOT,
  "supabase/migrations/20261023090400_food_membership_v2.sql"), "utf8").toLowerCase();
const DOWN = readFileSync(path.join(ROOT,
  "supabase/migrations/down/20261023090400_food_membership_v2.down.sql"), "utf8").toLowerCase();
const NOTE_SYNC = readFileSync(path.join(ROOT,
  "supabase/migrations/20261204090000_food_note_sync.sql"), "utf8");
const RESULT_UP = readFileSync(path.join(ROOT,
  "supabase/migrations/20261205090000_food_membership_result.sql"), "utf8");
const RESULT_DOWN = readFileSync(path.join(ROOT,
  "supabase/migrations/down/20261205090000_food_membership_result.down.sql"), "utf8");
const FUNCTION_START = "create or replace function set_food_membership(";
const FUNCTION_END = "  to authenticated, service_role;\n";

/** The set_food_membership definition in one migration, from its create to its grant. */
function membershipFunction(sql: string): string {
  const start = sql.indexOf(FUNCTION_START);
  return sql.slice(start, sql.indexOf(FUNCTION_END, start) + FUNCTION_END.length);
}

describe("food membership migration", () => {
  it("replaces the RPC with a bounded best-effort update that never rejects wide families", () => {
    expect(UP).toContain("set_food_membership(p_user uuid, p_name_norm text, p_status text");
    expect(UP).toContain("p_note text, p_rev bigint");
    expect(UP).toContain("perform _sync_assert_caller(p_user)");
    expect(UP).toContain("security definer set search_path = public");
    expect(UP).toContain("p_status not in ('eats','avoid')");
    expect(UP).not.toContain("status in ('eats','avoid','neutral')");
    expect(UP).toContain("v_catalog_limit");
    expect(UP).toContain("greatest(50 - cardinality(v_user_refs), 0)");
    expect(UP).toContain("v_refs := v_user_refs || v_catalog_refs");
    expect(UP).toContain("pref.updated_at desc nulls last");
    expect(UP).toContain("'updated'");
    expect(UP).toContain("'truncated'");
    expect(UP).not.toContain("food_membership_too_wide");
    expect(UP).toContain("delete from user_food_prefs");
    expect(UP).toContain("on conflict (user_id, food_ref_id) do update");
  });

  it("reports conflicts and marked-versus-absent partial families", () => {
    expect(UP).toContain("food_membership_contradictions(p_user uuid)");
    expect(UP).toContain("'partial'");
    expect(UP).toContain("'conflict'");
    expect(UP).toContain("count(family_refs.status) < count(*)");
    expect(UP).toContain("eats_updated_at");
    expect(UP).toContain("avoid_updated_at");
    expect(UP).toContain("revoke execute on function food_membership_contradictions(uuid)");
  });

  it("the down migration restores both v1 function definitions instead of dropping the feature", () => {
    expect(DOWN).toContain("create or replace function set_food_membership");
    expect(DOWN).toContain("food_membership_too_wide");
    expect(DOWN).toContain("drop function if exists food_membership_contradictions(uuid)");
    expect(DOWN).toContain("returns table (user_id uuid, name_norm text, row_count bigint, ref_ids uuid[]");
    expect(DOWN).not.toContain("drop table if exists food_membership_revisions");
    expect(DOWN).not.toContain("drop column if exists note");
  });
});

// tests/sync/food-membership-ops-db.test.ts proves the behavior on a real database; these pin the
// text so a later re-creation copied from an older body is caught without one.
describe("food membership result migration", () => {
  const body = membershipFunction(RESULT_UP);

  it("reads the result in its own statement, after both write branches", () => {
    expect(body.match(/into v_updated, v_notes_kept;/g)).toHaveLength(2);
    const result = body.indexOf("select jsonb_build_object('rev', membership.rev");
    expect(result).toBeGreaterThan(body.lastIndexOf("end if;"));
    expect(body.match(/jsonb_build_object\('rev'/g)).toHaveLength(1);
  });

  it("keeps the note-sync write, signature and grants", () => {
    expect(body).toContain("perform _sync_assert_caller(p_user)");
    expect(body).toContain("food_note_authority authority");
    expect(body).toContain("where membership.rev < excluded.rev");
    expect(body).toContain("revoke execute on function set_food_membership(uuid, text, text, text, bigint) from public, anon;");
  });

  it("the down migration restores the note-sync body exactly", () => {
    expect(membershipFunction(RESULT_DOWN)).toBe(membershipFunction(NOTE_SYNC));
  });
});
