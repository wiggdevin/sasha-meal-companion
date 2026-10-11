import { defineConfig, defaultExclude } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.{ts,tsx}"],
    // A stray worktree under .claude/worktrees/ (another agent session) carries its own copy of
    // every test file; without this, a plain local run double-counts and can cross-run them.
    exclude: [...defaultExclude, ".claude/**"],
    setupFiles: ["tests/helpers/attested-env.ts", "tests/helpers/drain-scheduler.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      // The Next.js `server-only` marker throws outside a Server Component; tests import server
      // modules directly, so resolve it to an empty module.
      "server-only": path.resolve(__dirname, "tests/helpers/server-only.ts"),
    },
  },
});
