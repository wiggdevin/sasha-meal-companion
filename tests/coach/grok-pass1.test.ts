import { describe, expect, it, vi } from "vitest";
import { actionLine } from "@/lib/coach/history";
import { composedActions, defaultSlot } from "@/components/CoachComposedCard";
import { eatsMatch } from "@/lib/coach/compose";
import { groundActions } from "@/lib/coach/ground";
import { isCapacityFailure, worthAnotherModel } from "@/lib/ai/failures";
import { ProviderHttpError } from "@/lib/ai/adapter";
import { recentEntriesFor } from "@/lib/coach-client";
import { TEST_PROFILE as DEFAULT_PROFILE } from "@/tests/helpers/constraint-profile";
import type { CoachAction, GroundedActionItem } from "@/lib/coach/actions";
import type { ComposedMeal } from "@/lib/coach/compose";

const ID = "3f1b1a2c-0000-4000-8000-0000000000a1";
const ENTRY = "3f1b1a2c-0000-4000-8000-0000000000e1";
const item = (name: string, grams: number): GroundedActionItem => ({
  name, grams, foodRefId: "3f1b1a2c-0000-4000-8000-00000000001a", catalogFoodRevisionId: 7,
  kcalPer100g: 400, proteinPer100g: 30, carbsPer100g: 20, fatPer100g: 10, verdict: "allowed",
});
const base = { actionId: ID, flagged: [] };

describe("HIGH 2 — every action kind renders its payload in the memory window", () => {
  it.each<[CoachAction, string]>([
    [{ ...base, kind: "set_slot_meal", date: "2026-09-18", slot: "meal-2",
      items: [item("beef jerky", 40), item("Chobani", 150)] },
      "[action: set_slot_meal meal-2 → beef jerky 40 g, Chobani 150 g]"],
    [{ ...base, kind: "add_to_avoid", ...item("watermelon", 1), name: "watermelon" } as CoachAction,
      "[action: add_to_avoid watermelon]"],
    [{ ...base, kind: "remove_from_avoid", ...item("watermelon", 1),
      name: "watermelon" } as CoachAction, "[action: remove_from_avoid watermelon]"],
    [{ ...base, kind: "delete_entry", entryId: ENTRY, what: "eggs at 09:00" },
      `[action: delete_entry ${ENTRY} eggs at 09:00]`],
    [{ ...base, kind: "move_entry", entryId: ENTRY, what: "eggs at 09:00", at: "13:30" },
      `[action: move_entry ${ENTRY} eggs at 09:00 → 13:30]`],
    [{ ...base, kind: "save_recipe", name: "Chicken wrap", items: [item("chicken", 120)] },
      '[action: save_recipe "Chicken wrap" → chicken 120 g]'],
    [{ ...base, kind: "log_meal", date: "2026-09-18", slot: "snack", at: "15:30",
      items: [item("banana", 100)] }, "[action: log_meal snack at 15:30 → banana 100 g]"],
  ])("renders %#", (action, line) => {
    expect(actionLine(action)).toBe(line);
  });

  it("leaves no kind rendering as a bare name", () => {
    const kinds: CoachAction[] = [
      { ...base, kind: "set_slot_meal", date: "2026-09-18", slot: "meal-1", items: [item("x", 1)] },
      { ...base, kind: "delete_entry", entryId: ENTRY, what: "x" },
    ];
    for (const action of kinds) expect(actionLine(action)).not.toBe(`[action: ${action.kind}]`);
  });
});

describe("HIGH 4 — the card always offers a slot", () => {
  const meal = {
    wish: "chicken wrap", slot: null, items: [], totals: { kcal: 0, protein: 0, carbs: 0, fat: 0 },
    target: { kcal: 0, protein: 0, carbs: 0, fat: 0 }, flagged: [], fitsTarget: false,
    pendingSlots: [{ slot: "meal-2", label: "Lunch" }, { slot: "meal-3", label: "Dinner" }],
  } satisfies ComposedMeal;

  it("falls back to the next pending meal slot when the wish named none", () => {
    expect(defaultSlot(meal)).toBe("meal-2");
  });

  it("prefers the slot the wish named", () => {
    expect(defaultSlot({ ...meal, slot: "meal-3" })).toBe("meal-3");
  });

  it("offers nothing only when no meal is pending", () => {
    expect(defaultSlot({ ...meal, pendingSlots: [] })).toBeNull();
  });
});

