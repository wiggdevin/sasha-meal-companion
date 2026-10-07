import { describe, expect, it } from "vitest";
import { mergeEvidence, type StoredAllergenEvidence } from "@/lib/policy/allergens";
import { capLookupEvidence } from "@/lib/policy/lookup-evidence";

describe("capLookupEvidence (Phase 13 §9 R8: grounding never clears a hard rule)", () => {
  it("is always no_evidence, whatever a lookup answer claims", () => {
    expect(capLookupEvidence()).toEqual({ level: "no_evidence", labelComplete: false });
  });

  it("never lifts an existing peanut block when merged with stored evidence", () => {
    const storedPeanutBlock: StoredAllergenEvidence = { level: "listed", labelComplete: true };
    // The model answered "peanut-free" — capLookupEvidence still caps at no_evidence, and
    // merging it with the stored `listed` evidence must leave the block exactly where it was.
    const merged = mergeEvidence(storedPeanutBlock, capLookupEvidence());
    expect(merged).toEqual({ level: "listed", labelComplete: true });
  });

  it("never upgrades a not_listed food to allowed", () => {
    const notListed: StoredAllergenEvidence = { level: "not_listed", labelComplete: true };
    const merged = mergeEvidence(notListed, capLookupEvidence());
    expect(merged?.level).toBe("not_listed");
  });

  it("leaves an unverified food unverified — a lookup answer adds no evidence of its own", () => {
    const merged = mergeEvidence(undefined, capLookupEvidence());
    expect(merged).toEqual({ level: "no_evidence", labelComplete: false });
  });
});
