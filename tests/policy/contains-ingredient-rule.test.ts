/**
 * W105: a profile hard rule `contains_ingredient:<description>` blocks a food whose own name or
 * ingredient text names one of the description's terms. A miss is never proof of absence, so an
 * unreadable or silent food stays `unverified`; Jev never decides it.
 */
import { describe, expect, it } from "vitest";
import { evaluatePolicy } from "@/lib/policy/constraints";
import { ingredientTerms, profileFacetOutcome } from "@/lib/policy/profiles/hard-rules";
import { ruleId, type RuleItem } from "@/lib/policy/profiles/types";
import { TEST_PROFILE } from "@/tests/helpers/constraint-profile";

const AS_OF = new Date("2026-10-17T12:00:00Z");
const NO_ALLERGENS = { ...TEST_PROFILE, allergens: [] };

function never(facet: string): RuleItem {
  return { id: ruleId("user_rule", facet), profileId: "user_rule", facet, strength: "never",
    hardBasis: "user_rule", evidenceStrength: "strong", confirmation: "confirmed", expiresAt: null };
}

function verdict(facet: string, evidence: { foodName?: string; ingredientsText?: string | null;
  facets?: Record<string, { p: number; rubricVersion: number; judgedAt: string }> }) {
  return evaluatePolicy(NO_ALLERGENS, {
    foodRefId: null, allergenTags: [], category: [], onEatsList: true, onAvoidList: false,
    profileRules: { items: [never(facet)], asOf: AS_OF }, ...evidence,
  }).verdict;
}

describe("ingredientTerms reads the map's prose descriptions", () => {
  it.each([
    ["mushroom", ["mushroom"]],
    ["legume (beans, lentils, chickpeas, peas)", ["legume", "beans", "lentils", "chickpeas", "peas"]],
    ["wine, beer, spirits, liqueur or cooking wine (including cooked-off)",
      ["wine", "beer", "spirits", "liqueur", "cooking wine"]],
    ["dairy other than ghee/clarified butter", ["dairy"]],
    ["any added sugar or syrup", ["sugar", "syrup"]],
    ["animal rennet", ["animal rennet"]],
  ])("%s", (description, terms) => {
    expect(ingredientTerms(description)).toEqual(terms);
  });
});

describe("a declared ingredient blocks a food that names it", () => {
  it("blocks on the ingredient text and on the food's own name, singular or plural", () => {
    expect(verdict("contains_ingredient:mushroom", { foodName: "Risotto",
      ingredientsText: "Rice, mushrooms, salt." })).toBe("blocked");
    expect(verdict("contains_ingredient:legume (beans, lentils, chickpeas, peas)",
      { foodName: "Chickpea curry" })).toBe("blocked");
    expect(verdict("contains_ingredient:vinegar", { foodName: "Pickles",
      ingredientsText: "Cucumbers, distilled vinegar, salt." })).toBe("blocked");
  });

  it("matches whole words only", () => {
    expect(profileFacetOutcome("contains_ingredient:oat", { foodName: "Goat cheese" })).toBe("unknown");
    expect(profileFacetOutcome("contains_ingredient:pea", { foodName: "Peanut butter" })).toBe("unknown");
  });

  it("an exception clause is not a term: ghee is not blocked as dairy by its own wording", () => {
    expect(profileFacetOutcome("contains_ingredient:dairy other than ghee/clarified butter",
      { foodName: "Ghee" })).toBe("unknown");
  });

  it("a food that does not name it, or cannot be read, is unverified, never allowed", () => {
    expect(verdict("contains_ingredient:mushroom", { foodName: "Rice",
      ingredientsText: "Rice, water, salt." })).toBe("unverified");
    expect(verdict("contains_ingredient:mushroom", { foodName: "Mystery bar", ingredientsText: null }))
      .toBe("unverified");
    expect(verdict("contains_ingredient:mushroom", { foodName: "Banana" })).toBe("unverified");
  });

  it("a Jev facet never decides it, either way", () => {
    const jev = (p: number) => ({ "contains_ingredient:mushroom": { p, rubricVersion: 1, judgedAt: "" } });
    expect(verdict("contains_ingredient:mushroom", { foodName: "Soup", facets: jev(0.99) }))
      .toBe("unverified");
    expect(verdict("contains_ingredient:mushroom", { foodName: "Soup", facets: jev(0.01) }))
      .toBe("unverified");
  });
});
