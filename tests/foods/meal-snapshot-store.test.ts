import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindAccount } from "@/lib/device/account";
import { loadEligibleLocalFoodIds, StampedEligibleSet } from "@/lib/foods/eligible-client";
import {
  invalidateMealSnapshot, MEAL_SNAPSHOT_KEY, readMealSnapshot, saveMealSnapshot, snapshotEpoch,
} from "@/lib/foods/meal-snapshot-store";
import { noteFoodRulesChanged } from "@/lib/foods/rules-epoch";
import { mealEvidenceOf } from "@/lib/foods/rule-marks";
import { swapAlternatives } from "@/lib/today/swap-alternatives";
import { planDay } from "@/lib/meals/day";
import { RANKING_VERSION, SNAPSHOT_SCHEMA_VERSION, SUGGESTIONS_NEED_CONNECTION, type MealSnapshotV2 } from "@/lib/meals/snapshot";
import type { EligibleFoods } from "@/lib/server/eligible-foods";
import { deleteRow, getMeta, mutateRowWithOp, putMeta, putRow, receiveSnapshotInputWriteForTests } from "@/lib/sync/idb";
import { enqueue } from "@/lib/sync/outbox";
import { resetTestAccount } from "@/tests/helpers/account";
import { BREAKFAST, eats, F } from "@/tests/helpers/meal-foods";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DAY = 86_400_000;
const FOODS = eats(F.eggs, F.toast, F.tuna, F.banana);

const ELIGIBLE: EligibleFoods = { eligibleRefIds: [], eligibleFoodIds: Object.keys(FOODS), eligibleCatalogFoodIds: [],
  excluded: [], rulesRevision: 1, preferenceFlags: [] };

function snapshot(accountId: string, computedAt = new Date().toISOString()): MealSnapshotV2 {
  const curated = { score: 0.5, source: "neutral" as const };
  const occasion = { breakfast: curated, lunch: curated, dinner: curated, snack: curated, other: curated };
  return { schemaVersion: SNAPSHOT_SCHEMA_VERSION, rankingVersion: RANKING_VERSION, accountId, computedAt,
    inputsHash: "h", foods: { tuna: { userRefId: null, catalogRefId: null, parts: ["anchor"], family: "tuna",
      occasion: { ...occasion, breakfast: { score: 0.93, source: "history" } } } } };
}

const online = (body: unknown) => vi.stubGlobal("fetch", vi.fn(async () => Response.json(body)));
const offline = () => vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));

