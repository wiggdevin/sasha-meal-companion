/**
 * W13 (D14): onboarding's open-world default is DURABLE (Sol round 2 BLOCK). The intent is stored
 * before any network call, a failed or unsettled POST keeps it, and the post-sync catch-up
 * re-posts until the server settles it. Also keeps the round-1 rule: flush the outbox before the
 * first POST, since the onboarded_at write it follows is only queued locally.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  fetch: vi.fn(), flush: vi.fn(), meta: new Map<string, unknown>(), metaBroken: false,
}));
vi.mock("@/lib/device/account", () => ({
  accountHandle: () => ({ userId: "account-a", epoch: 1 }),
  accountFetch: (_h: unknown, url: string, init?: RequestInit) => mocked.fetch(url, init),
  accountJson: async (_h: unknown, res: Response) => res.json(),
  assertCurrent: () => undefined,
  rethrowAccountChanged: () => undefined,
}));
vi.mock("@/lib/sync/client", () => ({ flushOutboxNow: (h: unknown) => mocked.flush(h) }));
vi.mock("@/lib/sync/idb", () => ({
  getRow: async () => undefined,
  getMeta: async (h: { userId: string }, key: string) => mocked.meta.get(`${h.userId}:${key}`),
  putMeta: async (h: { userId: string }, key: string, value: unknown) => {
    if (mocked.metaBroken) throw new Error("no indexeddb");
    mocked.meta.set(`${h.userId}:${key}`, value);
  },
  deleteMeta: async (h: { userId: string }, key: string) => { mocked.meta.delete(`${h.userId}:${key}`); },
}));

import { openFoodWorld } from "@/lib/profile/onboarding-client";
import {
  clearWorldOpenPending, drainWorldOpenPending, isWorldOpenPending,
} from "@/lib/foods/world-open-client";

const H = { userId: "account-a", epoch: 1 };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  mocked.fetch.mockReset(); mocked.flush.mockReset(); mocked.meta.clear(); mocked.metaBroken = false;
});

describe("openFoodWorld (onboarding first completion)", () => {
  it("flushes the outbox before posting, so the just-queued onboarded_at write lands first", async () => {
    mocked.flush.mockResolvedValue(true);
    mocked.fetch.mockResolvedValue(json(200, { world: "open" }));
    await openFoodWorld(H as never);
    expect(mocked.flush).toHaveBeenCalledTimes(1);
    expect(mocked.fetch).toHaveBeenCalledWith("/api/foods/world", expect.objectContaining({ method: "POST" }));
    expect(await isWorldOpenPending(H as never)).toBe(false);
  });

  it("a failed flush posts nothing now but KEEPS the intent; the next catch-up opens the world", async () => {
    mocked.flush.mockResolvedValue(false);
    await openFoodWorld(H as never);
    expect(mocked.fetch).not.toHaveBeenCalled();
    expect(await isWorldOpenPending(H as never)).toBe(true);
    mocked.fetch.mockResolvedValue(json(200, { world: "open" }));
    expect(await drainWorldOpenPending(H as never)).toBe("opened");
    expect(await isWorldOpenPending(H as never)).toBe(false);
  });

  it("a 503 at completion keeps the intent, and a later pass re-posts until the server confirms open", async () => {
    mocked.flush.mockResolvedValue(true);
    mocked.fetch.mockResolvedValueOnce(json(503, { error: "unavailable" }));
    await openFoodWorld(H as never);
    expect(await isWorldOpenPending(H as never)).toBe(true);
    mocked.fetch.mockRejectedValueOnce(new Error("offline"));
    expect(await drainWorldOpenPending(H as never)).toBe("retry");
    mocked.fetch.mockResolvedValueOnce(json(409, { error: "profile_required" }));
    expect(await drainWorldOpenPending(H as never)).toBe("retry");
    expect(await isWorldOpenPending(H as never)).toBe(true);
    mocked.fetch.mockResolvedValueOnce(json(200, { world: "open" }));
    expect(await drainWorldOpenPending(H as never)).toBe("opened");
    expect(await isWorldOpenPending(H as never)).toBe(false);
    expect(mocked.fetch).toHaveBeenCalledTimes(4);
    expect(await drainWorldOpenPending(H as never)).toBe("none");
    expect(mocked.fetch).toHaveBeenCalledTimes(4);
  });

  it("never throws when the post itself fails", async () => {
    mocked.flush.mockResolvedValue(true);
    mocked.fetch.mockRejectedValue(new Error("offline"));
    await expect(openFoodWorld(H as never)).resolves.toBeUndefined();
    expect(await isWorldOpenPending(H as never)).toBe(true);
  });

  it("still tries once when the device cannot store the intent", async () => {
    mocked.metaBroken = true;
    mocked.flush.mockResolvedValue(true);
    mocked.fetch.mockResolvedValue(json(200, { world: "open" }));
    await openFoodWorld(H as never);
    expect(mocked.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("drainWorldOpenPending: which answers settle the intent", () => {
  it.each([
    ["423 held", json(423, { error: "held" })],
    ["423 unreleased", json(423, { error: "open_world_not_released" })],
    ["409 condition_review", json(409, { error: "condition_review", conditions: ["ckd"] })],
    ["400", json(400, { error: "bad_request" })],
  ])("clears on %s (the invitation covers it later)", async (_label, res) => {
    mocked.meta.set("account-a:food_world_open_pending", { since: "2026-10-07T00:00:00Z" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocked.fetch.mockResolvedValue(res);
    expect(await drainWorldOpenPending(H as never)).toBe("settled");
    expect(await isWorldOpenPending(H as never)).toBe(false);
  });

  it.each([
    ["500", json(500, {})], ["401", json(401, {})], ["429", json(429, {})],
    ["a 200 that does not say open", json(200, { world: "closed" })],
  ])("keeps the intent on %s", async (_label, res) => {
    mocked.meta.set("account-a:food_world_open_pending", { since: "2026-10-07T00:00:00Z" });
    mocked.fetch.mockResolvedValue(res);
    expect(await drainWorldOpenPending(H as never)).toBe("retry");
    expect(await isWorldOpenPending(H as never)).toBe(true);
  });

  it("an explicit choice clears the intent, so no retry overrides it", async () => {
    mocked.meta.set("account-a:food_world_open_pending", { since: "2026-10-07T00:00:00Z" });
    await clearWorldOpenPending(H as never);
    expect(await drainWorldOpenPending(H as never)).toBe("none");
    expect(mocked.fetch).not.toHaveBeenCalled();
  });
});
