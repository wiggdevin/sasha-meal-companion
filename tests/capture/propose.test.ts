import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { deterministicSanity } from "@/lib/log/sanity";
import { allergenTagsFromIngredients, buildDraft } from "@/lib/capture/propose";

const ITEM = { label: "Egg", grams: 100, qty: 2, unit: "whole", confidence: 0.8 };
const GROUNDED = { foodRefId: "ref-1", catalogFoodRevisionId: 70, grams: 100, portionId: 5,
  alternatives: [], autoResolved: true };
const CTX = { draftId: "d1", method: "text" as const, spend: { usedToday: 3, softCap: 30 } };

describe("buildDraft", () => {
  it("numbers items from 0 and carries grounding, policy and confidence", () => {
    const out = buildDraft({ items: [ITEM], notes: [] }, [GROUNDED], [{ verdict: "allowed" }],
      CTX, deterministicSanity);
    expect(out.draftId).toBe("d1");
    expect(out.method).toBe("text");
    expect(out.spend).toEqual({ usedToday: 3, softCap: 30 });
    expect(out.items).toEqual([{
      seq: 0, label: "Egg", foodRefId: "ref-1", catalogFoodRevisionId: 70, grams: 100,
      qty: 2, unit: "whole", portionId: 5, confidence: 0.8,
      policy: { verdict: "allowed" }, alternatives: [], autoResolved: true,
      sanity: { status: "pending", warnings: [] },
    }]);
  });

  it("keeps a blocked item in the draft, flagged", () => {
    const out = buildDraft({ items: [ITEM], notes: [] }, [GROUNDED],
      [{ verdict: "blocked", reason: "allergen:dairy" }], CTX, deterministicSanity);
    expect(out.items).toHaveLength(1);
    expect(out.items[0].policy).toEqual({ verdict: "blocked", reason: "allergen:dairy" });
  });

  it("keeps an ungrounded item with its alternatives and no revision", () => {
    const grounded = { ...GROUNDED, foodRefId: null, catalogFoodRevisionId: null, autoResolved: false,
      alternatives: [{ foodRefId: "ref-2", label: "Egg, raw", score: 0.7 }] };
    const out = buildDraft({ items: [ITEM], notes: [] }, [grounded], [{ verdict: "unverified" }],
      CTX, deterministicSanity);
    expect(out.items[0].foodRefId).toBeNull();
    expect(out.items[0].alternatives).toHaveLength(1);
  });

  it("clamps a model confidence outside 0..1 and merges the context notes", () => {
    const out = buildDraft({ items: [{ ...ITEM, confidence: 1.6 }], notes: ["amount unclear"] },
      [GROUNDED], [{ verdict: "allowed" }], { ...CTX, notes: ["you are near today's limit"] },
      deterministicSanity);
    expect(out.items[0].confidence).toBe(1);
    expect(out.notes).toEqual(["amount unclear", "you are near today's limit"]);
  });

  it("attaches labelFood only when the context carries one", () => {
    expect(buildDraft({ items: [], notes: [] }, [], [], CTX, deterministicSanity).labelFood)
      .toBeUndefined();
  });
});

describe("allergenTagsFromIngredients", () => {
  it("returns null when there is no ingredients text", () => {
    expect(allergenTagsFromIngredients(undefined)).toBeNull();
    expect(allergenTagsFromIngredients(null)).toBeNull();
    expect(allergenTagsFromIngredients("")).toBeNull();
  });

  it("returns an empty list when nothing matches", () => {
    expect(allergenTagsFromIngredients("pear, water, citric acid")).toEqual([]);
  });

  it("finds gluten, dairy and apple, in that tag order", () => {
    expect(allergenTagsFromIngredients("apples, milk solids, wheat flour"))
      .toEqual(["gluten", "dairy", "apple"]);
  });

  it("finds dairy named as sodium caseinate or butterfat", () => {
    expect(allergenTagsFromIngredients("natural flavor, sodium caseinate")).toEqual(["dairy"]);
    expect(allergenTagsFromIngredients("butterfat solids")).toEqual(["dairy"]);
  });
});
