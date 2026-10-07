/**
 * Grok pass 2, HIGH 5: the optimistic meal card stamped each item with the id of the component
 * extra it came from, while the request sent the item id from `mealCatalogItems`. The two never
 * matched, so `reconcileEntry`'s join by item id found nothing and the server's grams, snapshots
 * and off-plan flags never reached a logged meal.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mealEntryItems } from "@/lib/log/meal-card";
import { buildMealCommitRequest, localDateOf } from "@/lib/log-client";
import { commitLogEntry, reconcileEntry } from "@/lib/log-commit-client";
import { getDay, loadStore, saveStore } from "@/lib/store";
import type { CachedRevision } from "@/lib/db/catalog-cache";
import type { LoggedFood } from "@/lib/types";
import { resetTestAccount } from "@/tests/helpers/account";


vi.mock("@/lib/supabase/client", () => ({
  browserClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
  }),
}));

const ENTRY_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const ITEM_ID = "bbbbbbbb-2222-4222-8222-222222222222";
const EXTRA_ID = "eeeeeeee-9999-4999-8999-999999999999";
const REF_ID = "cccccccc-3333-4333-8333-333333333333";
const AT = new Date("2026-11-02T17:00:00.000Z");
const DATE = localDateOf(AT);

const REVISION = {
  revision_id: 910, catalog_food_id: 7, description: "Bread", brand: null,
  source: "fdc_branded", version_label: "v1", per_100g: { energy_kcal: 265 }, portions: [],
  cached_at: AT.toISOString(),
} as unknown as CachedRevision;

/** One food added in meal mode: a component extra, plus the catalog row the commit will send. */
const COMPONENT: LoggedFood = {
  id: EXTRA_ID, foodId: "catalog:7", name: "Bread", portionLabel: "90 g", qty: 90, grams: 90,
  macros: { kcal: 239, protein: 8, carbs: 45, fat: 3 }, at: AT.toISOString(),
  items: [{ id: ITEM_ID, seq: 1, food_ref_id: REF_ID, grams: 90, qty: 90, unit: "g",
    snapshot: {}, foodId: "catalog:7", name: "Bread", portionLabel: "90 g",
    macros: { kcal: 239, protein: 8, carbs: 45, fat: 3 } }],
};

const CATALOG_ITEMS = [{
  entryId: EXTRA_ID, itemId: ITEM_ID, foodRefId: REF_ID, revision: REVISION,
  grams: 90, qty: 90, unit: "g", portionId: null,
}];

beforeEach(async () => {
  await resetTestAccount();
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  saveStore({ ...loadStore(), days: {} });
});

