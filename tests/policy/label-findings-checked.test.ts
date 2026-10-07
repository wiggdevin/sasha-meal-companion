/**
 * sol FIX (review round 1, finding #7): `labelFoodOf`'s capture card called `labelFindings` with
 * the revision's own stored evidence but never the user's `checkedAllergens` — the same "I checked
 * the label" mark the item's own verdict already merges in (groundItem's `evaluatePolicy` call
 * gets `checkedAllergens: checked`). A prior product check could make the item's own verdict
 * `allowed` while the label card right beside it still said "Check the label for X".
 */
import { describe, expect, it } from "vitest";
import { labelFindings } from "@/lib/policy/allergens";

describe("labelFindings: a prior label check must reach the card, not only the verdict", () => {
  it("without a check, an allergen absent from a complete list still reads as unverified (no " +
    "evidence at all, since the text says nothing) or unknown when the list is not complete", () => {
    const findings = labelFindings(["peanut"], "Oats, honey, raisins.");
    expect(findings).toMatchObject([{ allergen: "peanut", outcome: "unknown" }]);
  });

  it("once the user has checked this exact label, the card reads absent with the checked text, " +
    "not another 'check the label' prompt — the same signal the item's own verdict already reads",
    async () => {
      const findings = labelFindings(["peanut"], "Oats, honey, raisins.", undefined, ["peanut"]);
      expect(findings).toMatchObject([{ allergen: "peanut", outcome: "absent",
        text: "You checked this label for peanut" }]);
    });

  it("a check for a DIFFERENT allergen never clears this one", () => {
    const findings = labelFindings(["peanut"], "Oats, honey, raisins.", undefined, ["dairy"]);
    expect(findings).toMatchObject([{ allergen: "peanut", outcome: "unknown" }]);
  });

  it("a listed allergen still shows present even when the user has checked it — a check can only " +
    "ever clear a finding, never override one the label (or stored evidence) actually names", () => {
    const findings = labelFindings(["peanut"], "Peanuts, honey.", undefined, ["peanut"]);
    expect(findings).toMatchObject([{ allergen: "peanut", outcome: "present" }]);
  });
});
