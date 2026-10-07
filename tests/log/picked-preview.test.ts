/**
 * UI lane gaps (c) and (d), 2026-10-05.
 *
 * (c) A single catalog pick that is not sent (signed out) used to stay on the day with its
 *     `catalog:` food id, so Undo read it as possibly sent and left a delete owed to the server.
 *     `localOnlyCard` marks the kept card explicitly.
 * (d) The Log sheet kept its own copy of two commit rules (4-decimal per-100 g numbers, the 0.05 g
 *     whole-unit snap). `sheetPreview` is the commit's own answer, so the sheet can drop its copy.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/client", () => ({
  browserClient: () => { throw new Error("the server must not be asked about a local card"); },
}));

import { sheetCard } from "@/components/LogFoodSheet.picks";
import type { AccountHandle } from "@/lib/device/account";
import type { CachedRevision } from "@/lib/db/catalog-cache";
import { dbFood, mineAsDb } from "@/lib/food-db";
import type { Food } from "@/lib/foods";
import { starterFood } from "@/lib/foods/starter";
import { accountUnitGrams } from "@/lib/foods/unit-grams";
import { catalogCard } from "@/lib/log/catalog-card";
import {
  commitPickedFoods, localOnlyCard, preparePickedCommit, sheetPreview, type LogPick,
} from "@/lib/log/picked-commit";
import { forgetLoggedEntry } from "@/lib/log-commit-client";
import { resetFoodRefCache } from "@/lib/log-client";
import { readPending } from "@/lib/log/pending";
import { addExtra, getDay, loadStore, saveStore } from "@/lib/store";
import type { LoggedFood } from "@/lib/types";
import { resetTestAccount } from "@/tests/helpers/account";

const AT = new Date("2026-11-02T17:00:00.000Z");
const DATE = "2026-11-02";
const TZ = "UTC";
const CATALOG_REF = "cccccccc-3333-4333-8333-333333333333";
const CATALOG_ITEM = "bbbbbbbb-2222-4222-8222-222222222222";
const CATALOG_ENTRY = "eeeeeeee-9999-4999-8999-999999999999";

const REVISION = {
  revision_id: 910, catalog_food_id: 7, description: "Bread", brand: null,
  source: "fdc_branded", version_label: "v1",
  per_100g: { energy_kcal: 265, protein: 9, carbohydrate: 49, fat_total: 3.2 }, portions: [],
  cached_at: AT.toISOString(),
} as unknown as CachedRevision;

function catalogPick(): LogPick {
  const card = catalogCard({ revision: REVISION, entryId: CATALOG_ENTRY, itemId: CATALOG_ITEM,
    foodRefId: CATALOG_REF, grams: 50, qty: 50, portion: null, at: AT });
  return { source: "catalog", card, itemId: CATALOG_ITEM, foodRefId: CATALOG_REF,
    revision: REVISION, grams: 50, qty: 50, unit: "g", portionId: null };
}

/** The card the sheet builds for `qty` of an account food, optionally at a gram portion. */
function accountPick(food: Food, qty: number, id: string, grams?: number): LogPick {
  const unit = accountUnitGrams(food);
  return { source: "account", food, card: {
    id, foodId: food.id, name: food.name, portionLabel: `1 ${food.unit}`, qty,
    grams: grams ?? (unit === null ? 100 * qty : unit * qty),
    macros: { kcal: 1, protein: 1, carbs: 1, fat: 1 }, at: AT.toISOString(),
  } };
}

function bundledPick(): LogPick {
  return { source: "bundled", card: {
    id: "mfz1-ab12-f", foodId: "chicken-breast-roasted", name: "Chicken breast, roasted",
    portionLabel: "1 cup, chopped or diced", qty: 1, grams: 140,
    macros: { kcal: 231, protein: 43.4, carbs: 0, fat: 5 }, at: AT.toISOString(),
  } };
}

const MILK: Food = { id: "milk", name: "Milk, whole", role: "carb", unit: "ml",
  perUnit: { protein: 0.033, carbs: 0.048, fat: 0.033 }, status: "eats", updatedAt: AT.toISOString() };
const OATS: Food = { id: "oats-cooked", name: "Oatmeal, cooked", role: "carb", unit: "oz",
  perUnit: { protein: 0.7, carbs: 3.4, fat: 0.4 }, status: "eats", updatedAt: AT.toISOString() };
const POUCH: Food = { id: "mystery-pouch", name: "Grandma's veggie pouch", role: "carb", unit: "pouch",
  perUnit: { protein: 2, carbs: 14, fat: 1 }, status: "eats", updatedAt: AT.toISOString() };

let h: AccountHandle;
const mint = vi.fn(async () => "dddddddd-0000-4000-8000-000000000001");

beforeEach(async () => {
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  h = await resetTestAccount();
  resetFoodRefCache();
  saveStore({ ...loadStore(), days: {} });
});

