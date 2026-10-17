/**
 * Phase 18 W2b, acceptance 4 (phone half): a rule changed on another device moves the server's
 * token, so the next new-suggestion request refetches its admission, and an admission stamped with
 * the old token is never used. Offline, no new suggestion is made (owner question 6).
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindAccount } from "@/lib/device/account";
import { CLOSED_CACHE_MAX_MS, loadEligibleLocalFoodIds, resetEligibleCache } from "@/lib/foods/eligible-client";
import { noteFoodRulesChanged } from "@/lib/foods/rules-epoch";
import { RANKING_VERSION, SNAPSHOT_SCHEMA_VERSION } from "@/lib/meals/snapshot";
import { putRow } from "@/lib/sync/idb";
import { resetTestAccount } from "@/tests/helpers/account";
import { eats, F } from "@/tests/helpers/meal-foods";
import { freshness, parseRulesToken, sameRulesToken, type RulesToken } from "@/lib/foods/world/freshness";
import { freshAdmission } from "@/lib/foods/world/rules-version-client";

const t = (rulesVersion: number, evidenceVersion = 1): RulesToken => ({ rulesVersion, evidenceVersion });
type Held = { token: RulesToken | null; ids: string[] };

describe("the freshness token", () => {
  it("parses only two non-negative integer counters", () => {
    expect(parseRulesToken({ rulesVersion: 3, evidenceVersion: 0 })).toEqual(t(3, 0));
    for (const bad of [null, {}, { rulesVersion: "3", evidenceVersion: 1 }, { rulesVersion: -1, evidenceVersion: 1 },
      { rulesVersion: 1.5, evidenceVersion: 1 }, { rulesVersion: 1 }]) expect(parseRulesToken(bad)).toBeNull();
  });

  it("is fresh only when both counters match, and never offline", () => {
    expect(freshness(t(4), t(4))).toEqual({ fresh: true });
    expect(freshness(t(4), t(5))).toEqual({ fresh: false, reason: "stale" });
    expect(freshness(t(4, 1), t(4, 2))).toEqual({ fresh: false, reason: "stale" });
    expect(freshness(t(4), null)).toEqual({ fresh: false, reason: "offline" });
    expect(freshness(null, t(4))).toEqual({ fresh: false, reason: "unstamped" });
    expect(sameRulesToken(null, null)).toBe(false);
  });
});

describe("freshAdmission (W2b acceptance 4)", () => {
  const held: Held = { token: t(4), ids: ["bread"] };

  it("reuses the held admission while the server still reports its token", async () => {
    const refetch = vi.fn();
    expect(await freshAdmission(held, { readToken: async () => t(4), refetch })).toBe(held);
    expect(refetch).not.toHaveBeenCalled();
  });

  it("refetches after a rule change on another device and uses the new admission", async () => {
    const next: Held = { token: t(5), ids: [] };
    const refetch = vi.fn(async () => next);
    expect(await freshAdmission(held, { readToken: async () => t(5), refetch })).toBe(next);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("admits nothing under the old revision: a refetch still stamped with it is refused", async () => {
    const stale: Held = { token: t(4), ids: ["bread"] };
    expect(await freshAdmission(held, { readToken: async () => t(5), refetch: async () => stale })).toBeNull();
  });

  it("accepts a refetch computed under a newer token only when that token is current", async () => {
    const tokens = [t(5), t(6)];
    const newer: Held = { token: t(6), ids: [] };
    expect(await freshAdmission(held, { readToken: async () => tokens.shift() ?? t(6), refetch: async () => newer }))
      .toBe(newer);
    const moving = [t(5), t(7)];
    expect(await freshAdmission(held, { readToken: async () => moving.shift() ?? t(7), refetch: async () => newer }))
      .toBeNull();
  });

  it("makes no new suggestion offline or when the refetch fails", async () => {
    expect(await freshAdmission(held, { readToken: async () => null, refetch: async () => held })).toBeNull();
    expect(await freshAdmission(held, { readToken: async () => t(5),
      refetch: async () => { throw new Error("409 rules_changed"); } })).toBeNull();
    expect(await freshAdmission(null, { readToken: async () => null, refetch: async () => held })).toBeNull();
  });
});

/**
 * W047 (d): a closed account's eligible set is reused, through the real phone loader and a server
 * double, only while the server's token, its rule boundary and every local input are unchanged.
 * A stale cache must never admit a food under older rules.
 */
