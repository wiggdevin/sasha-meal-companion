/**
 * Pins lib/coach/profile-synonyms.generated.ts equal to the validated catalog's own id/synonyms
 * pairs (lib/policy/profiles/catalog-summary.ts), so a catalog change that forgets to regenerate
 * the lightweight file fails here rather than silently drifting the coach's detection off the
 * profiles it can actually build a proposal for.
 *
 * Regenerate by writing each profile's `{ id, synonyms }` (skipping any with an empty synonyms
 * list) as a literal into the array in lib/coach/profile-synonyms.generated.ts, straight from
 * docs/research/dietary-profiles.draft.json's own `profiles` array, in the document's own order.
 */
import { describe, expect, it } from "vitest";
import { PROFILE_SYNONYMS } from "@/lib/coach/profile-synonyms.generated";
import { catalogSummaries } from "@/lib/policy/profiles/catalog-summary";

describe("PROFILE_SYNONYMS", () => {
  it("matches the validated catalog's own id/synonyms pairs exactly", () => {
    const fromCatalog = catalogSummaries()
      .filter((profile) => profile.synonyms.length > 0)
      .map((profile) => ({ id: profile.id, synonyms: [...profile.synonyms] }));
    expect(PROFILE_SYNONYMS).toEqual(fromCatalog);
  });

  it("names no id twice", () => {
    const ids = PROFILE_SYNONYMS.map((profile) => profile.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
