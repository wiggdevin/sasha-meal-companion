/**
 * Phase 18 W2c edge review of lib/policy/diet-evidence.ts: the deterministic clearances (whole-food
 * class, a cut's own species word, and a complete label for alcohol only) and the words that only look like a facet.
 * Decisions pinned here:
 *
 * - A cut names its species: "pork chop" is pork (not beef), "chicken breast" is chicken (meat, not
 *   pork or beef), a lamb or venison cut is neither. Bison clears pork but stays open for beef (a
 *   bovine). A cut also sold as pork ("sirloin" alone) never clears pork; the class's own
 *   "sirloin steak" form does.
 * - Pescatarian allows plain fish and shellfish and blocks poultry and red meat.
 * - "Eggplant" is not egg, "coconut" is a plain fruit (no animal product, and no diet flag reads
 *   tree nut), "oyster mushrooms" are not shellfish for a diet rule.
 * - "Beef tomato" never names beef or meat. The whole-food classifier does not know it, so it stays
 *   `unknown` (Not verified) under no-beef or vegetarian rather than cleared: fail-closed.
 * - A complete label never clears an animal facet (animal_product, meat, pork, beef, fish_seafood,
 *   shellfish): W2c re-plan Option A. Those clear only by the whole-food class or a reviewed starter
 *   outcome; "vegetable glycerin" and "shortening (palm)" stay unverified in v1. A label still blocks
 *   what it names (gelatin, carmine, honey). Only alcohol keeps a label clearance. An ingredient
 *   parser (Option B, lib/policy/diet-label.ts) is a separate change with its own review.
 */
import { describe, expect, it } from "vitest";
import { evaluatePolicy, EMPTY_PROFILE, type ConstraintProfile, type PolicyEvidence }
  from "@/lib/policy/constraints";
import { looksLikeCompleteList } from "@/lib/policy/allergens";
import { ruleId } from "@/lib/policy/profiles/types";
import { dietFacetOutcome, type DietEvidence } from "@/lib/policy/diet-evidence";
import type { Facet } from "@/lib/foods/facet-vocabulary";
import type { PolicyPreferenceFlag } from "@/lib/policy/facet-rules";

const named = (facet: Facet, foodName: string, extra: DietEvidence = {}) =>
  dietFacetOutcome(facet, { foodName, ...extra });
const label = (text: string) => ({ ingredientsText: text, ingredientsTextIsLabel: true });

function verdict(foodName: string, flags: PolicyPreferenceFlag[], extra: Partial<PolicyEvidence> = {}) {
  return evaluatePolicy(EMPTY_PROFILE, {
    foodRefId: "f1", allergenTags: [], category: [], onEatsList: true, onAvoidList: false,
    foodName, preferenceFlags: flags, ...extra,
  }).verdict;
}

describe("a cut's species word", () => {
  it.each([
    ["pork chop", "pork", "present"], ["pork chop", "beef", "absent"], ["pork chop", "meat", "present"],
    ["chicken breast", "meat", "present"], ["chicken breast", "pork", "absent"],
    ["chicken breast", "beef", "absent"], ["cornish hen", "meat", "present"],
    ["lamb chops", "pork", "absent"], ["lamb chops", "beef", "absent"],
    ["venison", "pork", "absent"], ["ground bison", "pork", "absent"], ["ground bison", "beef", "unknown"],
    ["sirloin steak", "pork", "absent"], ["sirloin steak", "beef", "present"],
    ["ground beef", "pork", "absent"], ["wild boar", "pork", "present"],
  ] as const)("%s → %s %s", (food, facet, outcome) => {
    expect(named(facet, food)).toBe(outcome);
  });
});

describe("pescatarian", () => {
  it.each(["Salmon", "Shrimp", "Cod, cooked", "Scallops"])("allows plain %s", (food) => {
    expect(verdict(food, ["pescatarian"])).toBe("allowed");
  });
  it.each(["Chicken breast", "Pork chop", "Ground beef", "Turkey", "Bacon"])("blocks %s", (food) => {
    expect(verdict(food, ["pescatarian"])).toBe("blocked");
  });
  it("leaves a prepared fish dish open rather than clearing it", () => {
    expect(verdict("Tuna casserole", ["pescatarian"])).toBe("unverified");
  });
});

