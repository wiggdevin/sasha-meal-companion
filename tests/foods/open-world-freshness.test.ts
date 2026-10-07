/**
 * Phase 18 W8 (phone): the open food-world snapshot's freshness, through the real phone loader
 * (lib/foods/eligible-client.ts), the real snapshot store (fake IndexedDB) and a server double
 * answering `GET /api/foods/rules-version` and `GET /api/foods/eligible?v=3`.
 *
 * Acceptance 6: a snapshot under an older `rulesVersion` or `evidenceVersion`, older than 7 days,
 *   or for another account gives no new suggestion.
 * Acceptance 10: device A holds a fresh snapshot that admits a food; device B marks it Avoid (and,
 *   separately, sets vegetarian, and clears an Avoid mark). A's next suggestion run sees the new
 *   `rulesVersion`, discards its snapshot and generates nothing under the old one.
 * Acceptance 12: an admitted food's evidence is corrected; `evidenceVersion` moves; A refetches and
 *   never uses the food again.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindAccount } from "@/lib/device/account";
import { baseFoodName } from "@/lib/foods/base-name";
import { loadEligibleLocalFoodIds } from "@/lib/foods/eligible-client";
import { MEAL_SNAPSHOT_KEY, readMealSnapshot, saveMealSnapshot, snapshotEpoch } from "@/lib/foods/meal-snapshot-store";
import { openWorldOf } from "@/lib/foods/rule-marks";
import { ownPlateEvidence } from "@/lib/foods/world/plate-evidence";
import { planDay, type DaySlot } from "@/lib/meals/day";
import { livePool } from "@/lib/meals/open-world";
import { SUGGESTIONS_NEED_CONNECTION } from "@/lib/meals/snapshot";
import type { MealSnapshotV3 } from "@/lib/meals/snapshot-v3";
import type { EligibleFoods } from "@/lib/server/eligible-foods";
import { putMeta } from "@/lib/sync/idb";
import { resetTestAccount } from "@/tests/helpers/account";
import { openSnapshot } from "@/tests/helpers/open-snapshot";
import type { RulesToken } from "@/lib/foods/world/freshness";

const A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const DAY = 86_400_000;
const CHICKEN = "universe:chicken-breast-roasted";

/** The server double: what each route answers now, and every URL asked. */
type Server = { token: RulesToken | null; body: MealSnapshotV3 | Record<string, unknown> | null; asked: string[] };
let server: Server;

function serve(): void {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    server.asked.push(url);
    if (url === "/api/foods/rules-version") {
      if (!server.token) throw new TypeError("Failed to fetch");
      return Response.json(server.token);
    }
    if (url === "/api/foods/eligible?v=3") {
      if (!server.body) throw new TypeError("Failed to fetch");
      return Response.json(server.body);
    }
    return new Response("not found", { status: 404 });
  }));
}

const body = (rulesVersion: number, evidenceVersion: number, options: Parameters<typeof openSnapshot>[0] = {}) =>
  openSnapshot({ accountId: A, rulesVersion, evidenceVersion, ...options });

const pool = async () => {
  const set = await loadEligibleLocalFoodIds(bindAccount(A), {});
  const open = openWorldOf(set);
  return { set, open, ids: open ? Object.keys(livePool(open, {})) : [] };
};

const SLOTS: DaySlot[] = ["08:00", "12:30", "19:00"].map((clock, i) => ({ id: `meal-${i + 1}` as DaySlot["id"], clock,
  target: { kcal: 600, protein: 40, carbs: 60, fat: 20 } }));

