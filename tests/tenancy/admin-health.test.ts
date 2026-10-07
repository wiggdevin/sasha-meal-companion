/**
 * Scale S1: GET /api/health holds the service-role client, so it is an admin entry point. It has no
 * session and no account: the canary proves it answers only liveness fields and touches no account.
 */
import "./local-only";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HAS_BRANCH, HAS_DB, ensureUser, type TestUser } from "../helpers/supabase";
import { accountSnapshot, purge } from "./seed";

describe.skipIf(!HAS_BRANCH || !HAS_DB)("health route admin canary", () => {
  let a: TestUser;
  let b: TestUser;

  beforeAll(async () => {
    [a, b] = await Promise.all([ensureUser("a"), ensureUser("b")]);
    await purge([a.id, b.id]);
  });

  afterAll(async () => { if (a && b) await purge([a.id, b.id]); });

  it("answers liveness only and leaves both accounts' canary rows unchanged", async () => {
    const { GET } = await import("@/app/api/health/route");
    const before = [accountSnapshot(a.id), accountSnapshot(b.id)];
    const res = await GET(new Request("https://a.test/api/health", { headers: { "x-real-ip": "203.0.113.9" } }));
    const body = await res.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["db", "ok", "version"]);
    expect(JSON.stringify(body)).not.toContain(a.id);
    expect(JSON.stringify(body)).not.toContain(b.id);
    expect([accountSnapshot(a.id), accountSnapshot(b.id)]).toEqual(before);
  });
});
