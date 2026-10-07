import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Two files with one version break `supabase start` (the ledger key is the version) and make
 * scripts/apply-migrations.py treat the second as applied when it never ran — the 2026-10-05
 * `food_role_only_sync` / `recipe_accept_keeps_selection` clash. Every version is unique.
 */
describe("migration versions", () => {
  it("never share a version between two files", () => {
    const dir = join(process.cwd(), "supabase", "migrations");
    const versions = readdirSync(dir).filter((name) => name.endsWith(".sql"))
      .map((name) => name.split("_")[0]);
    const duplicates = versions.filter((version, i) => versions.indexOf(version) !== i);
    expect(duplicates).toEqual([]);
  });

  // Scale S2 (2026-10-06): the first S2 numbering reused versions another branch had already put
  // in the production ledger. That clash is only visible across branches, but every version must at
  // least be a 14-digit stamp, and every down file must reverse an up file in this tree.
  it("are 14-digit stamps, and every down file names an up file's version", () => {
    const dir = join(process.cwd(), "supabase", "migrations");
    const up = readdirSync(dir).filter((name) => name.endsWith(".sql"));
    expect(up.filter((name) => !/^\d{14}_[a-z0-9_]+\.sql$/.test(name))).toEqual([]);
    const upNames = new Set(up.map((name) => name.replace(/\.sql$/, "")));
    const down = readdirSync(join(dir, "down")).filter((name) => name.endsWith(".down.sql"));
    expect(down.filter((name) => !upNames.has(name.replace(/\.down\.sql$/, "")))).toEqual([]);
  });
});
