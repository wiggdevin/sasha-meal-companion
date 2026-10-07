import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangeRow } from "@/lib/sync/types";

const rpc = vi.fn();
const requireUser = vi.fn();
const enforceRateLimit = vi.fn();

vi.mock("@/lib/server/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/auth")>("@/lib/server/auth");
  return { ...actual, requireUser: (req: Request) => requireUser(req) };
});
vi.mock("@/lib/server/ratelimit", () => ({
  enforceRateLimit: (...args: unknown[]) => enforceRateLimit(...args),
}));

const { GET } = await import("@/app/api/sync/changes/route");
const { HttpError } = await import("@/lib/server/auth");

const change = (seq: number): ChangeRow => ({
  seq, entity: "water_log", entity_key: "2026-09-11", rev: seq, op: "update",
  at: "2026-09-11T10:00:00.000Z", current: { local_date: "2026-09-11", cups: seq },
});

const get = (query: string) => GET(new Request(`https://x.test/api/sync/changes${query}`));

beforeEach(() => {
  rpc.mockReset().mockResolvedValue({ data: [], error: null });
  enforceRateLimit.mockReset().mockResolvedValue(undefined);
  requireUser.mockReset().mockResolvedValue({ userId: "u1", client: { rpc } });
});

describe("GET /api/sync/changes", () => {
  it("returns 401 with no session", async () => {
    requireUser.mockRejectedValue(new HttpError(401, "unauthorized"));
    expect((await get("?since=0")).status).toBe(401);
  });

  it("rate-limits 60 a minute per user", async () => {
    await get("?since=0");
    expect(enforceRateLimit).toHaveBeenCalledWith("sync:changes:u1", 60, 60, "fail_open");
  });

  it("rejects a non-numeric since, a negative since and a non-numeric limit", async () => {
    const res = await get("?since=yesterday");
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "bad_request" });
    expect((await get("?since=-1")).status).toBe(400);
    expect((await get("?since=0&limit=lots")).status).toBe(400);
  });

  it("defaults since to 0 and limit to 500, and clamps limit to 500", async () => {
    await get("");
    expect(rpc).toHaveBeenCalledWith("sync_changes", { p_user_id: "u1", p_since: 0, p_limit: 500 });
    await get("?since=7&limit=9000");
    expect(rpc).toHaveBeenLastCalledWith("sync_changes", { p_user_id: "u1", p_since: 7, p_limit: 500 });
  });

  it("reports next_cursor as the last seq and has_more when the page is full", async () => {
    rpc.mockResolvedValue({ data: [change(8), change(9)], error: null });
    const body = await (await get("?since=7&limit=2")).json();
    expect(body).toMatchObject({ next_cursor: 9, has_more: true });
    expect(body.changes).toHaveLength(2);
  });

  it("keeps the caller's cursor when the page is empty", async () => {
    await expect((await get("?since=7")).json()).resolves.toMatchObject({
      changes: [], next_cursor: 7, has_more: false,
    });
  });
});
