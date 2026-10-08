// 2026-10-07 live QA: an onboarding-v2 account that tapped "Sprout, pick for me" was saved with
// all 29 curated defaults as Eats, because the selection started with every default pre-marked
// and the falling pile never showed those marks. The planner then built meals ("Tofu with ...")
// from foods the person never chose.
import { describe, expect, it } from "vitest";
import {
  initialStarterSelection, STARTERS, starterChoices, starterFillShortRoles, starterSelectionValid,
} from "@/lib/foods/starter";

const emptyRules = { avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [], conditions: [], notes: null };
const eats = (marks: Record<string, string>) => Object.entries(marks).filter(([, m]) => m === "eats").map(([id]) => id);

describe("love-round starter selection", () => {
  it("the legacy grid still pre-marks every default", () => {
    const marks = initialStarterSelection([], emptyRules, "");
    expect(eats(marks).length).toBe(STARTERS.filter((s) => s.default).length);
  });

  it("preselectDefaults: false starts empty, but keeps foods named in text and saved foods", () => {
    expect(initialStarterSelection([], emptyRules, "", [], [], { preselectDefaults: false })).toEqual({});
    const marks = initialStarterSelection([], emptyRules, "I love salmon", [], [], { preselectDefaults: false });
    expect(eats(marks)).toEqual(["salmon-wild-sockeye-cooked"]);
  });

  it("pick for me fills only the roles still short, never re-marks a tap, and makes the selection valid", () => {
    const choices = starterChoices([], emptyRules);
    const marks: Record<string, "eats" | "avoid" | "neutral"> = {
      "tofu-firm": "eats", "salmon-wild-sockeye-cooked": "eats", "chicken-breast-roasted": "avoid",
      "white-rice-cooked": "eats",
    };
    const added = starterFillShortRoles(choices, marks);
    expect(added).not.toContain("chicken-breast-roasted");
    expect(added.filter((id) => choices.find((c) => c.id === id)?.role === "protein")).toEqual([]);
    expect(added.filter((id) => choices.find((c) => c.id === id)?.role === "carb")).toHaveLength(1);
    expect(added.filter((id) => choices.find((c) => c.id === id)?.role === "fat")).toHaveLength(2);
    const next = { ...marks, ...Object.fromEntries(added.map((id) => [id, "eats" as const])) };
    expect(starterSelectionValid(eats(next), choices)).toBe(true);
    expect(eats(next)).toHaveLength(6);
    expect(starterFillShortRoles(choices, next)).toEqual([]);
  });
});