describe("words that only look like a facet", () => {
  it("eggplant is not egg and not an animal product", () => {
    expect(named("contains_egg", "eggplant")).not.toBe("present");
    expect(named("animal_product", "eggplant")).not.toBe("present");
    expect(verdict("Eggplant", ["no_eggs"])).not.toBe("blocked");
    expect(verdict("Eggplant", ["vegan"])).not.toBe("blocked");
  });

  it("coconut is a plain fruit: no animal product, and no diet flag reads tree nut", () => {
    expect(named("animal_product", "coconut")).toBe("absent");
    expect(verdict("Coconut", ["vegan"])).toBe("allowed");
    expect(named("animal_product", "coconut milk")).not.toBe("present");
  });

  it("beef tomato never names beef or meat, and stays unknown rather than cleared", () => {
    for (const food of ["beef tomato", "beef tomatoes", "beefsteak tomato"]) {
      expect(named("beef", food)).toBe("unknown");
      expect(named("meat", food)).toBe("unknown");
    }
    expect(verdict("Beef tomato", ["no_beef"])).toBe("unverified");
    // The word still blocks when beef is really there.
    expect(named("beef", "beef and tomato stew")).toBe("present");
  });

  it("oyster mushrooms and crab apples are not seafood for a diet rule; oyster sauce is", () => {
    expect(named("shellfish", "oyster mushrooms")).toBe("unknown");
    expect(named("fish_seafood", "king oyster mushroom")).toBe("unknown");
    expect(named("animal_product", "crab apples")).not.toBe("present");
    expect(named("shellfish", "oyster sauce")).toBe("present");
  });

  it("a mushroom, a bun or a meat-free claim names no meat", () => {
    expect(named("meat", "chicken of the woods")).toBe("unknown");
    expect(named("meat", "hot dog buns")).toBe("unknown");
    expect(named("meat", "meat-free mince")).toBe("unknown");
    expect(named("meat", "hamburger")).toBe("present");
  });

  it("a vinegar is not alcohol by name; wine still is", () => {
    expect(named("alcohol", "sherry vinegar")).not.toBe("present");
    expect(named("alcohol", "red wine vinegar")).not.toBe("present");
    expect(named("alcohol", "red wine")).toBe("present");
  });
});

