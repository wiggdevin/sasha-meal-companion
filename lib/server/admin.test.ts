import { execFileSync } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..", "..");

/**
 * Spec acceptance criterion 6: SUPABASE_SERVICE_ROLE_KEY appears in exactly one
 * source file. .env.example and the docs describe it; source must not.
 */
describe("the service-role key", () => {
  it("appears in exactly one source file", () => {
    const out = execFileSync(
      "git",
      [
        "grep",
        "-l",
        "SUPABASE_SERVICE_ROLE_KEY",
        "--",
        "*.ts",
        "*.tsx",
        ":!*.test.ts",
        ":!.env.example",
      ],
      { cwd: REPO, encoding: "utf8" },
    );
    const files = out.split("\n").filter((line) => line.length > 0).sort();
    // lib/server/db.ts was the legacy single-tenant layer; the cut-over deleted it
    // (20261026090200_retire_legacy_store), so only the CLI boundary may hold the key.
    expect(files).toEqual(["lib/server/admin.ts"]);
  });
});

describe("adminClientForCli", () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  it("prefers the branch TEST target whatever else the shell carries", async () => {
    process.env.SUPABASE_URL = "https://prod.example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "prod-key";
    process.env.SUPABASE_TEST_URL = "https://branch.example.supabase.co";
    process.env.SUPABASE_TEST_SERVICE_ROLE_KEY = "branch-key";
    const { adminClientForCli } = await import("./admin");
    const client = adminClientForCli() as unknown as { supabaseUrl: string };
    expect(client.supabaseUrl).toContain("branch.example");
  });

  it("refuses a production-only environment without --production", async () => {
    delete process.env.SUPABASE_TEST_URL;
    delete process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;
    process.env.SUPABASE_URL = "https://prod.example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "prod-key";
    const { adminClientForCli } = await import("./admin");
    expect(() => adminClientForCli()).toThrow(/refusing to target prod\.example/);
    expect(() => adminClientForCli({ production: true })).not.toThrow();
  });
});

