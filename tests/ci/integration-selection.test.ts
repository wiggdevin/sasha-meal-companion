import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { integrationTestFiles } from "@/scripts/ci-integration-files";
import integrationConfig from "@/vitest.integration.config";

// Built from parts so this file itself is not selected for the Integration job.
const SETTING = ["SUPABASE", "TEST", "URL"].join("_");
const SKIP_IF = ["describe", "skipIf"].join(".");

describe("integration test selection", () => {
  const root = mkdtempSync(path.join(tmpdir(), "integration-select-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const write = (file: string, source: string) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), source);
  };
  write("tests/helpers/db.ts", `export const url = process.env.${SETTING};`);
  write("tests/helpers/cycle-a.ts", `import "./cycle-b";\nimport "./db";`);
  write("tests/helpers/cycle-b.ts", `import "./cycle-a";`);
  write("lib/server/admin.ts", `export const url = process.env.${SETTING};`);
  write("tests/a/direct.test.ts", `const u = process.env.${SETTING};`);
  write("tests/a/helper.test.ts", `import { url } from "../helpers/db";`);
  write("tests/a/alias.test.ts", `import { url } from "@/tests/helpers/db";`);
  write("tests/a/through-cycle.test.ts", `import "../helpers/cycle-b";`);
  write("tests/a/skips.test.ts", `${SKIP_IF}(!process.env.X)("db", () => {});`);
  write("tests/a/app-only.test.ts", `import { url } from "@/lib/server/admin";`);
  write("tests/a/plain.test.ts", `import { expect } from "vitest";`);
  write("lib/colocated.test.ts", `const u = process.env.${SETTING};`);

  it("selects files that skip or reach the database settings through test helpers", () => {
    expect(integrationTestFiles(root)).toEqual([
      "tests/a/alias.test.ts",
      "tests/a/direct.test.ts",
      "tests/a/helper.test.ts",
      "tests/a/skips.test.ts",
      "tests/a/through-cycle.test.ts",
    ]);
  });

  it("selects the repository's database suites and leaves the unit-only files to the unit run", () => {
    const files = integrationTestFiles(path.join(__dirname, "..", ".."));
    expect(files).toContain("tests/sync/food-membership-ops-db.test.ts");
    expect(files.length).toBeGreaterThanOrEqual(88);
    expect(files.length).toBeLessThan(200);
    expect(files.every((file) => file.startsWith("tests/"))).toBe(true);
  });

  it("gives the integration run exactly the selected files, not the base glob as well", () => {
    // mergeConfig would concatenate `include` with "**/*.test.{ts,tsx}" and run every file.
    const files = integrationTestFiles(path.join(__dirname, "..", ".."));
    expect(integrationConfig.test?.include).toEqual(files);
  });
});
