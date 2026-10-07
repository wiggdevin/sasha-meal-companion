import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("new-user live readiness", () => {
  it("keeps account-specific names out of the reusable gate", () => {
    const source = readFileSync("scripts/readiness/new-user-live.sh", "utf8");
    expect(source).not.toMatch(/\b(?:Sasha|Devin)\b/i);
  });

  it("lists every read-only check in dry mode without contacting the network", () => {
    const result = spawnSync("bash", ["scripts/readiness/new-user-live.sh", "--dry", "321"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, PATH: "/usr/bin:/bin" },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("DRY   1 PR #321 is merged into remote main");
    expect(result.stdout).toContain("DRY   2 remote main SHA equals the Vercel READY deployment SHA");
    expect(result.stdout).toContain("DRY   3 migrations present: 20261026090000 20261026090100 20261026090200");
    expect(result.stdout).toContain("DRY   4 required env names present and retired singleton env names absent");
    expect(result.stdout).toContain("DRY   5 GET /sign-in -> 200 with neutral HTML");
    expect(result.stdout).toContain("DRY   6 GET /api/sync -> 404");
    expect(result.stdout).toContain("DRY   7 GET /api/targets -> 401");
    expect(result.stdout).toContain("DRY   8 POST /api/sync/ops -> 401");
    expect(result.stdout).not.toMatch(/PASS|FAIL|curl|fetch|zsvault|gh /);
  });

  it("probes /api/sync/ops with the verb that route exports", () => {
    // `app/api/sync/ops/route.ts` exports POST only, so a GET probe proves 405, not the 401 the
    // readiness gate claims to check (Grok pass 1). The probe sends an empty JSON body and no
    // Authorization header, which is exactly the unauthenticated case the check is about.
    const source = readFileSync("scripts/readiness/new-user-live.sh", "utf8");
    expect(source).toContain("8 POST /api/sync/ops -> 401");
    expect(source).not.toMatch(/GET \/api\/sync\/ops/);
    expect(source).toMatch(/-X POST/);
    expect(source).not.toMatch(/ops_code=\$\(http_code/);
    // The probe must stay unauthenticated: no Authorization header anywhere in the ops check.
    expect(source).not.toMatch(/sync\/ops[^\n]*[Aa]uthorization/);
  });
});