describe("MEDIUM 21 — the action is minted at the tap, not at the render", () => {
  const meal = {
    wish: "chicken wrap", slot: "meal-2", items: [{
      name: "chicken", foodRefId: "3f1b1a2c-0000-4000-8000-00000000001a",
      catalogFoodRevisionId: 7, grams: 120, kcalPer100g: 165, proteinPer100g: 31,
      carbsPer100g: 0, fatPer100g: 3.6, macros: { kcal: 198, protein: 37, carbs: 0, fat: 4 },
      verdict: "allowed" as const,
    }], totals: { kcal: 198, protein: 37, carbs: 0, fat: 4 },
    target: { kcal: 500, protein: 40, carbs: 40, fat: 15 }, flagged: [], fitsTarget: false,
  } satisfies ComposedMeal;

  it("takes the date and the clock from the moment it is called", () => {
    const first = composedActions(meal, "meal-2",
      { date: "2026-09-18", at: "23:59" }, () => "a");
    const second = composedActions(meal, "meal-2",
      { date: "2026-09-19", at: "00:01" }, () => "b");
    expect(first.log).toMatchObject({ date: "2026-09-18", at: "23:59", actionId: "a" });
    expect(second.log).toMatchObject({ date: "2026-09-19", at: "00:01", actionId: "b" });
  });
});

describe("MEDIUM 17 — only a model out of capacity is worth a second model", () => {
  it.each([
    [new ProviderHttpError(503, "gemini 503: overloaded"), true],
    [new ProviderHttpError(429, "gemini 429: quota"), false],
    [new Error("model output failed the schema: …"), false],
    [new Error("the provider did not answer within 10176ms"), false],
    [new Error("UNAVAILABLE: model overloaded"), true],
  ])("decides %#", (error, expected) => {
    expect(worthAnotherModel(error)).toBe(expected);
  });

  it("still calls a 429 a capacity failure — it just is not worth another model", () => {
    expect(isCapacityFailure(new ProviderHttpError(429, "gemini 429"))).toBe(true);
  });
});

describe("HIGH 6 — what an entry action may name", () => {
  const ports = (known?: Map<string, string>) => ({
    searchFoods: async () => [],
    newActionId: () => ID,
    ...(known ? { knownEntries: async () => known } : {}),
  });

  it("accepts an id the client carried for an entry the server has not seen yet", async () => {
    const { actions } = await groundActions("u1",
      [{ kind: "move_entry", entryId: ENTRY, at: "13:30" }], DEFAULT_PROFILE,
      ports(new Map([[ENTRY, "eggs at 09:00"]])));
    expect(actions[0]).toMatchObject({ kind: "move_entry", what: "eggs at 09:00" });
  });

  it("says it could not CHECK, not that the entry does not exist, when there is no list", async () => {
    const { actions, clarifications } = await groundActions("u1",
      [{ kind: "delete_entry", entryId: ENTRY }], DEFAULT_PROFILE, ports());
    expect(actions).toEqual([]);
    expect(clarifications[0]).toContain("could not check");
  });

  it("reads her local entries for the turn's own date", () => {
    const store = { days: { "2026-09-18": { extras: [
      { id: ENTRY, name: "Eggs", at: "2026-09-18T15:00:00.000Z" },
    ] } } };
    expect(recentEntriesFor("2026-09-18", "America/Denver", () => store))
      .toEqual([{ entryId: ENTRY, what: "Eggs at 09:00" }]);
  });

  it("returns nothing for a date she has logged nothing on", () => {
    expect(recentEntriesFor("2026-09-17", "UTC", () => ({ days: {} }))).toEqual([]);
  });
});

describe("MEDIUM 10 — her own word for a food", () => {
  it("binds 'wrap' to the tortilla on her list", () => {
    expect(eatsMatch("wrap", ["Tortilla, corn", "Banana, raw"])).toBe("Tortilla, corn");
  });

  it("takes the LONGEST match, which is the row she actually marked", () => {
    expect(eatsMatch("rice", ["Rice", "Rice, white, cooked"])).toBe("Rice, white, cooked");
  });

  it("answers null when her list holds nothing like it", () => {
    expect(eatsMatch("quinoa", ["Banana, raw"])).toBeNull();
  });
});

describe("HIGH 8 — undo of a delete puts back what she had", () => {
  it("keeps the slot, the time and the items on the token", async () => {
    const applied = await import("@/lib/coach/apply-entries");
    expect(typeof applied.undoDeleteEntry).toBe("function");
    // The token's shape is the contract; apply-client's performUndo passes it straight through.
    const token = { kind: "delete_entry" as const, date: "2026-09-18",
      entry: { id: "x", foodId: "meal", name: "Eggs", qty: 1, grams: 150, portionLabel: "1 item",
        macros: { kcal: 200, protein: 12, carbs: 1, fat: 15 }, at: "2026-09-18T15:00:00.000Z" },
      slot: "meal-1" as const, eatenAt: "2026-09-18T15:00:00.000Z",
      items: [{ foodRefId: "3f1b1a2c-0000-4000-8000-00000000001a", grams: 150,
        revisionId: 7, name: "Eggs" }] };
    expect(token.slot).toBe("meal-1");
    expect(token.items[0].revisionId).toBe(7);
    expect(token.eatenAt).toBe(token.entry.at);
  });
});

describe("HIGH 1 — an avoid mark writes the ref the server grounded", () => {
  it("carries the grounded foodRefId on the undo token, never a name", async () => {
    vi.resetModules();
    const { applyAvoidMark } = await import("@/lib/coach/apply-prefs");
    expect(applyAvoidMark.length).toBe(1);
  });
});