describe("a complete label never clears an animal facet (W2c re-plan, Option A)", () => {
  const ANIMAL_FACETS = ["animal_product", "meat", "pork", "beef", "fish_seafood", "shellfish"] as const;
  const FLAGS: PolicyPreferenceFlag[] = ["vegan", "vegetarian", "pescatarian", "no_pork", "no_beef"];
  /** Each passes the shared completeness gate, so only Option A stops the clearance. */
  const COMPLETE = [
    "Water, corn starch and oil, salt.", "Salt, oil, water.", "Oil, corn starch, water.",
    "Water, salt, sunflower oil.", "Water, sunflower oil or canola oil, salt.",
    "Rice, sugar, salt.", "Oats, sugar, salt.", "Water, vegetable oil (sunflower), salt.",
    "Water, spices (salt, pepper), rice.", "Rice, sugar, vegetable oil, Contains: soy.",
    "Water, soy lecithin, salt.", "Water, rice, salt.",
  ];
  /** Not complete by the shared lexicon (shortening, glycerin, semicolons): unknown all the more. */
  const OTHER = [
    "Water; corn starch and oil; salt.", "Water, vegetable glycerin, salt.",
    "Water, shortening (palm), salt.", "Water, oil (palm (fractionated)), salt.",
  ];
  const hardRule = { ...EMPTY_PROFILE, profileRules: { asOf: new Date("2026-09-25T00:00:00.000Z"),
    items: [{ id: ruleId("p", "pork"), profileId: "p", facet: "pork", strength: "never",
      hardBasis: "religious", evidenceStrength: null, confirmation: "confirmed", expiresAt: null }] },
  } as ConstraintProfile;

  it("the COMPLETE statements pass the completeness gate, and the hard rule is active", () => {
    for (const text of COMPLETE) expect(looksLikeCompleteList(text, { verbatim: true }), text).toBe(true);
    expect(evaluatePolicy(hardRule, { foodRefId: "f1", allergenTags: [], category: [], onEatsList: true,
      onAvoidList: false, foodName: "Pork chop", profileRules: hardRule.profileRules }).verdict).toBe("blocked");
  });

  it.each([...COMPLETE, ...OTHER])("%s clears no animal facet and no animal rule", (text) => {
    for (const facet of ANIMAL_FACETS) {
      expect(named(facet, "Snack", label(text)), facet).not.toBe("absent");
    }
    for (const flag of FLAGS) expect(verdict("Snack", [flag], label(text)), flag).not.toBe("allowed");
    expect(evaluatePolicy(hardRule, { foodRefId: "f1", allergenTags: [], category: [], onEatsList: true,
      onAvoidList: false, foodName: "Snack", profileRules: hardRule.profileRules, ...label(text) })
      .verdict, "profile rule").not.toBe("allowed");
  });

  it("vegetable glycerin and shortening (palm) stay unverified in v1", () => {
    expect(verdict("Snack", ["vegan"], label("Water, vegetable glycerin, salt."))).toBe("unverified");
    expect(verdict("Snack", ["vegan"], label("Water, shortening (palm), salt."))).toBe("unverified");
    expect(verdict("Snack", ["vegan"], label("Water, corn starch and oil, salt."))).toBe("unverified");
  });

  it("an explicit animal ingredient on a label still blocks", () => {
    expect(named("meat", "x", label("Rice, beef, salt."))).toBe("present");
    expect(named("animal_product", "x", label("Rice, cream, salt."))).toBe("present");
    expect(named("fish_seafood", "x", label("Rice, worcestershire sauce, salt."))).toBe("present");
    expect(named("animal_product", "x", label("Water, gelatin, salt."))).toBe("present");
    expect(named("meat", "x", label("Rice, gelatin, salt."))).toBe("present");
    expect(named("animal_product", "x", { ingredientsText: "Water, carmine, salt." })).toBe("present");
    expect(named("animal_product", "x", { ingredientsText: "Water, cochineal, salt." })).toBe("present");
    expect(verdict("Gummies", ["vegetarian"], label("Sugar, gelatin, water."))).toBe("blocked");
    expect(verdict("Snack", ["vegan"], label("Rice, sugar, honey, salt."))).toBe("blocked");
    expect(named("meat", "fish gelatin")).toBe("unknown");
  });

  it("a plain whole food still clears by its class", () => {
    expect(verdict("Banana", ["vegan"])).toBe("allowed");
    expect(verdict("Salmon", ["pescatarian"])).toBe("allowed");
  });

  it("alcohol alone keeps its label clearance, and still refuses what can hide alcohol", () => {
    expect(named("alcohol", "x", label("Water, oil, salt."))).toBe("absent");
    expect(named("alcohol", "x", label("Water, soy sauce, salt."))).toBe("unknown");
    expect(named("alcohol", "x", label("Water, kefir, salt."))).toBe("unknown");
    expect(named("alcohol", "x", label("Rice, natural flavor, salt."))).toBe("unknown");
    expect(named("alcohol", "x", { ingredientsText: "Water, oil, salt.", ingredientsTextIsLabel: false }))
      .toBe("unknown");
    expect(named("alcohol", "x", label("Water, oil, salt"))).toBe("unknown");
  });

  it("elk is not a clearance species: ground elk stays open for no-pork", () => {
    expect(named("pork", "ground elk")).toBe("unknown");
    expect(verdict("Ground elk", ["no_pork"])).toBe("unverified");
  });
});

describe("a W2a hold is never cleared by a preference flag (W2c r1)", () => {
  const heldShellfish = { allergenEvidence: { shellfish: { level: "listed", source: "jev",
    labelComplete: false, held: true } } } as unknown as Partial<PolicyEvidence>;
  it("verified kosher certification does not clear a held shellfish row", () => {
    expect(verdict("House roll", ["kosher"], { ...heldShellfish, verifiedPreferenceFlags: ["kosher"] }))
      .not.toBe("allowed");
    expect(verdict("House roll", ["kosher"], { verifiedPreferenceFlags: ["kosher"] })).toBe("allowed");
  });
});

describe("the policy reason a diet facet blocks with", () => {
  it("keeps the facet: vocabulary for a non-allergen facet, never allergen:", () => {
    const reason = evaluatePolicy(EMPTY_PROFILE, { foodRefId: "f1", allergenTags: [], category: [],
      onEatsList: true, onAvoidList: false, foodName: "Chicken breast", preferenceFlags: ["vegetarian"] });
    expect(reason).toMatchObject({ verdict: "blocked", reason: "facet:meat" });
  });
});
