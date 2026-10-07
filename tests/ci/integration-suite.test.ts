import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** Integration must start a validated disposable database before the gated suites run. */
describe("CI integration-suite wiring", () => {
  const root = path.join(__dirname, "..", "..");
  const workflow = readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  // Job ids may contain hyphens (integration-gate); `\w+` let this block run on into the next job.
  const integration = workflow.match(/^  integration:\n([\s\S]*?)(?=^  [\w-]+:|$(?![\s\S]))/m)?.[1] ?? "";
  const helper = readFileSync(path.join(root, "scripts", "ci-local-supabase.py"), "utf8");

  it("requires disposable setup and its boundary tests before running integration", () => {
    expect(integration).toContain("runs-on: ubuntu-latest");
    const validate = integration.indexOf("python3 -m unittest discover -s tests/ci");
    const start = integration.indexOf("python3 scripts/ci-local-supabase.py start");
    // The exact line: a substring match accepted `run: echo pnpm test:integration` (GPT-6 Sol review).
    const run = integration.search(/^        run: pnpm test:integration$/m);
    expect(validate).toBeGreaterThanOrEqual(0);
    expect(start).toBeGreaterThan(validate);
    expect(run).toBeGreaterThan(start);
    const requiredSteps = integration.slice(0, run);
    expect(requiredSteps).not.toMatch(/continue-on-error:|\bif:|\|\|\s*(true|exit 0)/);
    expect(integration).toMatch(/if: always\(\)[\s\S]*supabase stop --no-backup/);
  });

  it("exports every required connection setting from the validated local helper", () => {
    for (const name of ["SUPABASE_TEST_URL", "SUPABASE_TEST_ANON_KEY",
      "SUPABASE_TEST_SERVICE_ROLE_KEY", "SUPABASE_TEST_DB_URL"]) {
      expect(helper).toContain(`"${name}": values[`);
      expect(integration).not.toContain(`secrets.${name}`);
    }
    expect(helper).toContain("exported, pg = local_environment(status)");
    expect(helper).toContain('open(os.environ["GITHUB_ENV"]');
  });
});
