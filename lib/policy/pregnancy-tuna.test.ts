/**
 * Phase 13 §9 R1: "Unspecified tuna is unverified for the pregnancy profile." Pure, and narrow on
 * purpose — see lib/policy/pregnancy-tuna.ts for why this is not lib/policy/condition-rules.ts.
 */
import { describe, expect, it } from "vitest";
import { isPregnant, namesUnspecifiedTuna, pregnancyTunaFinding } from "@/lib/policy/pregnancy-tuna";

describe("isPregnant", () => {
  it("reads a free-text condition naming pregnancy, case-insensitively", () => {
    expect(isPregnant(["pregnant"])).toBe(true);
    expect(isPregnant(["Pregnancy"])).toBe(true);
    expect(isPregnant(["32 weeks pregnant"])).toBe(true);
  });

  it("is false for no conditions, unrelated conditions, or a word that only contains the stem", () => {
    expect(isPregnant(undefined)).toBe(false);
    expect(isPregnant([])).toBe(false);
    expect(isPregnant(["celiac", "IBS"])).toBe(false);
  });

  it("sol finding (FIX): also reads the free-text condition 'expecting' — conditions is a free-" +
    "text field (constraint_profiles.conditions), and a real account typing it that way must not " +
    "leave unspecified tuna unverified by neither the pregnancy rule nor an allergen rule", () => {
    expect(isPregnant(["expecting"])).toBe(true);
    expect(isPregnant(["Expecting our first baby"])).toBe(true);
  });
});

describe("namesUnspecifiedTuna", () => {
  it("is true for plain tuna with no species word", () => {
    expect(namesUnspecifiedTuna("Tuna, water, salt")).toBe(true);
    expect(namesUnspecifiedTuna("Canned tuna fish")).toBe(true);
    expect(namesUnspecifiedTuna(null, ["tuna"])).toBe(true);
  });

  it("is false once a species word disambiguates the mercury level either way", () => {
    expect(namesUnspecifiedTuna("Skipjack tuna, water, salt")).toBe(false);
    expect(namesUnspecifiedTuna("Chunk light tuna in water")).toBe(false);
    expect(namesUnspecifiedTuna("Albacore tuna, soybean oil")).toBe(false);
    expect(namesUnspecifiedTuna("White tuna in oil")).toBe(false);
  });

  it("is false when the text or tags never name tuna at all", () => {
    expect(namesUnspecifiedTuna("Water, rice flour, salt")).toBe(false);
    expect(namesUnspecifiedTuna(null, ["salmon"])).toBe(false);
    expect(namesUnspecifiedTuna(null)).toBe(false);
  });

  it("does not false-match a longer word that merely contains tuna", () => {
    expect(namesUnspecifiedTuna("Fortuna brand crackers")).toBe(false);
  });

  describe("ORCHESTRATOR fix (round 7): species words match on word boundaries", () => {
    it("'ahi' specifies the species and clears the unspecified-tuna check", () => {
      expect(namesUnspecifiedTuna("Ahi tuna, soy sauce")).toBe(false);
    });

    it("'ahi' inside 'mahi' does not count as the species word: mahi-mahi is not tuna, and " +
      "this text names no species of tuna at all", () => {
      expect(namesUnspecifiedTuna("Tuna and mahi mahi")).toBe(true);
    });
  });

  describe("sol BLOCK (review round 2): a species word must specify the TUNA, not just appear " +
    "anywhere in the text", () => {
    it("'yellowfin sole' names a different fish's species, not tuna's — the tuna in the same " +
      "text is still unspecified", () => {
      expect(namesUnspecifiedTuna("Tuna and yellowfin sole")).toBe(true);
    });

    it("still clears once the species word actually sits beside the tuna mention", () => {
      expect(namesUnspecifiedTuna("Yellowfin tuna, water, salt")).toBe(false);
    });
  });

  describe("finding #8: the food's own name, not just its ingredient text or tags", () => {
    it("is true for a product NAMED tuna even when the ingredient text never says so (the brine, " +
      "not the fish, e.g. \"Water, salt\")", () => {
      expect(namesUnspecifiedTuna("Water, salt", [], "Canned tuna")).toBe(true);
      expect(namesUnspecifiedTuna(null, null, "Tuna")).toBe(true);
    });

    it("is false once the NAME itself specifies the species", () => {
      expect(namesUnspecifiedTuna("Water, salt", [], "Albacore tuna")).toBe(false);
      expect(namesUnspecifiedTuna("Water, salt", [], "Wild-caught skipjack tuna")).toBe(false);
    });

    it("does not false-match a name that merely contains the word", () => {
      expect(namesUnspecifiedTuna(null, null, "Fortuna crackers")).toBe(false);
    });
  });

  describe("BLOCK (review round 1): a species word must sit beside the SAME field's own tuna " +
    "mention, not merely end up adjacent once ingredientsText and foodName are concatenated", () => {
    it("an ordinary ingredient ending in a species word ('egg white') does not specify a " +
      "TUNA CASSEROLE's species just because the name starts with 'Tuna'", () => {
      expect(namesUnspecifiedTuna(
        "Water, mayonnaise, celery, onion, spices, egg white", [], "Tuna Casserole",
      )).toBe(true);
    });

    it("still clears when the species word and 'tuna' are genuinely adjacent within the SAME " +
      "field", () => {
      expect(namesUnspecifiedTuna("White tuna, water, salt", [], "Canned fish")).toBe(false);
      expect(namesUnspecifiedTuna("Water, salt", [], "White tuna")).toBe(false);
    });
  });
});

describe("pregnancyTunaFinding", () => {
  it("is unverified, never blocking, only when both pregnant and tuna is unspecified", () => {
    const finding = pregnancyTunaFinding({
      conditions: ["pregnant"], ingredientsText: "Tuna, water, salt", tags: null,
    });
    expect(finding).toMatchObject({ allergen: "tuna_mercury", outcome: "unknown", checkable: false });
    expect(finding?.text).not.toMatch(/safe/i);
  });

  it("is null when not pregnant, even for unspecified tuna", () => {
    expect(pregnancyTunaFinding({
      conditions: [], ingredientsText: "Tuna, water, salt", tags: null,
    })).toBeNull();
  });

  it("is null when pregnant but the species is specified", () => {
    expect(pregnancyTunaFinding({
      conditions: ["pregnant"], ingredientsText: "Skipjack tuna, water, salt", tags: null,
    })).toBeNull();
  });

  it("is null when pregnant but the food names no tuna", () => {
    expect(pregnancyTunaFinding({
      conditions: ["pregnant"], ingredientsText: "Chicken, rice, salt", tags: null,
    })).toBeNull();
  });

  it("finding #8: catches a product NAMED \"Canned tuna\" whose ingredients say only " +
    "\"Water, salt\" and whose tags never name tuna", () => {
    const finding = pregnancyTunaFinding({
      conditions: ["pregnant"], ingredientsText: "Water, salt", tags: [], foodName: "Canned tuna",
    });
    expect(finding).toMatchObject({ allergen: "tuna_mercury", outcome: "unknown" });
  });

  it("is null when the name specifies the species even if the text and tags say nothing", () => {
    expect(pregnancyTunaFinding({
      conditions: ["pregnant"], ingredientsText: "Water, salt", tags: [], foodName: "Albacore tuna",
    })).toBeNull();
  });
});