describe("the closed-world eligible cache (W047 d)", () => {
  const A = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const FOODS = eats(F.eggs, F.toast, F.tuna);
  type Server = { token: RulesToken | null; world: "open" | "closed"; boundary?: string | null;
    ids: string[]; asked: string[] };
  let server: Server;
  const body = () => ({ schemaVersion: SNAPSHOT_SCHEMA_VERSION, rankingVersion: RANKING_VERSION, accountId: A,
    computedAt: new Date().toISOString(), inputsHash: "h", foods: {},
    eligible: { eligibleRefIds: [], eligibleFoodIds: server.ids, eligibleCatalogFoodIds: [], excluded: [],
      rulesRevision: 1, preferenceFlags: [] } });

  beforeEach(async () => {
    await resetTestAccount(A);
    globalThis.indexedDB = new IDBFactory();
    resetEligibleCache();
    server = { token: t(7, 3), world: "closed", boundary: null, ids: Object.keys(FOODS), asked: [] };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      server.asked.push(url);
      if (url === "/api/foods/rules-version") {
        if (!server.token) throw new TypeError("Failed to fetch");
        return Response.json({ ...server.token, world: server.world,
          ...(server.boundary === undefined ? {} : { ruleBoundaryAt: server.boundary }) });
      }
      if (url === "/api/foods/eligible?v=3") return Response.json(body());
      return new Response("not found", { status: 404 });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  /** One read; the first read of a page may move the rules epoch (a new revision seen), so warm up. */
  const read = async () => {
    server.asked = [];
    const set = await loadEligibleLocalFoodIds(bindAccount(A), FOODS);
    return { set, asked: server.asked };
  };
  const warm = async () => { await read(); await read(); };

  it("an unchanged key costs one token read and returns the same set", async () => {
    await warm();
    const first = await read();
    expect(first.asked).toEqual(["/api/foods/rules-version"]);
    const again = await read();
    expect(again.asked).toEqual(["/api/foods/rules-version"]);
    expect(again.set).toBe(first.set);
  });

  it.each([
    ["the rules token moved (a rule written on another device)", () => { server.token = t(8, 3); }],
    ["the evidence token moved", () => { server.token = t(7, 4); }],
    ["the account's world opened", () => { server.world = "open"; }],
    ["the server stopped reporting a rule boundary (an older server)", () => { server.boundary = undefined; }],
    ["the token cannot be read (offline or an error)", () => { server.token = null; }],
  ])("%s: a full read, never the cached set", async (_name, change) => {
    await warm();
    const held = (await read()).set;
    change();
    server.ids = [Object.keys(FOODS)[0]];
    const next = await read();
    expect(next.asked).toContain("/api/foods/eligible?v=3");
    expect(next.set).not.toBe(held);
  });

  it("a rule added on another device: the food it now blocks is never served from the cache", async () => {
    server.ids = Object.keys(FOODS).slice(1);
    await warm();
    const blocked = Object.keys(FOODS)[0];
    expect((await read()).set.has(blocked)).toBe(false);
    // Now the reverse: a rule ADDED elsewhere blocks a food the cached set admits.
    server.ids = Object.keys(FOODS).slice(1, 2);
    server.token = t(8, 3);
    const next = await read();
    expect([...next.set]).toEqual(Object.keys(FOODS).slice(1, 2));
  });

  it.each([
    ["a local rule write (the rules epoch)", () => { noteFoodRulesChanged(); }],
    ["a local log or a pulled row (the eaten-history watermark)", async () => {
      await putRow(bindAccount(A), "log_entries", "log-1", { id: "log-1", user_id: A, slot: "meal-1",
        local_date: "2026-10-17", rev: 1, items: [] });
    }],
  ])("%s: a full read", async (_name, change) => {
    await warm();
    await read();
    await change();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await read()).asked).toContain("/api/foods/eligible?v=3");
  });

  it("an Eats food changed on this phone: a full read", async () => {
    await warm();
    server.asked = [];
    await loadEligibleLocalFoodIds(bindAccount(A), { ...FOODS, [Object.keys(FOODS)[0]]: {
      ...FOODS[Object.keys(FOODS)[0]], status: "avoid" } });
    expect(server.asked).toContain("/api/foods/eligible?v=3");
  });

  it("a calendar or expiring hard rule's boundary passes: a full read, with no token move", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-17T03:00:00Z"));
    server.boundary = "2026-10-17T03:05:00Z"; // e.g. a fasting window opening at dawn
    await warm();
    expect((await read()).asked).toEqual(["/api/foods/rules-version"]);
    vi.setSystemTime(new Date("2026-10-17T03:05:00Z"));
    expect((await read()).asked).toContain("/api/foods/eligible?v=3");
  });

  it.each([
    ["to a later one", "2026-10-17T09:00:00Z"],
    ["to none", null],
  ])("the server's boundary passed while this phone's clock is behind (it moved %s): a full read",
    async (_name, next) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-17T03:00:00Z"));
      server.boundary = "2026-10-17T03:05:00Z";
      await warm();
      expect((await read()).asked).toEqual(["/api/foods/rules-version"]);
      // The server's clock passed 03:05 and the window opened; the phone still reads 03:00.
      server.boundary = next;
      expect((await read()).asked).toContain("/api/foods/eligible?v=3");
    });

  it("a first read whose token cannot be read caches nothing", async () => {
    server.token = null;
    await read();
    server.token = t(7, 3);
    expect((await read()).asked).toContain("/api/foods/eligible?v=3");
  });

  it("a new local date or an age past the cap: a full read", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-17T12:00:00"));
    await warm();
    vi.setSystemTime(new Date(Date.now() + CLOSED_CACHE_MAX_MS + 1));
    expect((await read()).asked).toContain("/api/foods/eligible?v=3");
    await read();
    vi.setSystemTime(new Date("2026-10-18T00:00:01"));
    expect((await read()).asked).toContain("/api/foods/eligible?v=3");
  });

  it("a rule that moved between the token read and the body is caught on the next read", async () => {
    await warm();
    resetEligibleCache();
    // The token is read (7), then a rule lands before the body is built: the body is newer.
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const res = await realFetch(url);
      if (url === "/api/foods/rules-version") server.token = t(8, 3);
      return res;
    }));
    await read();
    vi.stubGlobal("fetch", realFetch);
    // Cached under 7; the server now says 8: the next read is a full one.
    expect((await read()).asked).toContain("/api/foods/eligible?v=3");
  });
});