beforeEach(async () => {
  await resetTestAccount(A);
  globalThis.indexedDB = new IDBFactory();
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("phone snapshot: online", () => {
  it("asks for v3 (a closed account answers v2), keeps the snapshot and hands its evidence to the day", async () => {
    const account = bindAccount(A);
    online({ ...snapshot(A), eligible: ELIGIBLE });
    const set = await loadEligibleLocalFoodIds(account, FOODS);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("/api/foods/eligible?v=3");
    expect([...set].sort()).toEqual(Object.keys(FOODS).sort());
    expect(mealEvidenceOf(set)?.history).toEqual({ "tuna, canned in water": { breakfast: 0.93 } });
    expect((await readMealSnapshot(account))?.snapshot.accountId).toBe(A);
  });

  it("reads a v1 answer (an older server) as before, with curated evidence only", async () => {
    const account = bindAccount(A);
    online(ELIGIBLE);
    const set = await loadEligibleLocalFoodIds(account, FOODS);
    expect(set.size).toBe(Object.keys(FOODS).length);
    expect(mealEvidenceOf(set)).toBeUndefined();
    expect(await readMealSnapshot(account)).toBeNull();
  });

  it("refuses a v2 answer for another account", async () => {
    const account = bindAccount(A);
    online({ ...snapshot(B), eligible: ELIGIBLE });
    await expect(loadEligibleLocalFoodIds(account, FOODS)).rejects.toThrow("Couldn’t check your food rules");
  });
});

describe("acceptance 8: offline needs a usable snapshot", () => {
  it("offline with a fresh snapshot of this account, a new suggestion is still made", async () => {
    const account = bindAccount(A);
    await saveMealSnapshot(account, snapshot(A), ELIGIBLE, await snapshotEpoch(account));
    offline();
    const set = await loadEligibleLocalFoodIds(account, FOODS);
    expect(set.size).toBe(Object.keys(FOODS).length);
    expect(mealEvidenceOf(set)?.history["tuna, canned in water"]).toBeDefined();
  });

  it("a snapshot older than 7 days yields no new suggestion", async () => {
    const account = bindAccount(A);
    await saveMealSnapshot(account, snapshot(A, new Date(Date.now() - 7 * DAY - 60_000).toISOString()), ELIGIBLE,
      await snapshotEpoch(account));
    expect(await readMealSnapshot(account)).toBeNull();
    offline();
    await expect(loadEligibleLocalFoodIds(account, FOODS)).rejects.toThrow(SUGGESTIONS_NEED_CONNECTION);
  });

  it("another account's snapshot yields no new suggestion, and is dropped", async () => {
    const account = bindAccount(A);
    await putMeta(account, MEAL_SNAPSHOT_KEY, { snapshot: snapshot(B), eligible: ELIGIBLE, epoch: 0 });
    offline();
    await expect(loadEligibleLocalFoodIds(account, FOODS)).rejects.toThrow(SUGGESTIONS_NEED_CONNECTION);
    await vi.waitFor(async () => expect(await getMeta(account, MEAL_SNAPSHOT_KEY)).toBeUndefined());
  });

  it("with no usable snapshot the day says why instead of suggesting", () => {
    const plan = planDay("2026-10-04", [{ id: "meal-1", target: BREAKFAST, clock: "07:30" }], FOODS, undefined, null);
    expect(plan.plates).toEqual([]);
    expect(plan.shortages).toEqual([{ slot: "meal-1", shortage: { missing: [], reason: SUGGESTIONS_NEED_CONNECTION } }]);
  });
});

describe("acceptance 7 (phone): invalidation and account switch", () => {
  it("an account switch never reads the previous account's snapshot", async () => {
    const a = bindAccount(A);
    await saveMealSnapshot(a, snapshot(A), ELIGIBLE, await snapshotEpoch(a));
    const b = await resetTestAccount(B);
    expect(await readMealSnapshot(b)).toBeNull();
    offline();
    await expect(loadEligibleLocalFoodIds(b, FOODS)).rejects.toThrow(SUGGESTIONS_NEED_CONNECTION);
  });

  it("a rules change forgets the snapshot", async () => {
    const account = bindAccount(A);
    await saveMealSnapshot(account, snapshot(A), ELIGIBLE, await snapshotEpoch(account));
    expect(await readMealSnapshot(account)).not.toBeNull();
    noteFoodRulesChanged(undefined, A);
    await vi.waitFor(async () => expect(await readMealSnapshot(account)).toBeNull());
  });

  // BLOCK 2 (Grok t10): one hook in lib/sync/idb.ts, whichever path changed the log.
  const LOG = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const logRow = { id: LOG, user_id: A, slot: "meal-1", local_date: "2026-10-04", rev: 1, items: [] };
  const paths: [string, (account: ReturnType<typeof bindAccount>) => Promise<unknown>][] = [
    ["a commit's local mirror or a pull of another device's log (putRow)",
      (account) => putRow(account, "log_entries", LOG, logRow)],
    ["a delete or a rollback (deleteRow)", (account) => deleteRow(account, "log_entries", LOG)],
    ["an edit, move or coach apply queued with its row (mutateRowWithOp)", (account) =>
      mutateRowWithOp(account, "log_entries", LOG, () => ({ row: { ...logRow, slot: "meal-2" }, result: null,
        op: { op_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", entity: "log_entries", entity_id: LOG, kind: "update",
          base_rev: 1, client_ts: new Date().toISOString(), payload: { slot: "meal-2" } } }))],
    ["an Eats edit queued through the outbox", (account) => enqueue(account, {
      op_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", entity: "user_food_prefs",
      entity_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", kind: "create", base_rev: null,
      client_ts: new Date().toISOString(), payload: { food_ref_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", status: "eats" } })],
  ];
  for (const [name, change] of paths) {
    it(`${name} forgets the snapshot`, async () => {
      const account = bindAccount(A);
      await saveMealSnapshot(account, snapshot(A), ELIGIBLE, await snapshotEpoch(account));
      expect(await readMealSnapshot(account)).not.toBeNull();
      await change(account);
      expect(await readMealSnapshot(account)).toBeNull();
    });
  }

  it("a write to a row that is no snapshot input keeps it", async () => {
    const account = bindAccount(A);
    await saveMealSnapshot(account, snapshot(A), ELIGIBLE, await snapshotEpoch(account));
    await putRow(account, "water_log", "2026-10-04", { local_date: "2026-10-04", cups: 2 });
    expect(await readMealSnapshot(account)).not.toBeNull();
  });

  it("an answer read before a change (in any tab) is never stored", async () => {
    const account = bindAccount(A);
    const started = await snapshotEpoch(account);
    await putRow(account, "log_entries", LOG, logRow);
    expect(await saveMealSnapshot(account, snapshot(A), ELIGIBLE, started)).toBe("stale");
    expect(await readMealSnapshot(account)).toBeNull();
    await invalidateMealSnapshot(account);
    expect(await saveMealSnapshot(account, snapshot(A), ELIGIBLE, started)).toBe("stale");
  });
});

describe("Sol round 2: in-flight staleness and the 7-day limit on a held set", () => {
  const LOG = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2";
  /** Each fetch lets a log write land before its answer arrives. */
  function racingFetch(account: ReturnType<typeof bindAccount>, times: number) {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      if (calls <= times) {
        await putRow(account, "log_entries", LOG, { id: LOG, user_id: A, slot: "meal-1", local_date: "2026-10-04",
          rev: calls, items: [] });
      }
      return Response.json({ ...snapshot(A), eligible: ELIGIBLE });
    }));
  }

  it("an answer overtaken by a log is read once more, and that answer's evidence is used", async () => {
    const account = bindAccount(A);
    racingFetch(account, 1);
    const set = await loadEligibleLocalFoodIds(account, FOODS);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    expect(mealEvidenceOf(set)).not.toBeNull();
    expect(await readMealSnapshot(account)).not.toBeNull();
  });

  it("an answer overtaken twice keeps its ids but never its evidence", async () => {
    const account = bindAccount(A);
    racingFetch(account, 2);
    const set = await loadEligibleLocalFoodIds(account, FOODS);
    expect(set.size).toBe(Object.keys(FOODS).length);
    expect(set.meals).toBeNull();
    expect(mealEvidenceOf(set)).toBeNull();
    expect(await readMealSnapshot(account)).toBeNull();
  });

  it("a held set past 7 days is revoked and its evidence unused, checked on every use", async () => {
    const account = bindAccount(A);
    online({ ...snapshot(A), eligible: ELIGIBLE });
    const set = await loadEligibleLocalFoodIds(account, FOODS);
    expect(set.has("tuna")).toBe(true);
    vi.useFakeTimers({ now: Date.now() + 7 * DAY + 60_000, toFake: ["Date"] });
    expect(set.revoked).toBe(true);
    expect(set.has("tuna")).toBe(false);
    expect(mealEvidenceOf(set)).toBeNull();
  });

  it("a revoked set yields no evidence and no new swap plates (Sol r3 WARN 3)", async () => {
    const account = bindAccount(A);
    online({ ...snapshot(A), eligible: ELIGIBLE });
    const set = await loadEligibleLocalFoodIds(account, FOODS);
    expect(mealEvidenceOf(set)).not.toBeNull();
    noteFoodRulesChanged(undefined, A);
    expect(set.revoked).toBe(true);
    expect(mealEvidenceOf(set)).toBeNull();
    expect(swapAlternatives({ slot: "meal-1", target: { kcal: 500, protein: 35, carbs: 55, fat: 14 }, foods: FOODS,
      clock: "07:30", eligible: set })).toEqual([]);
  });

  it("a held set stops offering history after a local log write, without a re-read (Sol r4 WARN 3)", async () => {
    const account = bindAccount(A);
    online({ ...snapshot(A), eligible: ELIGIBLE });
    const set = await loadEligibleLocalFoodIds(account, FOODS);
    expect(mealEvidenceOf(set)?.history["tuna, canned in water"]).toBeDefined();
    await putRow(account, "log_entries", LOG, { id: LOG, user_id: A, slot: "meal-1", local_date: "2026-10-04",
      rev: 9, items: [] });
    expect(set.meals).toBeUndefined();
    expect(mealEvidenceOf(set)).toBeUndefined();
    // Curated ranking still runs; only the account's stale history is gone.
    expect(set.has("tuna")).toBe(true);
  });

  it("a write in another tab retires the held set's history too (Sol r5 WARN 4)", async () => {
    const account = bindAccount(A);
    online({ ...snapshot(A), eligible: ELIGIBLE });
    const set = await loadEligibleLocalFoodIds(account, FOODS);
    expect(mealEvidenceOf(set)).toBeDefined();
    receiveSnapshotInputWriteForTests(B);
    expect(mealEvidenceOf(set)).toBeDefined();
    receiveSnapshotInputWriteForTests(A);
    expect(mealEvidenceOf(set)).toBeUndefined();
  });

  for (const [name, body] of [
    ["another ranking contract", () => ({ ...snapshot(A), rankingVersion: "o1" })],
    ["a snapshot from the future", () => snapshot(A, new Date(Date.now() + DAY).toISOString())],
  ] as const) {
    it(`online, ${name} keeps its ids but never its history, and is not stored (Sol r5 BLOCK 2)`, async () => {
      const account = bindAccount(A);
      online({ ...body(), eligible: ELIGIBLE });
      const set = await loadEligibleLocalFoodIds(account, FOODS);
      expect(set.size).toBe(Object.keys(FOODS).length);
      expect(mealEvidenceOf(set)).toBeUndefined();
      expect(await readMealSnapshot(account)).toBeNull();
    });
  }

  it("swaps read the evidence from the verified set they were filtered by", async () => {
    const account = bindAccount(A);
    online({ ...snapshot(A), eligible: ELIGIBLE });
    const set = await loadEligibleLocalFoodIds(account, FOODS);
    const target = { kcal: 500, protein: 35, carbs: 55, fat: 14 };
    const viaSet = swapAlternatives({ slot: "meal-1", target, foods: FOODS, clock: "07:30", date: "2026-10-04", eligible: set });
    const viaEvidence = swapAlternatives({ slot: "meal-1", target, foods: FOODS, clock: "07:30", date: "2026-10-04",
      evidence: set.meals });
    expect(viaSet).toEqual(viaEvidence);
    const offlineSet = new StampedEligibleSet(set, set.marks, set.rulesKey, set.epoch, null, set.verifiedAt);
    expect(swapAlternatives({ slot: "meal-1", target, foods: FOODS, clock: "07:30", eligible: offlineSet })).toEqual([]);
  });
});