beforeEach(async () => {
  await resetTestAccount(A);
  globalThis.indexedDB = new IDBFactory();
  server = { token: { rulesVersion: 7, evidenceVersion: 3 }, body: body(7, 3), asked: [] };
  serve();
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("acceptance 10: a rule written on another device", () => {
  it("an Avoid mark on device B: A's next run refetches and never generates the food", async () => {
    const first = await pool();
    expect(first.ids).toContain(CHICKEN);
    expect((await readMealSnapshot(bindAccount(A)))?.snapshot.schemaVersion).toBe(3);
    // Device B marks chicken breast Avoid: the server's rules clock moves.
    server.token = { rulesVersion: 8, evidenceVersion: 3 };
    server.body = body(8, 3, { avoidNames: ["Chicken breast"] });
    server.asked = [];
    const next = await pool();
    expect(server.asked).toEqual(["/api/foods/rules-version", "/api/foods/eligible?v=3", "/api/foods/rules-version"]);
    expect(next.ids).not.toContain(CHICKEN);
    for (let d = 0; d < 30; d += 1) {
      const date = new Date(Date.parse("2026-10-06") + d * DAY).toISOString().slice(0, 10);
      const plan = planDay(date, SLOTS, livePool(next.open!, {}), undefined, next.open!.evidence, next.open!.taste,
        next.open!.ranking);
      for (const { plate } of plan.plates) {
        expect(plate.rows.some((row) => baseFoodName(row.food.name) === "chicken breast")).toBe(false);
      }
    }
  });

  it("an answer still admitted under the old token is never used, even when the server is slow to rebuild", async () => {
    await pool();
    server.token = { rulesVersion: 8, evidenceVersion: 3 };
    // The eligible route still answers the old admission (built before B's write committed).
    const next = await pool();
    expect(next.open).toBeUndefined();
    expect(next.set.size).toBe(0);
    expect(next.set.has(CHICKEN)).toBe(false);
  });

  it("a vegetarian flag set on device B: A's next run generates no meat", async () => {
    await pool();
    server.token = { rulesVersion: 8, evidenceVersion: 3 };
    server.body = body(8, 3, { flags: ["vegetarian"] });
    const next = await pool();
    expect(next.ids.length).toBeGreaterThan(20);
    for (const id of next.ids) {
      const name = next.open!.foods[id].name;
      expect([name, ownPlateEvidence(name).meat]).not.toEqual([name, "present"]);
    }
  });

  it("an Avoid mark cleared on device B: the food returns only after the refetch", async () => {
    server.body = body(7, 3, { avoidNames: ["Chicken breast"] });
    const held = await pool();
    expect(held.ids).not.toContain(CHICKEN);
    // B clears the mark. Until A's next run reads the new token, A's set still lacks the food.
    expect(held.set.has(CHICKEN)).toBe(false);
    server.token = { rulesVersion: 8, evidenceVersion: 3 };
    server.body = body(8, 3);
    expect((await pool()).ids).toContain(CHICKEN);
  });
});

describe("acceptance 12: an evidence correction", () => {
  it("evidenceVersion moves, A refetches, and the corrected food is not used in that run or any later one", async () => {
    const first = await pool();
    expect(first.ids).toContain(CHICKEN);
    server.token = { rulesVersion: 7, evidenceVersion: 4 };
    server.body = body(7, 4, { withhold: ["chicken-breast-roasted"] });
    for (let run = 0; run < 3; run += 1) {
      const next = await pool();
      expect(next.ids).not.toContain(CHICKEN);
      expect(next.set.has(CHICKEN)).toBe(false);
    }
  });
});

describe("acceptance 6: no new suggestion from a stale, old or foreign snapshot", () => {
  it("a held snapshot under the server's current token serves the run without a refetch", async () => {
    await pool();
    server.asked = [];
    const again = await pool();
    expect(server.asked).toEqual(["/api/foods/rules-version"]);
    expect(again.ids).toContain(CHICKEN);
  });

  it("offline (the token cannot be read), a held fresh snapshot gives no new suggestion", async () => {
    await pool();
    server.token = null;
    server.body = null;
    await expect(pool()).rejects.toThrow(SUGGESTIONS_NEED_CONNECTION);
  });

  it("a snapshot older than 7 days is never used; offline it gives no new suggestion", async () => {
    const account = bindAccount(A);
    const old = body(7, 3, { computedAt: new Date(Date.now() - 7 * DAY - 60_000).toISOString() });
    await saveMealSnapshot(account, old, old.eligible as EligibleFoods, await snapshotEpoch(account));
    expect(await readMealSnapshot(account)).toBeNull();
    server.token = null;
    server.body = null;
    await expect(pool()).rejects.toThrow(SUGGESTIONS_NEED_CONNECTION);
    // Online, an old answer from the server is refused too.
    server.token = { rulesVersion: 7, evidenceVersion: 3 };
    server.body = old;
    await expect(pool()).rejects.toThrow("Couldn’t check your food rules");
  });

  it("another account's snapshot is never used", async () => {
    const account = bindAccount(A);
    const foreign = body(7, 3, { accountId: B });
    await putMeta(account, MEAL_SNAPSHOT_KEY, { snapshot: foreign, eligible: foreign.eligible, epoch: 0 });
    expect(await readMealSnapshot(account)).toBeNull();
    server.body = foreign;
    await expect(pool()).rejects.toThrow("Couldn’t check your food rules");
  });

  it("a v3 body that does not parse generates nothing", async () => {
    const broken = JSON.parse(JSON.stringify(body(7, 3)));
    broken.admittedUniverseIds = [];
    server.body = broken;
    await expect(pool()).rejects.toThrow("Couldn’t check your food rules");
  });

  it("a closed account (v2 answer) never asks for the token", async () => {
    server.body = { schemaVersion: 2, rankingVersion: "o2.1", accountId: A, computedAt: new Date().toISOString(),
      inputsHash: "h", foods: {}, eligible: { eligibleRefIds: [], eligibleFoodIds: [], eligibleCatalogFoodIds: [],
        excluded: [], rulesRevision: 1, preferenceFlags: [] } };
    const set = await loadEligibleLocalFoodIds(bindAccount(A), {});
    expect(openWorldOf(set)).toBeUndefined();
    expect(server.asked).toEqual(["/api/foods/eligible?v=3"]);
  });
});
