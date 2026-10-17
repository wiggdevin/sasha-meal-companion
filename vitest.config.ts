import { defineConfig, defaultExclude } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.{ts,tsx}"],
    // A stray worktree under .claude/worktrees/ (another agent session) carries its own copy of
    // every test file; without this, a plain local run double-counts and can cross-run them.
    exclude: [...defaultExclude, ".claude/**"],
    // Flake mechanism (F7, W077): the 5 s default test budget and 10 s hook budget are tuned for an idle
    // machine. CI runs four shards of parallel workers, and a test that costs 2-4.5 s alone (a cold
    // import of a big screen, a source-tree scan, a 1,200-row fake read, a 150-case property run) then
    // overruns them at random. Every flake fixed so far was that (#67, #95-#99), so the budget is set once here
    // rather than per test. It only lengthens the wait before a hang is reported: no test is retried, skipped or loosened.
    testTimeout: 20_000,
    hookTimeout: 30_000,
    setupFiles: ["tests/helpers/attested-env.ts", "tests/helpers/drain-scheduler.ts", "tests/helpers/rate-limit-reset.ts"],
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
