import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { assertSupported } from "@/lib/ai/json-schema";
import {
  ACTION_KINDS, coachActionSchema, coachActionWireSchema, flatCoachActionSchema,
  deriveMealTitle, groundedCoachActionSchema, groundActions, providerActionSchema,
} from "@/lib/coach/actions";
import { actionTitle } from "@/components/CoachActionCard";
import { TEST_PROFILE as DEFAULT_PROFILE } from "@/tests/helpers/constraint-profile";

const ACTION_ID = "3f1b1a2c-0000-4000-8000-0000000000a1";
const ENTRY_ID = "3f1b1a2c-0000-4000-8000-0000000000e1";
const REF = (n: string) => `3f1b1a2c-0000-4000-8000-0000000000${n}`;

const hit = (over: Record<string, unknown> = {}) => ({
  foodRefId: REF("11"), name: "beef jerky", brand: null, kcalPer100g: 410,
  proteinPer100g: 33, carbsPer100g: 30, fatPer100g: 16, prefStatus: null,
  catalogFoodRevisionId: 7, allergenTags: null, category: null,
  portionGrams: 28, portionLabel: "1 piece", ...over,
});

function ports(search: (q: string) => unknown[]) {
  return {
    searchFoods: vi.fn(async (_u: string, q: string) => search(q) as never),
    newActionId: () => ACTION_ID,
    knownEntries: async () => new Map([[ENTRY_ID, "eggs at 09:00"]]),
  };
}

describe("the coach action kinds", () => {
  it("names every kind, and every one lowers to a schema Gemini accepts", () => {
    expect([...ACTION_KINDS]).toEqual([
      "log_meal", "add_slot_item", "remove_slot_item", "set_slot_item", "move_slot",
      "add_to_avoid", "remove_from_avoid", "set_slot_meal", "delete_entry", "move_entry",
      "save_recipe", "shift_schedule", "log_water", "log_weight", "update_profile",
      "set_targets", "add_to_eats", "remove_from_eats", "add_to_shopping_list",
      "skip_slot", "restore_slot",
    ]);
    expect(() => assertSupported(flatCoachActionSchema)).not.toThrow();
  });

  it("accepts an `at` and a snack on log_meal, and refuses a bad clock time", () => {
    expect(coachActionSchema.safeParse({
      kind: "log_meal", date: "2026-09-16", slot: "snack", at: "09:00",
      items: [{ name: "eggs", grams: 150 }],
    }).success).toBe(true);
    expect(coachActionSchema.safeParse({
      kind: "log_meal", date: "2026-09-16", slot: "meal-1", at: "9am",
      items: [{ name: "eggs", grams: 150 }],
    }).success).toBe(false);
  });

  it("refuses a snack on a slot action — a snack is an extra, not a slot", () => {
    expect(coachActionSchema.safeParse({
      kind: "set_slot_meal", date: "2026-09-16", slot: "snack",
      items: [{ name: "eggs", grams: 150 }],
    }).success).toBe(false);
  });

  it("refuses an entry id that is not a uuid", () => {
    expect(coachActionSchema.safeParse({ kind: "delete_entry", entryId: "the eggs one" })
      .success).toBe(false);
  });

  // PRD §2.3: `date` remains an alias of `from`, `through` defaults to `from`, and titles are
  // sanitized dish names rather than slot labels.
  it("canonicalizes the legacy date alias and sanitizes the required dish title", () => {
    const parsed = coachActionSchema.parse({
      kind: "set_slot_meal", date: "2026-09-20", slot: "meal-1",
      title: "  Sourdough\u0007   toast, bacon & eggs  ",
      items: [{ name: "eggs", grams: 200 }],
    });

    expect(parsed).toMatchObject({
      kind: "set_slot_meal", from: "2026-09-20", through: "2026-09-20",
      title: "Sourdough toast, bacon & eggs",
    });
    expect(parsed).not.toHaveProperty("dates");
  });

  it("accepts weekday filters only as Sunday-through-Saturday numbers", () => {
    const base = {
      kind: "set_slot_meal", from: "2026-09-20", through: "2026-10-03",
      slot: "meal-1", title: "Oatmeal with blueberries",
      items: [{ name: "oatmeal", grams: 234 }],
    } as const;

    expect(coachActionSchema.safeParse({ ...base, weekdays: [0, 1, 6] }).success).toBe(true);
    expect(coachActionSchema.safeParse({ ...base, weekdays: [7] }).success).toBe(false);
    expect(coachActionSchema.safeParse({ ...base, weekdays: [-1] }).success).toBe(false);
  });

  it("rejects blank titles and clamps coach-authored titles to 40 characters", () => {
    const base = {
      kind: "log_meal", date: "2026-09-20", slot: "snack",
      items: [{ name: "spaghetti bolognese", grams: 350 }],
    } as const;

    expect(coachActionSchema.safeParse({ ...base, title: " \u0000\n " }).success).toBe(false);
    const long = coachActionSchema.parse({ ...base, title: "x".repeat(41) });
    expect(long.kind === "log_meal" && long.title).toBe("x".repeat(40));
    const parsed = coachActionSchema.parse({ ...base, title: "  Spaghetti   bolognese " });
    expect(parsed).toMatchObject({ kind: "log_meal", title: "Spaghetti bolognese" });
  });

  it("tolerates old ungrounded rows without inventing a slot-name title", () => {
    const planned = coachActionSchema.parse({
      kind: "set_slot_meal", date: "2026-09-20", slot: "meal-1",
      items: [
        { name: "sourdough toast", grams: 76 }, { name: "bacon", grams: 24 },
        { name: "eggs", grams: 200 },
      ],
    });
    const logged = coachActionSchema.parse({
      kind: "log_meal", date: "2026-09-20", slot: "snack",
      items: [{ name: "spaghetti bolognese", grams: 350 }],
    });

    expect(planned).not.toHaveProperty("title");
    expect(logged).not.toHaveProperty("title");
  });

  it("derives a title when replaying an old grounded row", () => {
    const parsed = groundedCoachActionSchema.parse({
      actionId: ACTION_ID, flagged: [], kind: "set_slot_meal",
      date: "2026-09-20", slot: "meal-1",
      items: [{ ...hit({ name: "eggs" }), grams: 200, verdict: "allowed" }],
    });

    expect(parsed).toMatchObject({
      from: "2026-09-20", through: "2026-09-20", dates: ["2026-09-20"], title: "Eggs",
    });
  });

  it("never derives the bare placeholder title Meal", () => {
    expect(deriveMealTitle([])).toBeNull();
    expect(deriveMealTitle([{ name: "meal" }])).toBeNull();
  });
});