describe("sheetPreview is what the commit stores (UI gap d)", () => {
  const banana = starterFood("banana", "eats");
  const butter = starterFood("butter", "eats");
  const cases: [string, LogPick][] = [
    ["a bundled pick", bundledPick()],
    ["a catalog pick", catalogPick()],
    ["oats, 1 oz", accountPick(OATS, 1, "oats-1")],
    ["oats, 2.5 oz", accountPick(OATS, 2.5, "oats-2")],
    ["a banana, 1 each", accountPick(banana, 1, "banana-1")],
    ["a banana, 3 each", accountPick(banana, 3, "banana-3")],
    ["a banana, 100 g portion", accountPick(banana, 1, "banana-100", 100)],
    ["butter, 1 unit", accountPick(butter, 1, "butter-1")],
    ["butter, 100 g portion", accountPick(butter, 1, "butter-100", 100)],
    ["milk, a card rounded to 1.0 g (the whole-unit snap)", accountPick(MILK, 1, "milk-1", 1.0)],
    ["milk, 250 ml", accountPick(MILK, 250, "milk-250")],
  ];

  it.each(cases)("%s: the same grams, unit and macros as the prepared request", async (_, pick) => {
    const ready = await preparePickedCommit({ picks: [pick], slot: "meal-1", at: AT, tz: TZ,
      account: h, mint });
    if (ready.status !== "ready") throw new Error(ready.status);
    const preview = sheetPreview(pick);
    expect(preview.grams).toBe(ready.req.items[0].grams);
    expect(preview.unit).toBe(ready.req.items[0].unit);
    expect(preview.macros).toEqual(ready.entry.macros);
  });

  it("snaps a card within 0.05 g of whole units to the exact unit mass", () => {
    expect(sheetPreview(accountPick(MILK, 1, "m", 1.0))).toMatchObject({ grams: 1.03, unit: "ml" });
    expect(sheetPreview(accountPick(MILK, 1, "m", 1.2))).toMatchObject({ grams: 1.2, unit: "portion" });
  });

  it("agrees with the sheet's current card for bundled and account foods", () => {
    const extra = { id: "x", at: AT.toISOString() };
    const chicken = dbFood("chicken-breast-roasted");
    if (!chicken) throw new Error("bundled chicken missing");
    const shown = sheetCard(chicken, chicken.portions[0], 2, extra, {});
    const bundled = sheetPreview({ source: "bundled", card: shown });
    expect({ grams: bundled.grams, macros: bundled.macros }).toEqual({ grams: shown.grams, macros: shown.macros });
    for (const food of [OATS, banana, butter, MILK]) {
      const db = mineAsDb(food);
      for (const portion of db.portions) {
        const card = sheetCard(db, portion, 2, extra, { [food.id]: food });
        const preview = sheetPreview({ source: "account", food, card });
        expect({ grams: preview.grams, macros: preview.macros }, `${food.id} ${portion.label}`)
          .toEqual({ grams: card.grams, macros: card.macros });
      }
    }
  });

  it("a pick with no unit weight previews its count, an unknown mass and its per-unit macros (t17)", () => {
    const pouch = accountPick(POUCH, 2, "pouch-2");
    // The commit stores grams null; the preview keeps a number (0, the known part) and says
    // massUnknown, the LoggedFood compromise, so the sheet never shows an invented mass.
    expect(sheetPreview(pouch)).toEqual({ grams: 0, massUnknown: true, unit: "pouch",
      macros: { kcal: 146, protein: 4, carbs: 28, fat: 2 } });
  });
});

describe("a pick kept on this phone is marked local only (UI gap c)", () => {
  async function deleteLocally(card: LoggedFood) {
    addExtra(DATE, card);
    await forgetLoggedEntry(DATE, card.id, h).catch(() => undefined);
    return { onDay: getDay(DATE)?.extras ?? [],
      owed: (await readPending(h)).filter((r) => r.entryId === card.id) };
  }

  it("a signed-out catalog pick sends nothing, and its kept card owes the server nothing", async () => {
    const pick = catalogPick();
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const sent = await commitPickedFoods({ picks: [pick], slot: "meal-1", at: AT, tz: TZ,
      account: null, mint, fetchImpl });
    expect(sent.status).toBe("no_ref");
    expect(fetchImpl).not.toHaveBeenCalled();

    const kept = localOnlyCard(pick.card);
    expect(kept.localOnly).toBe(true);
    expect(kept.foodId.startsWith("catalog:")).toBe(true);
    expect(kept.items?.every((item) => item.food_ref_id.startsWith("local:"))).toBe(true);
    const { onDay, owed } = await deleteLocally(kept);
    expect(onDay).toEqual([]);
    expect(owed).toEqual([]);
  });

  it("the same catalog card without the mark still owes a delete (it may have been sent)", async () => {
    const { owed } = await deleteLocally(catalogPick().card);
    expect(owed.map((r) => r.state)).toEqual(["deleted"]);
  });

  it("drops any revision and leaves a card already under local refs as it was", () => {
    const card: LoggedFood = { ...bundledPick().card, rev: 3 };
    const kept = localOnlyCard(card);
    expect(kept).not.toHaveProperty("rev");
    expect(kept).not.toHaveProperty("items");
    expect(localOnlyCard(kept)).toEqual(kept);
  });

  it("a revision on the card still means the server has it, mark or not", async () => {
    const card = { ...localOnlyCard(catalogPick().card), rev: 1 };
    const { owed } = await deleteLocally(card);
    expect(owed.map((r) => r.state)).toEqual(["deleted"]);
  });
});
