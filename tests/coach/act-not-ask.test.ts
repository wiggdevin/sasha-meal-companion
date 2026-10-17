/**
 * Live pass 2026-10-17 (docs/evals/2026-10-17-coach-live-pass-rerun.md): four turns asked a
 * question instead of acting. Two were grounding ("How much chicken breast, roasted? How much
 * rice, white, cooked?" for a plan change whose catalog rows carry no household portion); two
 * were the model asking where the prompt should have it act. These pin the turn shapes.
 */
import { describe, expect, it, vi } from "vitest";
import { groundActions } from "@/lib/coach/actions";
import { usualServing } from "@/lib/coach/actions/ground-kit";
import type { FoodHit } from "@/lib/coach/executors";
import { buildSystemPrompt } from "@/lib/coach/prompt";
import { TEST_PROFILE } from "@/tests/helpers/constraint-profile";

const REF = (n: number) => `3f1b1a2c-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;

/** The coach-eval seed's rows: per-100 g numbers and no household portion. */
const SEED: Record<string, FoodHit> = {
  chicken: { foodRefId: REF(1), name: "Chicken breast, roasted", brand: null, kcalPer100g: 165,
    proteinPer100g: 31, carbsPer100g: 0, fatPer100g: 3.6, prefStatus: "eats", portionGrams: null },
  rice: { foodRefId: REF(2), name: "Rice, white, cooked", brand: null, kcalPer100g: 130,
    proteinPer100g: 2.7, carbsPer100g: 28, fatPer100g: 0.3, prefStatus: "eats", portionGrams: null },
  oatmeal: { foodRefId: REF(3), name: "Oatmeal, cooked", brand: null, kcalPer100g: 71,
    proteinPer100g: 2.5, carbsPer100g: 12, fatPer100g: 1.5, prefStatus: "eats", portionGrams: null },
  blueberries: { foodRefId: REF(4), name: "Blueberries, raw", brand: null, kcalPer100g: 57,
    proteinPer100g: 0.7, carbsPer100g: 14, fatPer100g: 0.3, prefStatus: "eats", portionGrams: null },
} as Record<string, FoodHit>;

function ports() {
  let next = 0;
  return {
    searchFoods: vi.fn(async (_user: string, query: string) => {
      const key = Object.keys(SEED).find((name) => query.toLowerCase().includes(name));
      return key ? [SEED[key]] : [];
    }),
    newActionId: () => `a${(next += 1)}`,
  };
}

describe("a plan change with no grams and no catalog portion acts", () => {
  it("Change next Tuesday's lunch to grilled chicken and rice: sets the slot", async () => {
    const { actions, clarifications } = await groundActions("u1", [{
      kind: "set_slot_meal", from: "2026-10-20", slot: "meal-2", title: "Grilled chicken & rice",
      items: [{ name: "chicken breast, roasted" }, { name: "rice, white, cooked" }],
    }], TEST_PROFILE, ports());
    expect(clarifications).toEqual([]);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: "set_slot_meal", slot: "meal-2",
      items: [{ name: "chicken breast, roasted", grams: 150 }, { name: "rice, white, cooked", grams: 150 }] });
  });

  it("oatmeal with blueberries every weekday for two weeks: sets the weekday range", async () => {
    const { actions, clarifications } = await groundActions("u1", [{
      kind: "set_slot_meal", from: "2026-10-19", through: "2026-11-01", weekdays: [1, 2, 3, 4, 5],
      slot: "meal-1", title: "Oatmeal with blueberries",
      items: [{ name: "oatmeal" }, { name: "blueberries" }],
    }], TEST_PROFILE, ports());
    expect(clarifications).toEqual([]);
    const action = actions[0];
    expect(action.kind).toBe("set_slot_meal");
    if (action.kind !== "set_slot_meal") return;
    expect(action).toMatchObject({ from: "2026-10-19", through: "2026-11-01", weekdays: [1, 2, 3, 4, 5] });
    expect(action.items.map((item) => item.grams)).toEqual([50, 120]);
  });

  it("still asks what a food is when the catalog has nothing for it", async () => {
    const { actions, clarifications } = await groundActions("u1", [{
      kind: "set_slot_meal", from: "2026-10-20", slot: "meal-2", title: "Mystery",
      items: [{ name: "zzzz" }],
    }], TEST_PROFILE, ports());
    expect(actions).toEqual([]);
    expect(clarifications).toEqual(['I could not find "zzzz" — what should I log it as?']);
  });
});

describe("usualServing", () => {
  it("reads the portion band by kind", () => {
    expect(usualServing({ name: "Chicken breast, roasted", kcalPer100g: 165 })).toBe(150);
    expect(usualServing({ name: "Greek yogurt, plain", kcalPer100g: 97 })).toBe(200);
    expect(usualServing({ name: "Eggs, cooked", kcalPer100g: 155 })).toBe(100);
  });

  it("caps an energy-dense guess and never returns zero", () => {
    expect(usualServing({ name: "Candy, gummy", kcalPer100g: 350 })).toBe(115);
    expect(usualServing({ name: "Olive oil", kcalPer100g: 884 })).toBe(10);
    expect(usualServing({ name: "Mystery", kcalPer100g: null })).toBe(150);
    expect(usualServing({ name: "Lard", kcalPer100g: 100_000 })).toBe(5);
  });
});

describe("the prompt tells the model to act on these turns", () => {
  const prompt = buildSystemPrompt({
    constraints: { avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [],
      conditions: [], notes: null },
    today: "2026-10-17",
  } as never);

  it("acts on a count of suggestions with no meal named", () => {
    expect(prompt).toContain("make me 5 suggestions from my eats list");
    expect(prompt).toContain("Never ask what kind of meal first.");
  });

  it("offers quick replies for a change that names no new food", () => {
    expect(prompt).toContain("can you change my breakfast?");
    expect(prompt).toMatch(/call quick_replies with 2–4 directions/);
  });

  it("never asks how much for a plan change", () => {
    expect(prompt).toContain("A plan change (set_slot_meal) never asks how much");
  });
});
