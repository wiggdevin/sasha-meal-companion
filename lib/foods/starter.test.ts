import { describe, expect, it } from "vitest";
import { starterChoices, initialStarterSelection, starterFood, mentionedFoodChoices, starterSelectionValid } from "./starter";

import { profileInstancesForLegacyFlags } from "@/lib/policy/profiles/legacy-flags";

const emptyRules = { avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [], conditions: [], notes: null };

describe("account-safe starter foods", () => {
  it("has a real bundled catalog for every role and does not inherit original-client bans", () => {
    const choices = starterChoices([], emptyRules);
    for (const role of ["protein", "carb", "fat"] as const) {
      expect(choices.filter((item) => item.role === role).length).toBeGreaterThanOrEqual({ protein: 8, carb: 8, fat: 6 }[role]);
    }
    expect(choices.some((item) => item.id === "apple-with-skin")).toBe(true);
    expect(choices.some((item) => item.id === "white-bread")).toBe(true);
    expect(choices.some((item) => item.id === "whey-protein-powder")).toBe(true);
  });

  it("filters explicit diet, allergens, and category rules", () => {
    const vegan = starterChoices(["vegan"], emptyRules);
    expect(vegan.some((item) => item.id === "chicken-breast-roasted" || item.id === "egg-white" || item.id === "whey-protein-powder")).toBe(false);
    const restricted = starterChoices([], { ...emptyRules, avoid_allergens: ["dairy", "peanuts"], banned_categories: ["apple", "gluten"] });
    expect(restricted.some((item) => ["apple-with-skin", "white-bread", "whey-protein-powder", "peanut-butter"].includes(item.id))).toBe(false);
    expect(starterChoices(["no_soy"], emptyRules).some((item) => item.id === "tofu-firm")).toBe(false);
    expect(starterChoices([], { ...emptyRules, avoid_allergens: ["soy"] })
      .some((item) => item.id === "tofu-firm")).toBe(false);
    expect(starterChoices([], { ...emptyRules, avoid_food_ref_ids: ["unmapped-ref"] })).toEqual([]);
    expect(starterChoices([], { ...emptyRules, avoid_allergens: ["tree nuts", "milk"] })
      .some((item) => item.id === "almonds" || item.id === "whey-protein-powder")).toBe(false);
  });

  it("keeps reviewed diet choices when saved flags also arrive as profile rules", () => {
    for (const flags of [["vegetarian", "no_pork", "no_beef"], ["vegan"], ["pescatarian"]] as const) {
      const instances = profileInstancesForLegacyFlags(flags, "2026-09-01");
      expect(starterChoices(flags, emptyRules, instances).map((item) => item.id))
        .toEqual(starterChoices(flags, emptyRules).map((item) => item.id));
    }
  });

  it("does not clear confirmed allergy profiles from missing starter tags", () => {
    for (const flag of ["no_soy", "no_eggs", "no_peanuts", "no_shellfish"] as const) {
      expect(starterChoices([flag], emptyRules,
        profileInstancesForLegacyFlags([flag], "2026-09-01"))).toEqual([]);
    }
  });

  it("preserves this account's saved Avoid and neutral marks when setup is reopened", () => {
    const foods = [starterFood("whey-protein-powder", "avoid"), starterFood("tofu-firm", "neutral")];
    const marks = initialStarterSelection(["vegetarian"], emptyRules, "I love tofu", [], foods);
    expect(marks["whey-protein-powder"]).toBe("avoid");
    expect(marks["tofu-firm"]).toBe("neutral");
    expect(marks["egg-white"]).toBe("eats");
    expect(initialStarterSelection(["vegan"], emptyRules, "", [],
      [starterFood("egg-white", "eats")])["egg-white"]).not.toBe("eats");
  });

  it("holds starters when an active clinical hard rule cannot be cleared from catalog evidence", () => {
    const instances = [{ profileId: "medical", source: "user_stated" as const,
      confirmedAt: "2026-09-01", options: {}, rules: [{
        id: "medical::high_sodium" as import("@/lib/policy/profiles/types").RuleId,
        profileId: "medical", facet: "high_sodium", strength: "never" as const,
        hardBasis: "user_confirmed_safety" as const, evidenceStrength: "strong" as const,
        confirmation: "confirmed" as const, expiresAt: null,
      }] }];
    expect(starterChoices([], emptyRules, instances)).toEqual([]);
  });

  it("uses explicit nearby words to mark food mentions, with avoid taking precedence", () => {
    const choices = starterChoices([], emptyRules);
    const marks = mentionedFoodChoices("I love tofu, want more apples, avoid egg whites and don't eat peanut butter", choices);
    expect(marks.get("tofu-firm")).toBe("eats");
    expect(marks.get("apple-with-skin")).toBe("eats");
    expect(marks.get("egg-white")).toBe("avoid");
    expect(marks.get("peanut-butter")).toBe("avoid");
    expect(mentionedFoodChoices("I know tofu exists", choices).has("tofu-firm")).toBe(false);
    expect(mentionedFoodChoices("I love tofu no problem", choices).get("tofu-firm")).toBe("eats");
    expect(mentionedFoodChoices("I eat salmon, no complaints", choices)
      .get("salmon-wild-sockeye-cooked")).toBe("eats");
  });

  it("requires two selected foods per role and converts to household portions", () => {
    const choices = starterChoices(["vegan"], emptyRules);
    expect(starterSelectionValid(choices.slice(0, 2).map((item) => item.id), choices)).toBe(false);
    const selected = ["tofu-firm", "tempeh", "white-rice-cooked", "quinoa-cooked", "olive-oil", "avocado"];
    expect(starterSelectionValid(selected, choices)).toBe(true);
    const tofu = starterFood("tofu-firm", "eats");
    expect(tofu.unit).toBe("oz");
    expect(tofu.perUnit.protein).toBeGreaterThan(0);
  });
});
