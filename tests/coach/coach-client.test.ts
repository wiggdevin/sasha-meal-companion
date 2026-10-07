import { beforeEach, describe, expect, it, vi } from "vitest";
import { cacheKey, CoachError, draftToProposeResponse, postTurn, readCache, writeCache }
  from "@/lib/coach-client";
import { bindAccount, unbindAccount, type AccountHandle } from "@/lib/device/account";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
let h: AccountHandle;

// vitest.config.ts sets environment "node" and no DOM package is installed (no new
// dependencies), so localStorage is stubbed the way tests/barcode/scan-cache.test.ts does.
const store = new Map<string, string>();
beforeEach(() => {
  vi.restoreAllMocks();
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
  });
  localStorage.clear();
  unbindAccount();
  h = bindAccount(A);
});

describe("the transcript cache", () => {
  it("keys on the thread and keeps action status and undo tokens beside the last 50 messages", () => {
    expect(cacheKey(h, "t1")).toBe(`smc:u:${A}:coach:t1`);
    const action = { actionId: "a1", kind: "move_slot" as const, date: "2026-09-16",
      slot: "meal-3" as const, time: "19:30", flagged: [] };
    const token = { kind: "move_slot" as const, date: "2026-09-16", slot: "meal-3" as const,
      baseMealId: "dinner", planned: [], previous: null };
    writeCache(h, "t1", {
      messages: Array.from({ length: 60 }, (_, i) =>
        ({ id: `m${i}`, role: "user" as const, content: `x${i}`, seq: i })),
      actions: [{ action, status: "applied", token, messageId: "m59" }],
    });
    const cached = readCache(h, "t1");
    expect(cached.messages).toHaveLength(50);
    expect(cached.messages[0].seq).toBe(10);
    expect(cached.actions).toEqual([{ action, status: "applied", token, messageId: "m59" }]);
  });

  it("returns an empty transcript when storage is unavailable or corrupt", () => {
    localStorage.setItem(cacheKey(h, "t2"), "not json");
    expect(readCache(h, "t2")).toEqual({ messages: [], actions: [] });
  });

  it("reads the old message-array cache shape with no actions", () => {
    localStorage.setItem(cacheKey(h, "t3"), JSON.stringify([
      { id: "m1", role: "user", content: "hello", seq: 1 },
    ]));
    expect(readCache(h, "t3")).toEqual({
      messages: [{ id: "m1", role: "user", content: "hello", seq: 1 }], actions: [],
    });
  });
});

describe("postTurn", () => {
  it("raises CoachError with retryAfterSeconds on 429", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: "rate_limited", message: "slow down", retryAfterSeconds: 1800 }),
      { status: 429, headers: { "content-type": "application/json" } })));
    const error = await postTurn({ threadId: null, messageId: "m", text: "hi" }).catch((e) => e);
    expect(error).toBeInstanceOf(CoachError);
    expect(error.retryAfterSeconds).toBe(1800);
    expect(error.code).toBe("rate_limited");
  });

  it("raises CoachError with code nous_unconfirmed on 503", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: "nous_unconfirmed", message: "not yet" }), { status: 503 })));
    const error = await postTurn({ threadId: null, messageId: "m", text: "hi" }).catch((e) => e);
    expect(error.status).toBe(503);
    expect(error.code).toBe("nous_unconfirmed");
  });
});

describe("draftToProposeResponse", () => {
  it("maps a CoachDraft onto the confirm-sheet shape, one item per draft item", () => {
    const response = draftToProposeResponse({
      draftId: "d1", slot: "meal-2",
      items: [{ foodRefId: "3f1b1a2c-0000-4000-8000-00000000002a", name: "white rice",
        grams: 150, catalogFoodRevisionId: 44 }],
    });
    expect(response).toMatchObject({ draftId: "d1", method: "text" });
    expect(response.items[0]).toMatchObject({
      seq: 0, label: "white rice", grams: 150, qty: 1, unit: "g",
      catalogFoodRevisionId: 44, autoResolved: true,
      policy: { verdict: "allowed" },
    });
    expect(response.items[0].alternatives).toEqual([]);
    expect(response.notes).toEqual([]);
  });

  it("maps a real per-item verdict through instead of hardcoding \"allowed\"", () => {
    const response = draftToProposeResponse({
      draftId: "d2", slot: "meal-2",
      items: [{ foodRefId: "3f1b1a2c-0000-4000-8000-00000000002a", name: "mystery stew",
        grams: 200, catalogFoodRevisionId: null, verdict: "unverified" }],
    });
    expect(response.items[0].policy).toEqual({ verdict: "unverified" });
  });
});
