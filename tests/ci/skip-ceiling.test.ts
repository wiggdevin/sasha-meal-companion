import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkSkips, pgSuites, readCeiling, type Report } from "@/scripts/ci-skip-ceiling";
import { integrationTestFiles } from "@/scripts/ci-integration-files";

/** W040: the Integration job counts its skipped tests and fails above a recorded ceiling. */
const root = path.join(__dirname, "..", "..");
const PG = "tests/migrations/pg.test.ts";
const OTHER = "tests/a/other.test.ts";

function report(files: Record<string, string[]>): Report {
  const testResults = Object.entries(files).map(([name, statuses]) => ({
    name: path.join(root, name),
    assertionResults: statuses.map((status, i) => ({ status, fullName: `${name} #${i}` })),
  }));
  return { numTotalTests: testResults.reduce((n, f) => n + f.assertionResults.length, 0), testResults };
}

describe("skip ceiling check", () => {
  const pg = new Set([PG]);

  it("passes at or below the ceiling when the Postgres suites ran", () => {
    const verdict = checkSkips(report({ [PG]: ["passed", "passed"], [OTHER]: ["passed", "skipped"] }), 1, pg, root);
    expect(verdict.errors).toEqual([]);
    expect(verdict.skipped).toBe(1);
    expect(verdict.byFile.get(OTHER)).toEqual([`${OTHER} #1`]);
  });

  it("fails above the ceiling and counts todo and pending as skipped", () => {
    const verdict = checkSkips(report({ [PG]: ["passed"], [OTHER]: ["skipped", "todo", "pending"] }), 2, pg, root);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContain("3 tests skipped, above the ceiling of 2");
  });

  it("fails when a throwaway-Postgres test skipped, even under the ceiling", () => {
    const verdict = checkSkips(report({ [PG]: ["skipped", "passed"], [OTHER]: ["passed"] }), 50, pg, root);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join("\n")).toMatch(/pg\.test\.ts: 1 tests skipped in a throwaway-Postgres suite/);
  });

  it("fails when a Postgres suite is missing from the report", () => {
    const verdict = checkSkips(report({ [OTHER]: ["passed"] }), 5, pg, root);
    expect(verdict.errors).toContain(`${PG}: not in the report`);
  });

  it("fails on an empty or inconsistent report", () => {
    expect(checkSkips({}, 5, new Set(), root).errors).toContain("the report holds no tests");
    const short = { ...report({ [OTHER]: ["passed"] }), numTotalTests: 4 };
    expect(checkSkips(short, 5, new Set(), root).ok).toBe(false);
  });
});

describe("skip ceiling wiring", () => {
  const workflow = readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  const integration = workflow.match(/^  integration:\n([\s\S]*?)(?=^  [\w-]+:|$(?![\s\S]))/m)?.[1] ?? "";

  it("finds the five known throwaway-Postgres suites among the Integration files", () => {
    const suites = pgSuites(root, integrationTestFiles(root));
    for (const name of ["coach-undo-sql", "coach-undo-receipt-sql", "recipe-energy-rule-db",
      "health-ingest-record-db", "media-owner-paths-db"]) {
      expect(suites).toContain(`tests/migrations/${name}.test.ts`);
    }
  });

  it("sets PG_BIN, writes the report and checks it after the suite, all unconditional", () => {
    const pgBin = integration.indexOf('echo "PG_BIN=$bindir" >> "$GITHUB_ENV"');
    const run = integration.search(/^        run: pnpm test:integration$/m);
    const report = integration.indexOf("VITEST_JSON_REPORT: ${{ runner.temp }}/integration-report.json");
    const gate = integration.indexOf(
      'run: pnpm exec tsx scripts/ci-skip-ceiling.ts "${{ runner.temp }}/integration-report.json"');
    expect(pgBin).toBeGreaterThan(0);
    expect(run).toBeGreaterThan(pgBin);
    expect(report).toBeGreaterThan(run);
    expect(gate).toBeGreaterThan(report);
    const stop = integration.indexOf("- name: Stop local Supabase");
    expect(integration.slice(0, stop)).not.toMatch(/continue-on-error:|\bif:|\|\|\s*(true|exit 0)/);
  });

  it("records the same ceiling in the docs as in the gate", () => {
    const ceiling = readCeiling(root);
    expect(Number.isInteger(ceiling)).toBe(true);
    const doc = readFileSync(path.join(root, "docs", "ci", "skipped-tests.md"), "utf8");
    expect(doc).toContain(`## Ceiling: ${ceiling}`);
  });
});
