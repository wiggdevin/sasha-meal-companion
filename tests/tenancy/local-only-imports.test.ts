/**
 * Review r8 finding 1 and r9 finding 1: every tenancy suite that can reach a database must import
 * the shared local-only guard (tests/tenancy/local-only.ts) as its first import, so the guard runs
 * before any other module does work, and before any setup, seeding or write. There are no
 * exceptions: the suites from the security-fix PRs (#249, #250) import it too. No database needed.
 */
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DIR = "tests/tenancy";
const GUARD_IMPORT = /^import\s+["']\.\/local-only["'];/;

/** A suite that touches a database: it imports the Supabase test helpers or a module that does. */
const USES_DB = /from\s+["'](?:\.\.\/helpers\/supabase|\.\/seed|\.\/catalog|\.\/fixtures|\.\/job-fixtures|\.\/xref-fixtures)["']/;

function firstImport(src: string): string {
  const body = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  return body.split("\n").find((line) => line.startsWith("import ")) ?? "";
}

describe("every tenancy database suite imports the local-only guard first", () => {
  const suites = readdirSync(DIR).filter((f) => f.endsWith(".test.ts"))
    .filter((f) => USES_DB.test(readFileSync(`${DIR}/${f}`, "utf8")));

  it("finds the database suites (control)", () => {
    for (const suite of ["table-matrix.test.ts", "policy-mutation.test.ts",
      "sync-internals-grants.test.ts", "cross-refs-enforced.test.ts",
      "cross-refs-owner-changes.test.ts", "same-owner-migration.test.ts"]) {
      expect(suites).toContain(suite);
    }
  });

  it("each one's first import is ./local-only, with no exceptions", () => {
    const unguarded = suites
      .filter((f) => !GUARD_IMPORT.test(firstImport(readFileSync(`${DIR}/${f}`, "utf8"))));
    expect(unguarded).toEqual([]);
  });
});
