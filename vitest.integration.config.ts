import { defineConfig } from "vitest/config";
import base from "./vitest.config";
import { integrationTestFiles } from "./scripts/ci-integration-files";

// `pnpm test:integration`: only the files that behave differently with a database
// (scripts/ci-integration-files.ts). The unit run covers everything else. A spread, not
// mergeConfig: mergeConfig concatenates `include` with the base glob and selects every file.
// With VITEST_JSON_REPORT set (the CI job), it also writes a JSON report for the skip gate
// (scripts/ci-skip-ceiling.ts).
const jsonReport = process.env.VITEST_JSON_REPORT;

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: integrationTestFiles(__dirname),
    ...(jsonReport ? { reporters: ["default", "json"], outputFile: { json: jsonReport } } : {}),
  },
});
