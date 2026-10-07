/**
 * Calc audit #15 (BLOCK): a bundled food-db pick and an account food went through a local-only
 * `onAdd`, and a mixed meal committed only its catalog items, so none of them reached the
 * server's day totals, the export, the coach or the expenditure engine. `commitPickedFoods` sends
 * every pick down the one durable commit path with a real food ref and real per-item numbers.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountHandle } from "@/lib/device/account";
import type { CachedRevision } from "@/lib/db/catalog-cache";
import { dbFood } from "@/lib/food-db";
import type { Food } from "@/lib/foods";
import {
  bundledFoodUserId, numbersKey, per100gFromBundled, type AdoptableFood,
} from "@/lib/foods/adopt-client";
import { starterFood } from "@/lib/foods/starter";
import { accountUnitGrams } from "@/lib/foods/unit-grams";
import { uuidV5 } from "@/lib/foods/uuid5";
import { opIdFor, type LogCommitRequest } from "@/lib/log/contract";
import { catalogCard } from "@/lib/log/catalog-card";
import {
  accountPer100g, commitPickedFoods, preparePickedCommit, type LogPick,
} from "@/lib/log/picked-commit";
import { pendingEntryIds } from "@/lib/log-commit-client";
import { commitNutritionUnchecked } from "@/lib/nutrition-display";
import { resetFoodRefCache } from "@/lib/log-client";
import { getDay, loadStore, saveStore } from "@/lib/store";
import { allOps } from "@/lib/sync/idb";
import type { LoggedFood } from "@/lib/types";
import { resetTestAccount, TEST_USER } from "@/tests/helpers/account";

/** The server, for the default adoption path: what was upserted, and the ref the RPC hands out. */
const server = vi.hoisted(() => ({
  upserts: [] as Record<string, unknown>[],
  ref: "ffffffff-0000-4000-8000-000000000001",
}));

vi.mock("@/lib/supabase/client", () => ({
  browserClient: () => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: "user-a" } } }) },
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      upsert: (row: Record<string, unknown>) => {
        server.upserts.push(row);
        return { select: () => ({ single: async () => ({ data: { rev: 1 }, error: null }) }) };
      },
    }),
    rpc: async () => ({ data: server.ref, error: null }),
  }),
}));

let h: AccountHandle;
const AT = new Date("2026-11-02T17:00:00.000Z");
const TZ = "UTC";
const DATE = "2026-11-02";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const BUNDLED_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const PICKED_NAMESPACE = "a3c1e0f2-5b7d-4c9e-8f10-2d3e4f5a6b7c";
const CATALOG_REF = "cccccccc-3333-4333-8333-333333333333";
const CATALOG_ITEM = "bbbbbbbb-2222-4222-8222-222222222222";
const CATALOG_EXTRA = "eeeeeeee-9999-4999-8999-999999999999";
const CHICKEN = "chicken-breast-roasted";

/** A minter that hands out a stable ref per adopted row and remembers what it adopted. */
function minter() {
  const adopted: AdoptableFood[] = [];
  const refs = new Map<string, string>();
  const mint = vi.fn(async (food: AdoptableFood) => {
    adopted.push(food);
    if (!refs.has(food.id)) {
      refs.set(food.id, `dddddddd-0000-4000-8000-${String(refs.size + 1).padStart(12, "0")}`);
    }
    return refs.get(food.id) as string;
  });
  return { mint, adopted };
}

