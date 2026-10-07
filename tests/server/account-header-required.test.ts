/**
 * PR #248 review r3 #1: once this build ships, a request with no `x-smc-account` header is an old
 * tab. It may hold A's screen while the shared cookie is now B's, so an account-data route answers
 * 401 `account_header_required` and runs no query — no export of B's data, no write under B.
 *
 * 401 is chosen on purpose: the old build treats it as a lapsed session, so its commit path queues
 * the entry (origin/main lib/log-commit-client.ts:49, RETRY_STATUSES) and a failed sync pass leaves
 * its outbox ops queued (origin/main lib/sync/client.ts:204-205, 225). Nothing is dropped; the
 * service worker v3 reload then brings the tab onto this build, which sends the header.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const getClaims = vi.fn();
const noQuery = () => { throw new Error("no query may run"); };
vi.mock("@/lib/supabase/server", () => ({
  createRequestClient: () => ({ auth: { getClaims }, from: noQuery, rpc: noQuery }),
  applyCookies: (res: Response) => res,
}));

beforeEach(() => {
  getClaims.mockResolvedValue({ data: { claims: { sub: B } }, error: null });
});

const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify(body) });

const ROUTES: Array<[string, () => Promise<Record<string, unknown>>, string, string, RequestInit?]> = [
  ["export", () => import("@/app/api/export/route"), "GET", "/api/export?kind=meals&format=csv"],
  ["weigh-in", () => import("@/app/api/health/weigh-in/route"), "POST", "/api/health/weigh-in",
    json({ localDate: "2026-09-22", lb: 170, tz: "UTC" })],
  ["sync ops", () => import("@/app/api/sync/ops/route"), "POST", "/api/sync/ops", json({ ops: [] })],
  ["sync changes", () => import("@/app/api/sync/changes/route"), "GET", "/api/sync/changes?since=0"],
  ["log commit", () => import("@/app/api/log/commit/route"), "POST", "/api/log/commit", json({})],
  ["targets", () => import("@/app/api/targets/route"), "GET", "/api/targets"],
];

describe("account-data routes refuse a request with no account header", () => {
  it.each(ROUTES)("%s answers 401 account_header_required", async (_name, load, method, path, init) => {
    const mod = await load();
    const handler = mod[method] as (req: Request) => Promise<Response>;
    const res = await handler(new Request(`https://app.test${path}`, { method, ...init }));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: "account_header_required" });
  });
});
