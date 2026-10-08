/**
 * W13, Sol round 2 BLOCK: the star-to-Favored CLI must START under plain `tsx`. It used to import
 * lib/server/membership-revisions.ts, whose `import "server-only"` throws at import outside a
 * react-server build, so the branch check and the production merge could not run at all. This
 * starts the real script with no Supabase env: it must get past import and flag parsing and fail
 * cleanly on the missing env (read-only path, no connection is ever opened).
 */
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const SUPABASE_ENV = ["SUPABASE_URL", "SUPABASE_TEST_URL",
  ["SUPABASE", "SERVICE_ROLE_KEY"].join("_"), ["SUPABASE_TEST", "SERVICE_ROLE_KEY"].join("_")];

function run(args: string[]) {
  const env = { ...process.env };
  for (const name of SUPABASE_ENV) delete env[name];
  return spawnSync("pnpm", ["exec", "tsx", "scripts/star-to-favored.ts", ...args],
    { cwd: process.cwd(), env, encoding: "utf8", timeout: 60_000 });
}

describe("scripts/star-to-favored.ts under tsx", () => {
  it("starts, parses flags and stops on the missing env, never on a server-only import", () => {
    const result = run([]);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).not.toMatch(/server-only|cannot be imported from a Client Component/);
    expect(output).toContain("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
    expect(result.status).toBe(1);
  }, 60_000);

  it("rejects an unknown flag after a clean import", () => {
    const result = run(["--nope"]);
    expect(result.stderr).toContain("unknown argument: --nope");
    expect(result.status).toBe(1);
  }, 60_000);
});
