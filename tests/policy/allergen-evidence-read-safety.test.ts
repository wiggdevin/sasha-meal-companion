/**
 * sol BLOCK (review round 2): `readAllergenEvidence` used to convert a read error into an empty
 * `Map`, documented as safe because a reader could only ever make a verdict MORE cautious on a
 * miss. r3 FIX (this branch) lets a live, complete ingredient list independently derive
 * `not_listed` for a major allergen — so an empty map after a failed read let a genuinely stored
 * `listed` (an earlier label, a legacy tag, Jev) disappear behind a fresh live-only read this call
 * never actually saw, reversing a stored block instead of only ever adding to it. The read must
 * fail the caller instead, the same posture every other policy reader in this codebase already
 * takes on a read error (lib/server/catalog.ts loadUserProfile, tests/coach/attachments.test.ts's
 * "fails the turn when the ... policy read fails").
 */
import { describe, expect, it } from "vitest";
import { readAllergenEvidence } from "@/lib/server/allergen-evidence";
import { scannedAllergenFacts } from "@/lib/server/barcode-policy";
import { EMPTY_PROFILE, type ConstraintProfile } from "@/lib/policy/constraints";

function clientWithFailingEvidenceRead(checksData: unknown[] = []) {
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    const failing = table === "food_allergen_evidence";
    Object.assign(chain, {
      select: () => chain, in: () => chain, eq: () => chain,
      then: (resolve: (v: { data: unknown; error: { message: string } | null }) => unknown) =>
        Promise.resolve(failing
          ? { data: null, error: { message: "read timed out" } }
          : { data: checksData, error: null }).then(resolve),
    });
    return chain;
  };
  return { from } as never;
}

describe("readAllergenEvidence: a read error must not become an empty map", () => {
  it("rejects instead of resolving to a silently-empty map", async () => {
    const client = clientWithFailingEvidenceRead();
    await expect(readAllergenEvidence(client, ["catalog_revision:1"])).rejects.toThrow();
  });
});

describe("scannedAllergenFacts: a failed evidence read must not silently clear a stored block", () => {
  it("fails instead of deriving 'absent' from live text alone (Sol repro: a sesame finding " +
    "changing from present, with stored evidence, to absent when that evidence read fails)",
    async () => {
      const client = clientWithFailingEvidenceRead();
      const profile: ConstraintProfile = { ...EMPTY_PROFILE, avoid_allergens: ["sesame"] };
      // A complete, sesame-free-READING label: if a stored `listed` this call cannot read were
      // silently dropped instead of propagating the read failure, this would otherwise derive a
      // false "No sesame listed on the label".
      const completeLabel = "Water, rice flour, sunflower oil, salt.";
      await expect(scannedAllergenFacts(client, "user-1", profile, 34, completeLabel, []))
        .rejects.toThrow();
    });
});
