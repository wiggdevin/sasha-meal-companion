import { defineConfig } from "vitest/config";
import base from "./vitest.config";
import { integrationTestFiles } from "./scripts/ci-integration-files";

// `pnpm test:integration`: only the files that behave differently with a database
// (scripts/ci-integration-files.ts). The unit run covers everything else. A spread, not
// mergeConfig: mergeConfig concatenates `include` with the base glob and selects every file.
export default defineConfig({
  ...base,
  test: { ...base.test, include: integrationTestFiles(__dirname) },
});