/** Captures the posted body and answers 200 with what the server would store. */
function okFetch(bodies: LogCommitRequest[]) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as LogCommitRequest;
    bodies.push(req);
    return new Response(JSON.stringify({
      status: "ok", entry_id: req.entry_id, rev: 1,
      items: req.items.map((i) => ({ ...i, entry_id: req.entry_id, portion_id: null,
        food_revision_id: i.food_revision_id ?? null, was_edited: false, confidence: null,
        snapshot: {} })),
      totals: { local_date: req.local_date, nutrients: [], micro_coverage_pct: 0 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

const down = () => vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;

function bundledPick(id = "mfz1-ab12-f"): LogPick {
  // 1 cup chopped roasted chicken breast = 140 g; per 100 g: 165 kcal, 31 P, 0 C, 3.6 F.
  // The sheet's own rounding says 5 g fat; the server's snapshot says 5.04.
  const card: LoggedFood = {
    id, foodId: CHICKEN, name: "Chicken breast, roasted",
    portionLabel: "1 cup, chopped or diced", qty: 1, grams: 140,
    macros: { kcal: 231, protein: 43.4, carbs: 0, fat: 5 }, at: AT.toISOString(),
  };
  return { source: "bundled", card };
}

const OATS: Food = {
  id: "oats-cooked", name: "Oatmeal, cooked", role: "carb", unit: "oz",
  perUnit: { protein: 0.7, carbs: 3.4, fat: 0.4 }, status: "eats", updatedAt: AT.toISOString(),
};

const POUCH: Food = {
  id: "mystery-pouch", name: "Grandma's veggie pouch", role: "carb", unit: "pouch",
  perUnit: { protein: 2, carbs: 14, fat: 1 }, status: "eats", updatedAt: AT.toISOString(),
};

function accountPick(food: Food, qty: number, id: string, grams?: number): LogPick {
  // What the sheet's buildEntry makes: the portion's real mass (accountUnitGrams × qty) unless a
  // gram portion was picked; with no known weight the sheet's stand-in mass is ignored.
  const unit = accountUnitGrams(food);
  return { source: "account", food, card: {
    id, foodId: food.id, name: food.name, portionLabel: `1 ${food.unit}`, qty,
    grams: grams ?? (unit === null ? 100 * qty : unit * qty),
    macros: { kcal: 0, protein: 0, carbs: 0, fat: 0 }, at: AT.toISOString(),
  } };
}

const REVISION = {
  revision_id: 910, catalog_food_id: 7, description: "Bread", brand: null,
  source: "fdc_branded", version_label: "v1",
  per_100g: { energy_kcal: 265, protein: 9, carbohydrate: 49, fat_total: 3.2 }, portions: [],
  cached_at: AT.toISOString(),
} as unknown as CachedRevision;

function catalogPick(): LogPick {
  const card = catalogCard({ revision: REVISION, entryId: CATALOG_EXTRA, itemId: CATALOG_ITEM,
    foodRefId: CATALOG_REF, grams: 50, qty: 50, portion: null, at: AT });
  return { source: "catalog", card, itemId: CATALOG_ITEM, foodRefId: CATALOG_REF,
    revision: REVISION, grams: 50, qty: 50, unit: "g", portionId: null };
}

beforeEach(async () => {
  h = await resetTestAccount();
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  resetFoodRefCache();
  server.upserts.length = 0;
  saveStore({ ...loadStore(), days: {} });
});

describe("a bundled food-db pick", () => {
  it("reaches the commit request with an adopted ref, and the card matches the server's maths", async () => {
    const { mint, adopted } = minter();
    const bodies: LogCommitRequest[] = [];
    const sent = await commitPickedFoods({ picks: [bundledPick()], slot: "meal-2", at: AT, tz: TZ,
      mint, fetchImpl: okFetch(bodies) });
    if (sent.status !== "sent") throw new Error(sent.status);

    expect(bodies).toHaveLength(1);
    const [item] = bodies[0].items;
    expect(item.food_ref_id).toBe("dddddddd-0000-4000-8000-000000000001");
    expect(item).toMatchObject({ grams: 140, qty: 1, unit: "portion", food_revision_id: null });
    expect(adopted[0]).toMatchObject({ name: "Chicken breast, roasted",
      per100g: { energy_kcal: 165, protein: 31, carbohydrate: 0, fat_total: 3.6 } });
    expect(sent.entry.items?.[0]).toMatchObject({ id: item.id, food_ref_id: item.food_ref_id });
    expect(sent.entry.items?.[0].snapshot.fat_total?.amount).toBe(5.04);
    expect(sent.entry.macros).toEqual({ kcal: 231, protein: 43.4, carbs: 0, fat: 5 });
    expect(getDay(DATE)?.extras?.map((e) => e.id)).toEqual([bodies[0].entry_id]);
  });

  it("is adopted under an id carrying the account AND the food's numbers", async () => {
    const { mint, adopted } = minter();
    await preparePickedCommit({ picks: [bundledPick()], slot: "meal-2", at: AT, tz: TZ, mint });
    const food = dbFood(CHICKEN)!;
    const expected = await uuidV5(BUNDLED_NAMESPACE,
      `bundled:${TEST_USER}:${CHICKEN}:${numbersKey(per100gFromBundled(food))}`);
    expect(adopted[0].id).toBe(expected);
    expect(adopted[0].id).toBe(await bundledFoodUserId(CHICKEN, TEST_USER));
    // A food-db update changes the key, so it can never land on the row old entries point at.
    expect(numbersKey({ ...per100gFromBundled(food), fat_total: 3.7 }))
      .not.toBe(numbersKey(per100gFromBundled(food)));
  });

  it("is the same entry, items and op on a retry — and the second time mints nothing", async () => {
    const { mint } = minter();
    const pick = bundledPick();
    const first = await preparePickedCommit({ picks: [pick], slot: "meal-2", at: AT, tz: TZ, mint });
    const again = await preparePickedCommit({ picks: [pick], slot: "meal-2", at: AT, tz: TZ, mint });
    if (first.status !== "ready" || again.status !== "ready") throw new Error("not ready");
    expect(again.req).toEqual(first.req);
    expect(opIdFor(again.req.entry_id, undefined)).toBe(opIdFor(first.req.entry_id, undefined));
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it("never reuses another account's row, ref or entry id", async () => {
    const { mint, adopted } = minter();
    const first = await preparePickedCommit({ picks: [bundledPick()], slot: "meal-2", at: AT,
      tz: TZ, mint });
    h = await resetTestAccount(OTHER_USER);
    const second = await preparePickedCommit({ picks: [bundledPick()], slot: "meal-2", at: AT,
      tz: TZ, mint });
    if (first.status !== "ready" || second.status !== "ready") throw new Error("not ready");
    expect(mint).toHaveBeenCalledTimes(2);
    expect(adopted[1].id).not.toBe(adopted[0].id);
    expect(second.req.items[0].food_ref_id).not.toBe(first.req.items[0].food_ref_id);
    expect(second.req.entry_id).not.toBe(first.req.entry_id);
    expect(second.account.userId).toBe(OTHER_USER);
  });

  it("adopts through Supabase by default: one user_foods row owned by this account", async () => {
    const bodies: LogCommitRequest[] = [];
    const sent = await commitPickedFoods({ picks: [bundledPick()], slot: "meal-2", at: AT, tz: TZ,
      fetchImpl: okFetch(bodies) });
    if (sent.status !== "sent") throw new Error(sent.status);
    expect(server.upserts).toHaveLength(1);
    expect(server.upserts[0]).toMatchObject({ id: await bundledFoodUserId(CHICKEN, TEST_USER),
      user_id: TEST_USER, kind: "custom", per_100g: { energy_kcal: 165 } });
    expect(bodies[0].items[0].food_ref_id).toBe(server.ref);
  });

  it("files the entry on the date in its own time zone", async () => {
    const { mint } = minter();
    const late = new Date("2026-11-02T23:30:00.000Z");
    const ready = await preparePickedCommit({ picks: [bundledPick()], slot: "meal-2", at: late,
      tz: "Pacific/Kiritimati", mint });
    if (ready.status !== "ready") throw new Error(ready.status);
    expect(ready.req.local_date).toBe("2026-11-03");
    expect(ready.date).toBe("2026-11-03");
  });
});

describe("an account food", () => {
  it("with a known unit weight commits real grams and its own per-100 g numbers", async () => {
    const { mint, adopted } = minter();
    const bodies: LogCommitRequest[] = [];
    const sent = await commitPickedFoods({ picks: [accountPick(OATS, 2, "acct-1")], slot: "meal-1",
      at: AT, tz: TZ, mint, fetchImpl: okFetch(bodies) });
    if (sent.status !== "sent") throw new Error(sent.status);
    const [item] = bodies[0].items;
    expect(item.unit).toBe("oz");
    expect(item.grams).toBeCloseTo(56.699, 3);
    // 0.7 g protein per oz → 2.4692 g per 100 g.
    expect(adopted[0].per100g.protein).toBeCloseTo(2.4692, 4);
    expect(adopted[0].id).toBe(await uuidV5(PICKED_NAMESPACE,
      `log-food:${TEST_USER}:${OATS.id}:oz:28.3495:${numbersKey(adopted[0].per100g)}`));
    expect(sent.entry.macros).toEqual({ kcal: 40, protein: 1.4, carbs: 6.8, fat: 0.8 });
    expect(sent.entry.grams).toBeCloseTo(56.699, 3);
  });

  it.each([
    ["banana", "whole", 118],
    ["potato-baked-with-skin", "whole", 173],
    ["sweet-potato-baked", "whole", 114],
    ["corn-tortilla", "whole", 26],
  ] as const)("weighs starter %s by the same unit grams the Eats row uses (%s → %i g)", async (id, unit, grams) => {
    const name = dbFood(id)?.name ?? id;
    const food: Food = { id: `acct-${grams}`, name, role: "carb", unit,
      perUnit: { protein: 1.3, carbs: 27, fat: 0.4 }, status: "eats", updatedAt: AT.toISOString() };
    expect(accountUnitGrams(food)).toBe(grams);
    expect(accountPer100g(food)?.unitGrams).toBe(accountUnitGrams(food));
    const { mint, adopted } = minter();
    const bodies: LogCommitRequest[] = [];
    const sent = await commitPickedFoods({ picks: [accountPick(food, 1, `acct-${grams}`)],
      slot: "meal-1", at: AT, tz: TZ, mint, fetchImpl: okFetch(bodies) });
    if (sent.status !== "sent") throw new Error(sent.status);
    expect(bodies[0].items[0].grams).toBeCloseTo(grams, 3);
    expect(adopted[0].per100g.carbohydrate).toBeCloseTo((27 * 100) / grams, 3);
  });

  it("logs the starter banana at 118 g a whole and a 100 g portion at 100 g (UI lane gap 1)", async () => {
    const banana = starterFood("banana", "eats");
    const grams = async (qty: number) => {
      const { mint } = minter();
      const ready = await preparePickedCommit({ picks: [accountPick(banana, qty, `banana-${qty}`)],
        slot: "meal-1", at: AT, tz: TZ, mint });
      if (ready.status !== "ready") throw new Error(ready.status);
      return ready.req.items[0].grams;
    };
    expect(await grams(1)).toBeCloseTo(118, 3);
    // The sheet's "100 g" portion: qty 1, 100 g (GPT-6 Sol review of b8b7a31).
    const { mint } = minter();
    const portion = await preparePickedCommit({ picks: [accountPick(banana, 1, "banana-100g", 100)],
      slot: "meal-1", at: AT, tz: TZ, mint });
    if (portion.status !== "ready") throw new Error(portion.status);
    expect(portion.req.items[0].grams).toBeCloseTo(100, 3);
    expect(portion.req.items[0].unit).toBe("portion");
    // A card rounded by the sheet to 0.1 g still stores the exact unit mass.
    const milk: Food = { id: "milk", name: "Milk, whole", role: "carb", unit: "ml",
      perUnit: { protein: 0.033, carbs: 0.048, fat: 0.033 }, status: "eats", updatedAt: AT.toISOString() };
    const one = await preparePickedCommit({ picks: [accountPick(milk, 1, "milk-1", 1.0)],
      slot: "meal-1", at: AT, tz: TZ, mint });
    if (one.status !== "ready") throw new Error(one.status);
    expect(one.req.items[0].grams).toBeCloseTo(1.03, 4);
    expect(one.req.items[0].unit).toBe("ml");
  });

  it("mints a new row when its numbers are edited", async () => {
    const { mint, adopted } = minter();
    await preparePickedCommit({ picks: [accountPick(OATS, 1, "a")], slot: "meal-1", at: AT, tz: TZ, mint });
    const edited = { ...OATS, perUnit: { ...OATS.perUnit, protein: 0.9 } };
    await preparePickedCommit({ picks: [accountPick(edited, 1, "b")], slot: "meal-1", at: AT, tz: TZ, mint });
    expect(mint).toHaveBeenCalledTimes(2);
    expect(adopted[1].id).not.toBe(adopted[0].id);
  });

  it.each([1, 2])("with no unit weight commits a count, mass null, per-unit macros × qty (qty %i)", async (qty) => {
    // t17 gap 1: grams null (never the sheet's stand-in 100 g), the user's own per-pouch numbers.
    const { mint, adopted } = minter();
    const bodies: LogCommitRequest[] = [];
    expect(accountPer100g(POUCH)).toBeNull();
    const sent = await commitPickedFoods({ picks: [accountPick(POUCH, qty, "acct-2")], slot: "meal-1",
      at: AT, tz: TZ, mint, fetchImpl: okFetch(bodies) });
    if (sent.status !== "sent") throw new Error(sent.status);
    expect(bodies[0].items[0]).toMatchObject({ grams: null, qty, unit: "pouch",
      food_revision_id: null, per_unit: { energy_kcal: 73, protein: 2, carbohydrate: 14, fat_total: 1 } });
    expect(adopted[0].per100g).toEqual({});
    const item = sent.entry.items?.[0];
    expect(item?.grams).toBeNull();
    expect(item?.snapshot.energy_kcal).toMatchObject({ amount: 73 * qty, basis: "per_unit" });
    expect(sent.entry).toMatchObject({ massUnknown: true,
      macros: { kcal: 73 * qty, protein: 2 * qty, carbs: 14 * qty, fat: 1 * qty } });
  });

  it("with no unit weight and unknown nutrition commits mass null and an empty snapshot", async () => {
    const bodies: LogCommitRequest[] = [];
    const sent = await commitPickedFoods({
      picks: [accountPick({ ...POUCH, nutritionUnknown: true }, 1, "acct-2b")], slot: "meal-1",
      at: AT, tz: TZ, mint: minter().mint, fetchImpl: okFetch(bodies) });
    if (sent.status !== "sent") throw new Error(sent.status);
    expect(bodies[0].items[0].grams).toBeNull();
    expect(bodies[0].items[0]).not.toHaveProperty("per_unit");
    expect(sent.entry.items?.[0].snapshot).toEqual({});
  });

  it("with unknown nutrition commits an unmeasured item, never measured zeros", async () => {
    const { mint, adopted } = minter();
    const bodies: LogCommitRequest[] = [];
    const sent = await commitPickedFoods({
      picks: [accountPick({ ...OATS, nutritionUnknown: true }, 1, "acct-3")], slot: "meal-1",
      at: AT, tz: TZ, mint, fetchImpl: okFetch(bodies) });
    if (sent.status !== "sent") throw new Error(sent.status);
    expect(adopted[0].per100g).toEqual({});
    expect(sent.entry.items?.[0].snapshot).toEqual({});
  });

  it("refuses a non-positive amount instead of rewriting it", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const sent = await commitPickedFoods({ picks: [accountPick(OATS, 0, "acct-4")], slot: "meal-1",
      at: AT, tz: TZ, mint: minter().mint, fetchImpl });
    expect(sent).toMatchObject({ status: "invalid_qty" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("a mixed meal", () => {
  it("commits its catalog, bundled and account items as one entry", async () => {
    const { mint, adopted } = minter();
    const bodies: LogCommitRequest[] = [];
    const picks = [catalogPick(), bundledPick(), accountPick(OATS, 1, "acct-5")];
    const sent = await commitPickedFoods({ picks, slot: "meal-3", at: AT, tz: TZ, mint,
      meal: { name: "Lunch bowl", note: "after the walk" }, fetchImpl: okFetch(bodies) });
    if (sent.status !== "sent") throw new Error(sent.status);

    expect(bodies).toHaveLength(1);
    const req = bodies[0];
    // The bundled and account picks resolve their refs concurrently (Promise.all), so `mint` can
    // be called for either one first — the minter's sequential numbering is a race, not something
    // the product promises. What the product DOES promise is the item array itself: it stays in
    // the meal's own order (catalog, then bundled, then account) no matter which ref resolved
    // first. Build the expected refs from each food's own stable id (not from call order).
    const bundledId = await bundledFoodUserId(CHICKEN, TEST_USER);
    const basis = accountPer100g(OATS)!;
    const accountId = await uuidV5(PICKED_NAMESPACE,
      `log-food:${TEST_USER}:${OATS.id}:oz:${basis.unitGrams}:${numbersKey(basis.per100g)}`);
    const uniqueIds = [...new Set(adopted.map((f) => f.id))];
    const refFor = (id: string) =>
      `dddddddd-0000-4000-8000-${String(uniqueIds.indexOf(id) + 1).padStart(12, "0")}`;
    expect(req.items.map((i) => i.food_ref_id)).toEqual([
      CATALOG_REF, refFor(bundledId), refFor(accountId),
    ]);
    expect(req.items[0]).toMatchObject({ id: CATALOG_ITEM, food_revision_id: 910, grams: 50 });
    expect(req.items.map((i) => i.seq)).toEqual([1, 2, 3]);
    expect(req.title).toBe("Lunch bowl");
    expect(req.note).toBe("after the walk");
    expect(sent.entry.items?.map((i) => i.id)).toEqual(req.items.map((i) => i.id));
    expect(sent.entry.items?.some((i) => i.food_ref_id.startsWith("local:"))).toBe(false);
    expect(getDay(DATE)?.extras).toHaveLength(1);
  });
});

describe("nothing is sent", () => {
  it("on a first use offline, when no ref can be minted", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const sent = await commitPickedFoods({ picks: [catalogPick(), bundledPick()], slot: "meal-3",
      at: AT, tz: TZ, mint: vi.fn(async () => null), meal: { name: "", note: "" }, fetchImpl });
    expect(sent).toMatchObject({ status: "no_ref", reason: "unresolved" });
    if (sent.status === "no_ref") expect(sent.picks.map((p) => p.source)).toEqual(["bundled"]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(getDay(DATE)?.extras ?? []).toHaveLength(0);
  });

  it("when signed out", async () => {
    const { mint } = minter();
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const sent = await commitPickedFoods({ picks: [bundledPick()], slot: "meal-2", at: AT, tz: TZ,
      account: null, mint, fetchImpl });
    expect(sent.status).toBe("no_ref");
    expect(mint).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("offline", () => {
  it("queues a bundled food whose ref is already known, card kept and pending", async () => {
    const { mint } = minter();
    await preparePickedCommit({ picks: [bundledPick()], slot: "meal-2", at: AT, tz: TZ, mint });
    const sent = await commitPickedFoods({ picks: [bundledPick("second-tap")], slot: "meal-2",
      at: AT, tz: TZ, mint: vi.fn(async () => null), fetchImpl: down() });
    if (sent.status !== "sent") throw new Error(sent.status);
    expect(sent.result).toEqual({ status: "queued" });
    expect(getDay(DATE)?.extras).toHaveLength(1);
    expect(await pendingEntryIds()).toContain(sent.entry.id);
    const ops = (await allOps(h)).filter((o) => o.entity === "log_entries");
    expect(ops).toHaveLength(1);
    expect(ops[0].entity_id).toBe(sent.entry.id);
    const items = (ops[0].payload as { items: { food_ref_id: string; grams: number }[] }).items;
    expect(items).toEqual([expect.objectContaining({
      food_ref_id: "dddddddd-0000-4000-8000-000000000001", grams: 140 })]);
  });
});

describe("the server's nutrition_unchecked", () => {
  it("reaches the label-food sheet on the sent result", async () => {
    const posts = vi.fn(async (_url: string, init?: RequestInit) => {
      const req = JSON.parse(String(init?.body)) as LogCommitRequest;
      return new Response(JSON.stringify({
        status: "ok", entry_id: req.entry_id, rev: 1, items: [], nutrition_unchecked: true,
        totals: { local_date: req.local_date, nutrients: [], micro_coverage_pct: 0 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const sent = await commitPickedFoods({ picks: [catalogPick()], slot: "meal-2", at: AT, tz: TZ,
      account: h, fetchImpl: posts });
    expect(sent.status).toBe("sent");
    expect(sent.status === "sent" && commitNutritionUnchecked(sent.result)).toBe(true);
  });
});
