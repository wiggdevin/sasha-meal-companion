/**
 * W075: `test_reset_user` (supabase/seed/test_helpers.sql) must delete every user-owned table, so
 * DB tests do not leak state. The tenancy manifest lists each table and how its rows are owned;
 * a table owned by a `user_id` column must be named in the function.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "../tenancy/table-ops.json";

const helpers = readFileSync(path.join(process.cwd(), "supabase/seed/test_helpers.sql"), "utf8");
const start = helpers.indexOf("create or replace function test_reset_user");
const end = helpers.indexOf("revoke execute on function test_reset_user");
const body = helpers.slice(start, end);

describe("test_reset_user coverage", () => {
  it("finds the function body", () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });

  it("names every table owned by a user_id column", () => {
    const owned = Object.entries(manifest as Record<string, { owner: unknown }>)
      .filter(([, v]) => v.owner === "user_id")
      .map(([table]) => table);
    const missing = owned.filter((table) => !new RegExp(`\\b${table}\\b`).test(body));
    expect(missing).toEqual([]);
  });
});