describe("grounding the new actions", () => {
  it("grounds add_to_avoid to one food ref through searchFoods", async () => {
    const { actions, clarifications } = await groundActions("u1",
      [{ kind: "add_to_avoid", name: "watermelon" }], DEFAULT_PROFILE,
      ports(() => [hit({ name: "watermelon", foodRefId: REF("22") })]));
    expect(clarifications).toEqual([]);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: "add_to_avoid", name: "watermelon",
      foodRefId: REF("22") });
  });

  it("asks one question instead of guessing when the food cannot be grounded", async () => {
    const { actions, clarifications } = await groundActions("u1",
      [{ kind: "add_to_avoid", name: "zzzz" }], DEFAULT_PROFILE, ports(() => []));
    expect(actions).toEqual([]);
    expect(clarifications[0]).toContain("zzzz");
  });

  it("takes the household portion for a set_slot_meal item with no grams", async () => {
    const { actions } = await groundActions("u1",
      [{ kind: "set_slot_meal", date: "2026-09-16", slot: "meal-2",
        items: [{ name: "beef jerky" }] }],
      DEFAULT_PROFILE, ports(() => [hit()]));
    expect(actions[0]).toMatchObject({ kind: "set_slot_meal" });
    expect(actions[0].kind === "set_slot_meal" && actions[0].items[0].grams).toBe(28);
  });

  it("asks one question when the food has no portion and she gave no grams", async () => {
    const { actions, clarifications } = await groundActions("u1",
      [{ kind: "set_slot_meal", date: "2026-09-16", slot: "meal-2",
        items: [{ name: "beef jerky" }] }],
      DEFAULT_PROFILE, ports(() => [hit({ portionGrams: null })]));
    expect(actions).toEqual([]);
    expect(clarifications).toEqual(["How much beef jerky?"]);
  });

  it("MARKS a blocked item and still emits the action — it never refuses", async () => {
    const { actions } = await groundActions("u1",
      [{ kind: "set_slot_meal", date: "2026-09-16", slot: "meal-2", items: [
        { name: "beef jerky", grams: 40 },
        { name: "Chobani yogurt", grams: 150 },
      ] }],
      DEFAULT_PROFILE,
      ports((q) => q.toLowerCase().includes("chobani")
        ? [hit({ name: "Chobani yogurt", foodRefId: REF("33"), allergenTags: ["dairy"] })]
        : [hit()]));
    expect(actions).toHaveLength(1);
    expect(actions[0].flagged).toEqual(["Chobani yogurt"]);
    expect(actions[0].kind === "set_slot_meal" && actions[0].items).toHaveLength(2);
  });

  it("drops delete_entry and move_entry for an id she does not have", async () => {
    const { actions, clarifications } = await groundActions("u1",
      [{ kind: "delete_entry", entryId: "3f1b1a2c-0000-4000-8000-0000000000ff" }],
      DEFAULT_PROFILE, ports(() => []));
    expect(actions).toEqual([]);
    expect(clarifications[0]).toContain("could not find that entry");
  });

  it("carries what a delete or a move is about, so the card can name it", async () => {
    const { actions } = await groundActions("u1",
      [{ kind: "move_entry", entryId: ENTRY_ID, at: "13:30" }],
      DEFAULT_PROFILE, ports(() => []));
    expect(actions[0]).toMatchObject({ kind: "move_entry", at: "13:30", what: "eggs at 09:00" });
  });

  it("grounds every item of a save_recipe", async () => {
    const { actions } = await groundActions("u1",
      [{ kind: "save_recipe", name: "Chicken wrap",
        items: [{ name: "chicken", grams: 120 }, { name: "tortilla", grams: 45 }] }],
      DEFAULT_PROFILE, ports(() => [hit()]));
    expect(actions[0].kind === "save_recipe" && actions[0].items).toHaveLength(2);
    expect(actions[0].kind === "save_recipe" && actions[0].name).toBe("Chicken wrap");
  });
});

