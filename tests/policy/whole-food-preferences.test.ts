/**
 * Live smoke, 2026-10-02: logging a banana for an account with a no-pork preference read "Not
 * verified: banana (your no-pork preference)". A plain whole food's class rules out the animal
 * facets it cannot contain, so plant foods, eggs, dairy and plain poultry or fish resolve the
 * preference instead of waiting on a Jev judgment. Phase 18 W2c: a Jev judgment no longer decides
 * either way; a plain cut's own species word settles pork and beef.
 */
import { describe, expect, it } from "vitest";
import { evaluatePolicy, loadProfile } from "@/lib/policy/constraints";

const profile = loadProfile({});
const verdict = (foodName: string, flags: string[], facets = {}) => evaluatePolicy(profile, {
  foodRefId: null, allergenTags: null, category: null, onEatsList: true, onAvoidList: false,
  foodName, preferenceFlags: flags as never, facets,
}).verdict;

describe("whole-food classes and diet preferences", () => {
  it("clears plain plant foods for no-pork, vegetarian and vegan", () => {
    for (const food of ["Banana, raw", "Jasmine rice, cooked", "Broccoli, steamed", "Almonds"]) {
      for (const flag of ["no_pork", "vegetarian", "vegan"]) expect(verdict(food, [flag]), `${food} ${flag}`).toBe("allowed");
    }
  });

  it("clears plain poultry and fish for no-pork and no-beef but not for vegetarian", () => {
    expect(verdict("Chicken breast, cooked", ["no_pork"])).toBe("allowed");
    expect(verdict("Ahi tuna, cooked", ["no_beef"])).toBe("allowed");
    expect(verdict("Chicken breast, cooked", ["vegetarian"])).not.toBe("allowed");
  });

  it("leaves prepared foods unresolved; a plain cut's species settles pork and beef (W2c)", () => {
    expect(verdict("Baked beans", ["no_pork"])).toBe("unverified");
    expect(verdict("Sirloin steak, cooked", ["no_pork"])).toBe("allowed");
    expect(verdict("Pork chop", ["no_beef"])).toBe("allowed");
    expect(verdict("Pork chop", ["no_pork"])).toBe("blocked");
    expect(verdict("Ground bison", ["no_beef"])).toBe("unverified");
  });

  it("W2c: a Jev 'present' no longer overrides the class (the 2026-10-02 banana case)", () => {
    expect(verdict("Banana, raw", ["no_pork"], { pork: { p: 0.99, rubricVersion: 1, judgedAt: "2026-09-20T00:00:00Z" } }))
      .toBe("allowed");
  });
});
