/**
 * W035: every coach turn reserves a slot in the shared limiter (lib/server/coach.ts
 * `reserveTurn`), which unit tests run in memory. Each test starts with empty windows, so a file
 * whose tests run many turns for one fixture user never trips the 10-an-hour budget by accident.
 *
 * Imported inside the hook, not at the top: a module a setup file imports is cached before the
 * test file's vi.mock calls apply, and a test that mocks the limiter must still get its mock.
 */
import { beforeEach } from "vitest";

beforeEach(async () => {
  const limiter = await import("@/lib/server/ratelimit");
  try {
    // A mock factory without this export throws on the read; such a test owns its limiter.
    if (typeof limiter.resetRateLimits === "function") limiter.resetRateLimits();
  } catch {
    // nothing to reset
  }
});