describe("the wire form of the new actions", () => {
  it("round-trips a set_slot_meal through the flat provider schema", () => {
    const parsed = coachActionWireSchema.safeParse({
      kind: "set_slot_meal", date: "2026-09-16", slot: "meal-2",
      title: "Beef jerky",
      items: [{ name: "beef jerky", grams: 40 }],
    });
    expect(parsed.success).toBe(true);
  });

  it("requires a non-empty set_slot_meal title on the live wire while legacy rows still parse", () => {
    expect(coachActionWireSchema.safeParse({
      kind: "set_slot_meal", date: "2026-09-16", slot: "meal-2",
      items: [{ name: "beef jerky", grams: 40 }],
    }).success).toBe(false);
    expect(coachActionWireSchema.safeParse({
      kind: "set_slot_meal", date: "2026-09-16", slot: "meal-2", title: " \u0000 ",
      items: [{ name: "beef jerky", grams: 40 }],
    }).success).toBe(false);
    expect(coachActionSchema.parse({
      kind: "set_slot_meal", date: "2026-09-16", slot: "meal-2",
      items: [{ name: "beef jerky", grams: 40 }],
    })).toMatchObject({ from: "2026-09-16" });
    const oldLog = coachActionWireSchema.parse({
      kind: "log_meal", date: "2026-09-16", slot: "snack",
      items: [{ name: "beef jerky", grams: 40 }],
    });
    expect(oldLog).not.toHaveProperty("title");

    const required = (z.toJSONSchema(providerActionSchema).required ?? []) as string[];
    expect(required).toEqual(expect.arrayContaining(["from", "through", "weekdays", "title"]));
    expect(required).not.toContain("dates");
  });

  it("drops model-authored dates before the strict action boundary", () => {
    const parsed = coachActionWireSchema.parse({
      kind: "set_slot_meal", from: "2026-09-20", through: "2026-09-22",
      weekdays: [1, 2], dates: ["2099-01-01"], slot: "meal-1", title: "Eggs",
      items: [{ name: "eggs", grams: 200 }],
    });

    expect(parsed).not.toHaveProperty("dates");
  });

  it("round-trips a delete_entry, which carries no date and no slot", () => {
    const parsed = coachActionWireSchema.safeParse({ kind: "delete_entry", entryId: ENTRY_ID });
    expect(parsed.success).toBe(true);
  });
});

describe("the action card", () => {
  const base = { actionId: ACTION_ID, flagged: [] };
  const item = { name: "beef jerky", grams: 40, foodRefId: REF("11"),
    catalogFoodRevisionId: 7, kcalPer100g: 410, proteinPer100g: 33, carbsPer100g: 30,
    fatPer100g: 16, verdict: "allowed" as const };

  it.each([
    [{ ...base, kind: "add_to_avoid" as const, ...item, name: "watermelon" },
      "Added watermelon to your avoid list"],
    [{ ...base, kind: "remove_from_avoid" as const, ...item, name: "watermelon" },
      "Took watermelon off your avoid list"],
    [{ ...base, kind: "set_slot_meal" as const, date: "2026-09-16", slot: "meal-2" as const,
      items: [item] }, "Changed meal 2"],
    [{ ...base, kind: "delete_entry" as const, entryId: ENTRY_ID, what: "eggs at 09:00" },
      "Deleted eggs at 09:00"],
    [{ ...base, kind: "move_entry" as const, entryId: ENTRY_ID, at: "13:30",
      what: "eggs at 09:00" }, "Moved eggs at 09:00 to 13:30"],
    [{ ...base, kind: "save_recipe" as const, name: "Chicken wrap", items: [item] },
      'Saved the recipe "Chicken wrap"'],
    [{ ...base, kind: "log_meal" as const, date: "2026-09-16", slot: "snack" as const,
      at: "15:30", items: [item] }, "Logged a snack at 15:30"],
  ])("titles %#", (action, title) => {
    expect(actionTitle(action)).toBe(title);
  });
});