describe("mealEntryItems", () => {
  it("carries the same item ids the commit sends", () => {
    const request = buildMealCommitRequest({
      entryId: ENTRY_ID, eatenAt: AT, tz: "UTC", slot: "meal-2", items: CATALOG_ITEMS });
    expect(mealEntryItems([COMPONENT], CATALOG_ITEMS).map((i) => i.id))
      .toEqual(request.items.map((i) => i.id));
  });

  it("keeps the extra's own id when no catalog row names one — the rows are the id space", () => {
    // An extra carrying items of its own is not evidence about what the commit will send: only
    // the catalog rows say that, and a first item's id is the wrong answer for an extra that has
    // several (Grok pass 4, LOW 5).
    const twoItems: LoggedFood = { ...COMPONENT, items: [
      COMPONENT.items![0], { ...COMPONENT.items![0], id: "dddddddd-4444-4444-8444-444444444444" },
    ] };
    expect(mealEntryItems([twoItems], []).map((i) => i.id)).toEqual([EXTRA_ID]);
  });

  it("reconciles every item of a two-food meal, not just the first", () => {
    const secondExtra = "ffffffff-5555-4555-8555-555555555555";
    const secondItem = "dddddddd-4444-4444-8444-444444444444";
    const second: LoggedFood = {
      ...COMPONENT, id: secondExtra, name: "Butter", grams: 50,
      items: [{ ...COMPONENT.items![0], id: secondItem, grams: 50, name: "Butter" }],
    };
    const rows = [...CATALOG_ITEMS, { ...CATALOG_ITEMS[0], entryId: secondExtra,
      itemId: secondItem, grams: 50, qty: 50 }];
    const card: LoggedFood = {
      id: ENTRY_ID, foodId: "meal", name: "Toast", portionLabel: "2 items", qty: 1, grams: 140,
      macros: COMPONENT.macros, at: AT.toISOString(),
      items: mealEntryItems([COMPONENT, second], rows),
    };
    const patch = reconcileEntry(card, {
      status: "ok", entry_id: ENTRY_ID, rev: 1,
      items: [{ id: ITEM_ID, grams: 118 }, { id: secondItem, grams: 62 }],
      totals: { local_date: DATE, nutrients: [], micro_coverage_pct: 0 },
    } as never);
    expect(patch.items?.map((i) => i.grams)).toEqual([118, 62]);
  });

  it("marks a card partial, not off-plan, when the server names a partial recipe (#21)", () => {
    const card: LoggedFood = { ...COMPONENT, id: ENTRY_ID, items: undefined };
    const result = { status: "ok", entry_id: ENTRY_ID, rev: 1, items: [{ id: ITEM_ID, grams: 100 }],
      totals: { local_date: DATE, nutrients: [], micro_coverage_pct: 0 } };
    const patch = reconcileEntry(card, { ...result,
      partial_nutrition: [{ path: "items.0", food_ref_id: "ref", coverage: 0.5 }] } as never);
    expect(patch.nutritionPartial).toBe(true);
    expect(patch.flags).toBeUndefined();
    // A clean answer that judged its items clears a mark the entry no longer earns.
    const cleared = reconcileEntry({ ...card, nutritionPartial: true }, result as never);
    expect("nutritionPartial" in cleared).toBe(true);
    expect({ ...card, nutritionPartial: true, ...cleared }.nutritionPartial).toBeUndefined();
    // An answer with no items judged nothing, so it leaves the card's mark alone.
    expect("nutritionPartial" in reconcileEntry(card, { ...result, items: [] } as never)).toBe(false);
  });

  it("leaves a bundled pick, which the commit never sends, with its own id", () => {
    const bundled: LoggedFood = { ...COMPONENT, id: "local-1", items: undefined };
    expect(mealEntryItems([bundled], []).map((i) => i.id)).toEqual(["local-1"]);
  });
});

describe("a logged meal, after the server answers", () => {
  it("takes the grams, the snapshot and the off-plan flag onto its card", async () => {
    const request = buildMealCommitRequest({
      entryId: ENTRY_ID, eatenAt: AT, tz: "UTC", slot: "meal-2", items: CATALOG_ITEMS });
    const card: LoggedFood = {
      id: ENTRY_ID, foodId: "meal", name: "Toast", portionLabel: "1 item", qty: 1, grams: 90,
      macros: COMPONENT.macros, at: AT.toISOString(),
      items: mealEntryItems([COMPONENT], CATALOG_ITEMS),
    };
    const body = {
      status: "ok", entry_id: ENTRY_ID, rev: 1,
      items: [{ id: ITEM_ID, grams: 100, snapshot: { energy_kcal: { amount: 265 } } }],
      totals: { local_date: DATE, nutrients: [], micro_coverage_pct: 0 },
      flagged: [{ path: "items.0", message: "blocked:allergen:gluten" }],
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body), {
      status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

    await commitLogEntry(request, { fetchImpl, optimistic: { date: DATE, entry: card } });

    const logged = getDay(DATE)?.extras?.[0];
    expect(logged?.flags).toEqual(["gluten"]);
    expect(logged?.items?.[0].grams).toBe(100);
    expect(logged?.items?.[0].snapshot).toEqual({ energy_kcal: { amount: 265 } });
  });
});
