/**
 * AI audit 2026-10-01: each coach action card has its own Undo, with no ordering. Undoing one
 * slot edit must invert ONLY that edit, against the slot as it is now — never wipe a later edit
 * to the same slot by restoring the whole snapshot taken when the action applied.
 *
 * The slot store is a small in-memory fake with saveMealEdit's component/title/followPlan rules,
 * so apply and undo run against the same evolving state.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoachAction, GroundedActionItem } from "@/lib/coach/actions";
import type { FoodComponent, SlotId, SlotOverride } from "@/lib/types";
import { componentsForSlot } from "@/lib/plan/slot-override";

type Slot = { planned: FoodComponent[]; override: SlotOverride | null };
type Edit = { components?: FoodComponent[] | null; planned: FoodComponent[];
  title?: string | null };

const fake = vi.hoisted(() => ({ slots: new Map<string, unknown>() }));
const key = (date: string, slot: string) => `${date}/${slot}`;

vi.mock("@/lib/plan-day-client", () => ({
  saveMealEdit: vi.fn(async (date: string, slot: string, baseMealId: string | null,
    edit: Edit) => {
    const state = fake.slots.get(key(date, slot)) as Slot;
    const override: SlotOverride = state.override
      ? { ...state.override, baseMealId }
      : { baseMealId, components: edit.planned, followPlan: true };
    if (edit.components === null) {
      override.components = edit.planned;
      override.followPlan = true;
    } else if (edit.components !== undefined) {
      override.components = edit.components;
      delete override.followPlan;
    }
    if (edit.components === null || edit.title === null) delete override.title;
    else if (edit.title !== undefined) override.title = edit.title;
    state.override = override.followPlan && override.title === undefined ? null : override;
    return { date };
  }),
}));
vi.mock("@/lib/coach/apply-shared", async (orig) => ({
  ...(await orig<typeof import("@/lib/coach/apply-shared")>()),
  slotContext: (date: string, slot: SlotId) => {
    const state = fake.slots.get(key(date, slot)) as Slot | undefined;
    if (!state) return null;
    const previous = state.override ? structuredClone(state.override) : null;
    return { baseMealId: "breakfast", planned: state.planned,
      components: componentsForSlot(state.planned, previous ?? undefined), previous };
  },
}));

import { applySetSlotMeal, applySlot, undoSlot } from "@/lib/coach/apply-slot";
import { resetTestAccount } from "@/tests/helpers/account";

const DATE = "2026-09-16";

const chicken: FoodComponent = { name: "Chicken breast", qty: 100, unit: "g", role: "protein",
  macros: { kcal: 165, protein: 31, carbs: 0, fat: 3.6 } };
const rice: FoodComponent = { name: "White rice", qty: 100, unit: "g", role: "carb",
  macros: { kcal: 130, protein: 2.7, carbs: 28, fat: 0.3 } };
const oil: FoodComponent = { name: "Olive oil", qty: 1, unit: "tbsp", role: "fat",
  macros: { kcal: 119, protein: 0, carbs: 0, fat: 13.5 } };

function grounded(overrides: Partial<GroundedActionItem> = {}): GroundedActionItem {
  return { name: "Banana", grams: 120, foodRefId: "ref-banana", catalogFoodRevisionId: 1,
    kcalPer100g: 89, proteinPer100g: 1.1, carbsPer100g: 22.8, fatPer100g: 0.3,
    verdict: "allowed", ...overrides };
}

const chickenItem = { kcalPer100g: 165, proteinPer100g: 31, carbsPer100g: 0, fatPer100g: 3.6 };

type SlotAction = Parameters<typeof applySlot>[0];
const addBanana = (): SlotAction => ({ actionId: "a-add", kind: "add_slot_item", date: DATE,
  slot: "meal-2", item: grounded(), flagged: [] } as SlotAction);
const setChicken = (grams: number): SlotAction => ({ ...grounded({ name: "chicken", grams,
  ...chickenItem }), actionId: `a-set-${grams}`, kind: "set_slot_item", date: DATE,
  slot: "meal-2", name: "chicken", grams, flagged: [] } as unknown as SlotAction);
const setOil = (grams: number): SlotAction => ({ ...grounded({ name: "olive oil", grams,
  kcalPer100g: 884, proteinPer100g: 0, carbsPer100g: 0, fatPer100g: 100 }),
  actionId: `a-set-oil-${grams}`, kind: "set_slot_item", date: DATE, slot: "meal-2",
  name: "olive oil", grams, flagged: [] } as unknown as SlotAction);
const removeRice = (): SlotAction => ({ actionId: "a-remove", kind: "remove_slot_item",
  date: DATE, slot: "meal-2", name: "rice", flagged: [] } as unknown as SlotAction);

async function apply(action: SlotAction) {
  const result = await applySlot(action);
  if (result.status !== "applied") throw new Error(`expected applied, got ${result.reason}`);
  return result.token as Parameters<typeof undoSlot>[0];
}

function current(): FoodComponent[] {
  const state = fake.slots.get(key(DATE, "meal-2")) as Slot;
  return componentsForSlot(state.planned, state.override ?? undefined);
}
const names = () => current().map((c) => `${c.name}:${c.qty}`);

beforeEach(async () => {
  await resetTestAccount();
  fake.slots.clear();
  fake.slots.set(key(DATE, "meal-2"), { planned: [chicken, rice, oil], override: null });
});

describe("slot item undo inverts only its own change", () => {
  it("undoing an earlier add keeps a later set on the same slot", async () => {
    const tokenA = await apply(addBanana());
    await apply(setChicken(250));
    await undoSlot(tokenA);
    expect(names()).toEqual(["Chicken breast:250", "White rice:100", "Olive oil:1"]);
  });

  it("undoing an earlier remove re-inserts the line at its old index and keeps later edits",
    async () => {
      const tokenA = await apply(removeRice());
      await apply(addBanana());
      await undoSlot(tokenA);
      expect(names()).toEqual(["Chicken breast:100", "White rice:100", "Olive oil:1",
        "Banana:120"]);
    });

  it("undoing an earlier set restores only that line and keeps a later add", async () => {
    const tokenA = await apply(setChicken(250));
    await apply(addBanana());
    await undoSlot(tokenA);
    expect(current()[0]).toEqual(chicken);
    expect(names()).toEqual(["Chicken breast:100", "White rice:100", "Olive oil:1",
      "Banana:120"]);
  });

  it("refuses a set undo when that line was changed again since, leaving the slot alone",
    async () => {
      const tokenA = await apply(setChicken(250));
      await apply(setChicken(300));
      await expect(undoSlot(tokenA)).rejects.toThrow(/changed since/i);
      expect(names()[0]).toBe("Chicken breast:300");
    });

  it("returns an untouched-since edit to following the plan", async () => {
    const token = await apply(addBanana());
    await undoSlot(token);
    expect((fake.slots.get(key(DATE, "meal-2")) as Slot).override).toBeNull();
  });

  it("returns to following the plan when a targeted undo lands back on the plan", async () => {
    const tokenA = await apply(addBanana());
    const tokenB = await apply(setChicken(250));
    await undoSlot(tokenB);
    await undoSlot(tokenA);
    expect((fake.slots.get(key(DATE, "meal-2")) as Slot).override).toBeNull();
  });
});

describe("set_slot_meal undo", () => {
  const swap = () => applySetSlotMeal({ actionId: "a-meal", kind: "set_slot_meal", from: DATE,
    dates: [DATE], slot: "meal-2", title: "Jerky plate",
    items: [grounded({ name: "Beef jerky", grams: 40 })], flagged: [],
  } as unknown as Extract<CoachAction, { kind: "set_slot_meal" }>);

  it("restores the snapshot when the slot is unchanged since the swap", async () => {
    const result = await swap();
    if (result.status !== "applied") throw new Error("expected applied");
    await undoSlot(result.token as Parameters<typeof undoSlot>[0]);
    expect((fake.slots.get(key(DATE, "meal-2")) as Slot).override).toBeNull();
    expect(names()).toEqual(["Chicken breast:100", "White rice:100", "Olive oil:1"]);
  });

  it("refuses when the slot was edited after the swap, keeping the later edit", async () => {
    const result = await swap();
    if (result.status !== "applied") throw new Error("expected applied");
    await apply(addBanana());
    await expect(undoSlot(result.token as Parameters<typeof undoSlot>[0])).rejects.toThrow();
    expect(names()).toEqual(["Beef jerky:40", "Banana:120"]);
  });
});

describe("set_slot_item keeps the line's own food (audit 2026-10-10 A158)", () => {
  it("scales a gram line's own numbers, not the searched row's", async () => {
    // The search for "chicken" found a 365 kcal/100 g row; the line is chicken breast at 165.
    await apply({ ...setChicken(200), kcalPer100g: 365, proteinPer100g: 7, carbsPer100g: 80,
      fatPer100g: 1 } as unknown as SlotAction);
    expect(current()[0]).toEqual({ ...chicken, qty: 200,
      macros: { kcal: 330, protein: 62, carbs: 0, fat: 7.2 } });
  });

  it("keeps the line's food key", async () => {
    const keyed = { ...rice, foodKey: "food:rice-cooked" };
    fake.slots.set(key(DATE, "meal-2"), { planned: [chicken, keyed, oil], override: null });
    await apply({ ...grounded({ name: "rice", grams: 150, kcalPer100g: 365 }),
      actionId: "a-rice", kind: "set_slot_item", date: DATE, slot: "meal-2", name: "rice",
      grams: 150, flagged: [] } as unknown as SlotAction);
    expect(current()[1]).toEqual({ ...keyed, qty: 150,
      macros: { kcal: 195, protein: 4.1, carbs: 42, fat: 0.5 } });
  });

  it("refuses a line with no gram basis rather than give it the searched row's numbers", async () => {
    const result = await applySlot(setOil(20));
    expect(result).toMatchObject({ status: "failed",
      reason: "Olive oil is measured in tbsp, not grams, so I left it as it is. Change its amount on the meal card." });
    expect(names()[2]).toBe("Olive oil:1");
  });

  it("applies even when the searched row's nutrition is incomplete", async () => {
    await apply({ ...setChicken(250), proteinPer100g: null, fatPer100g: null } as unknown as SlotAction);
    expect(names()[0]).toBe("Chicken breast:250");
  });
});

describe("a bad amount fails closed on every slot write (Grok round 6)", () => {
  const bad = [-50, 0, Number.NaN, Number.POSITIVE_INFINITY, 2001];

  it.each(bad)("set_slot_item refuses %s g and leaves the slot alone", async (grams) => {
    const result = await applySlot(setChicken(grams));
    expect(result).toMatchObject({ status: "failed", reason: expect.stringMatching(/needs an amount/) });
    expect((fake.slots.get(key(DATE, "meal-2")) as Slot).override).toBeNull();
  });

  it.each(bad)("add_slot_item refuses %s g", async (grams) => {
    const result = await applySlot({ ...addBanana(), item: grounded({ grams }) } as SlotAction);
    expect(result.status).toBe("failed");
    expect((fake.slots.get(key(DATE, "meal-2")) as Slot).override).toBeNull();
  });

  it.each(bad)("set_slot_meal refuses %s g", async (grams) => {
    const result = await applySetSlotMeal({ actionId: "a-meal", kind: "set_slot_meal", from: DATE,
      dates: [DATE], slot: "meal-2", title: "Jerky plate",
      items: [grounded({ name: "Beef jerky", grams })], flagged: [],
    } as unknown as Extract<CoachAction, { kind: "set_slot_meal" }>);
    expect(result.status).toBe("failed");
    expect((fake.slots.get(key(DATE, "meal-2")) as Slot).override).toBeNull();
  });

  it("still applies the largest allowed amount", async () => {
    await apply(setChicken(2000));
    expect(names()[0]).toBe("Chicken breast:2000");
  });
});

describe("an item with incomplete catalog nutrition (audit #20)", () => {
  const sparse = { proteinPer100g: null, fatPer100g: null } as Partial<GroundedActionItem>;

  it("is refused by add_slot_item and the slot is left alone", async () => {
    const result = await applySlot({ ...addBanana(), item: grounded(sparse) } as SlotAction);
    expect(result).toMatchObject({ status: "failed", reason: expect.stringMatching(/incomplete nutrition/) });
    expect((fake.slots.get(key(DATE, "meal-2")) as Slot).override).toBeNull();
  });

  it("is refused by set_slot_meal", async () => {
    const result = await applySetSlotMeal({ actionId: "a-meal", kind: "set_slot_meal", from: DATE,
      dates: [DATE], slot: "meal-2", title: "Sparse plate",
      items: [grounded({ name: "Mystery jerky", grams: 40, ...sparse })], flagged: [],
    } as unknown as Extract<CoachAction, { kind: "set_slot_meal" }>);
    expect(result.status).toBe("failed");
    expect((fake.slots.get(key(DATE, "meal-2")) as Slot).override).toBeNull();
  });
});
