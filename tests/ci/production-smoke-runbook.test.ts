import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Production smoke, feature "build-meal" (docs/audit/2026-09-13/wf3-verify-production.js):
 * every gated route, build-meal included, redirects an anonymous request to /sign-in
 * (middleware.ts) and there is no production auth bypass (app/api/dev/sign-in/route.ts
 * answers 404 off localhost). Reaching build-meal on production therefore needs a
 * signed-in session, and the repo had no runbook naming where that test account's
 * credential lives or how a smoke agent is meant to use it — so the agent had nothing to
 * read and stopped at the sign-in wall instead of authenticating. Without a runbook, the
 * next smoke run repeats the same dead end for every gated feature, not just build-meal.
 *
 * This does not create, and must never document the creation of, a production Supabase
 * account or a plaintext password (docs/readiness/2026-09-12-production-readiness.md item 7,
 * and this fix's own no-production-writes ruling) — it only guards that the handoff is
 * written down.
 */
describe("production smoke runbook", () => {
  const runbookPath = path.join(
    process.cwd(),
    "docs",
    "readiness",
    "production-smoke-runbook.md",
  );

  it("exists and documents the signed-in-feature handoff", () => {
    const runbook = readFileSync(runbookPath, "utf8");

    // Names where the test account's credential lives, so a smoke agent has somewhere to
    // look instead of failing with "no documented account" again.
    expect(runbook).toMatch(/ZS Vault/);
    // States the account is provisioned out of band by the owner, not by an agent.
    expect(runbook).toMatch(/owner/i);
    // Forbids the exact prohibited action the original failure named.
    expect(runbook).toMatch(/never (create|creates) a production Supabase (account|user)/i);
    expect(runbook).toMatch(/never types? (a |the )?password/i);
    // Explains why there's no code-level bypass to reach for instead.
    expect(runbook).toContain("app/api/dev/sign-in");
    // Covers the failing feature, not just sign-in itself.
    expect(runbook).toContain("build-meal");
  });
});
