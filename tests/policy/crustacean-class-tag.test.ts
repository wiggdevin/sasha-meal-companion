/**
 * W014 (audit 2026-10-10 A026): an Open Food Facts `en:crustaceans` declaration is crustacean
 * evidence. It reaches policy as the bare tag "crustaceans", whose alias is the broader combined
 * `shellfish` key, so the crustacean-only key never saw it and a complete label cleared the ninth
 * FALCPA major allergen against the product's own declaration.
 */
import { describe, expect, it } from "vitest";
import { allergenFinding, deriveEvidence } from "@/lib/policy/allergens";

const COMPLETE = "Water, rice flour, salt.";

describe("crustacean evidence from a declared class tag", () => {
  it("lists crustacean for an en:crustaceans tag on a complete label", () => {
    for (const tag of ["crustaceans", "en:crustaceans", "Crustacean", "shellfish"]) {
      expect(deriveEvidence("crustacean", { ingredientsText: COMPLETE, labelComplete: true, tags: [tag] }),
        tag).toEqual({ level: "listed", labelComplete: true });
    }
  });

  it("blocks an account that avoids only crustacean shellfish", () => {
    expect(allergenFinding("crustacean shellfish", { tags: ["crustaceans"], ingredientsText: COMPLETE }))
      .toMatchObject({ outcome: "present", text: "Contains crustacean shellfish" });
  });

  it("reads the word itself in ingredient text, for both keys", () => {
    const text = "Water, crustaceans, salt.";
    expect(deriveEvidence("crustacean", { ingredientsText: text, labelComplete: true }))
      .toMatchObject({ level: "listed" });
    expect(deriveEvidence("shellfish", { ingredientsText: text, labelComplete: true }))
      .toMatchObject({ level: "listed" });
  });

  it("never lists crustacean from a molluscs tag", () => {
    expect(deriveEvidence("crustacean", { ingredientsText: COMPLETE, labelComplete: true,
      tags: ["molluscs"] })).toEqual({ level: "not_listed", labelComplete: true });
  });
});
