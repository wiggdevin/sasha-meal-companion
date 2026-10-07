/**
 * Scale S2: lib/server/ratelimit.ts holds the service-role client (it calls `rate_limit_hit`).
 * Canary: user B exhausting B's own key never refuses user A — the keys are per account, so the
 * shared database counter cannot leak one account's window into another's.
 */
// Refuses any non-local database before anything else runs.
import "./local-only";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HAS_BRANCH, HAS_DB, ensureUser, type TestUser } from "../helpers/supabase";
import {
  dbRateLimitStore, enforceRateLimit, resetRateLimits, setRateLimitStore,
} from "@/lib/server/ratelimit";

describe.skipIf(!HAS_BRANCH || !HAS_DB)("admin entry: lib/server/ratelimit (canary)", () => {
  let a: TestUser;
  let b: TestUser;
  const run = crypto.randomUUID();

  beforeAll(async () => {
    a = await ensureUser("a");
    b = await ensureUser("b");
    setRateLimitStore(dbRateLimitStore());
    resetRateLimits();
  });
  afterAll(() => {
    setRateLimitStore(null);
    resetRateLimits();
  });

  it("B's exhausted window never refuses A", async () => {
    const key = (user: TestUser) => `canary:${run}:${user.id}`;
    await enforceRateLimit(key(b), 2, 60);
    await enforceRateLimit(key(b), 2, 60);
    await expect(enforceRateLimit(key(b), 2, 60)).rejects.toMatchObject({ status: 429 });
    await expect(enforceRateLimit(key(a), 2, 60)).resolves.toBeUndefined();
  });

  it("a refused key is answered from memory but every allowed hit is counted by the database", async () => {
    const key = `canary:${run}:counted:${a.id}`;
    await enforceRateLimit(key, 3, 60);
    await enforceRateLimit(key, 3, 60);
    // A second instance (fresh memory) sees the database count, not its own empty Map.
    resetRateLimits();
    await enforceRateLimit(key, 3, 60);
    await expect(enforceRateLimit(key, 3, 60)).rejects.toMatchObject({ status: 429 });
  });
});
