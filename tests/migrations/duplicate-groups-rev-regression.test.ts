/**
 * Loop 010, 2026-09-14. 20261014090001 made (user_id, fingerprint) the arbiter for
 * duplicate_groups so two devices could not collide on the unique key. It converged, but its
 * ON CONFLICT wrote unconditionally, so the second device's create — always state 'open', no
 * merged_into_entry_id, rev 1 — walked backwards over a group the first device had already
 * decided.
 *
 * Measured through POST /api/sync/ops before the fix: create GA (rev 1) -> update GA to merged
 * (rev 2) -> create GB with the SAME fingerprint returned "applied", created no GB row, and left
 * GA as 'open' at rev 1 with merged_into_entry_id NULL. After the fix the same three calls leave
 * GA 'merged' at rev 2.
 *
 * A regressing rev is the part that spreads: every later update carries base_rev, so a row that
 * silently moves backwards breaks the CAS those updates depend on.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

const UP = read("supabase/migrations/20261016090000_duplicate_groups_no_rev_regression.sql");
const DOWN = read(
  "supabase/migrations/down/20261016090000_duplicate_groups_no_rev_regression.down.sql");
const PRIOR = read(
  "supabase/migrations/20261014090001_fix_duplicate_groups_fingerprint_conflict.sql");

/** The SQL body, with the leading comment block stripped, so a comment cannot satisfy a test. */
const sqlOnly = (text: string) =>
  text.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");

describe("20261016090000_duplicate_groups_no_rev_regression", () => {
  it("guards the conflict write so it can only move a row forward", () => {
    expect(sqlOnly(UP)).toContain("where duplicate_groups.rev < excluded.rev");
  });

  it("keeps the fingerprint arbiter the prior migration introduced", () => {
    expect(sqlOnly(UP)).toContain("on conflict (user_id, fingerprint) do update set");
  });

  it("is the one change from the prior migration — the guard the prior one lacked", () => {
    expect(sqlOnly(PRIOR)).not.toContain("where duplicate_groups.rev < excluded.rev");
    expect(sqlOnly(PRIOR)).toContain("on conflict (user_id, fingerprint) do update set");
  });

  it("down restores the unguarded write, and says what that costs", () => {
    expect(sqlOnly(DOWN)).not.toContain("where duplicate_groups.rev < excluded.rev");
    expect(sqlOnly(DOWN)).toContain("on conflict (user_id, fingerprint) do update set");
    expect(DOWN).toMatch(/regression|revert|backwards/i);
  });

  it("leaves the other entities' conflict arbiters alone", () => {
    for (const entity of ["gut_log", "recipes"]) {
      expect(sqlOnly(UP)).toContain(`p_entity = '${entity}'`);
    }
  });
});
