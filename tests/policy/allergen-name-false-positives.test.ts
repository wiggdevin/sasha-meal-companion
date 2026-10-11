/**
 * W022 (B197, docs/catalog/universe.md "Known fail-closed listings"): two names the allergen
 * keyword scan read as a listing they are not.
 *
 *   - Tahini's USDA row is "Seeds, sesame butter, tahini, ...". "Sesame butter" is a seed butter,
 *     the same as the "seed butter" and "peanut butter" exclusions already cover, but the bare
 *     keyword "butter" escalated it to `listed` for dairy.
 *   - Canned coconut milk's USDA row is "Nuts, coconut milk, canned ...". "Nuts," is the survey's
 *     food-group head, not an ingredient; "coconut" itself is already excluded from tree nut, yet
 *     the head escalated it to `listed`.
 *
 * Neither fix clears anything: with no other evidence the food reads `unknown` ("Check the label"),
 * so an account that avoids the allergen still never gets it as `allowed`, and coconut keeps the
 * repo's fail-closed tree-nut stance (lib/policy/whole-food-classes.ts). Every real listing next to
 * these words still escalates.
 */
import { describe, expect, it } from "vitest";
import { offPlanFlags } from "@/lib/catalog-client";
import { deriveItem } from "@/lib/foods/universe/derive";
import { universeEntry } from "@/lib/foods/universe/manifest";
import { allergenFinding, deriveEvidence, textNames } from "@/lib/policy/allergens";
import { EMPTY_PROFILE, evaluatePolicy, type ConstraintProfile } from "@/lib/policy/constraints";

const TAHINI_SR = "Seeds, sesame butter, tahini, from roasted and toasted kernels (most common type)";
const COCONUT_MILK_SR = "Nuts, coconut milk, canned (liquid expressed from grated meat and water)";

const byName = (key: string, foodName: string) =>
  deriveEvidence(key, { ingredientsText: null, labelComplete: false, foodName }).level;

function item(id: string) {
  const entry = universeEntry(id);
  if (!entry) throw new Error(`no universe entry ${id}`);
  const derived = deriveItem(entry);
  if (!derived) throw new Error(`no bundled row for ${id}`);
  return derived;
}

const avoiding = (key: string): ConstraintProfile => ({ ...EMPTY_PROFILE, avoid_allergens: [key] });

describe("tahini is not a dairy listing", () => {
  it("does not escalate dairy from the name 'sesame butter'", () => {
    expect(byName("dairy", TAHINI_SR)).toBe("no_evidence");
    expect(textNames("dairy", "sesame butter")).toBe(false);
  });

  it("still lists sesame, and still lists dairy for real butter beside it", () => {
    expect(byName("sesame", TAHINI_SR)).toBe("listed");
    expect(textNames("dairy", "sesame seeds, butter, salt")).toBe(true);
    expect(textNames("dairy", "sesame butter, whey, salt")).toBe(true);
  });

  it("reads unknown for dairy in the universe, never allowed for a dairy-avoiding account", () => {
    expect(item("tahini").allergens.dairy).toBe("unknown");
    expect(item("tahini").allergens.sesame).toBe("listed");
    expect(allergenFinding("dairy", { foodName: TAHINI_SR }))
      .toMatchObject({ outcome: "unknown", checkable: true });
    expect(evaluatePolicy(avoiding("dairy"), {
      foodRefId: null, allergenTags: null, category: [], onEatsList: false, onAvoidList: false,
      foodName: TAHINI_SR,
    }).verdict).toBe("unverified");
  });

  it("carries no dairy off-plan marker on a catalog search row", () => {
    expect(offPlanFlags(TAHINI_SR)).not.toContain("dairy");
    expect(offPlanFlags("Butter, salted")).toContain("dairy");
  });
});

describe("coconut milk is not a tree-nut listing", () => {
  it("does not escalate tree nut from the USDA 'Nuts,' head before coconut", () => {
    expect(byName("tree-nut", COCONUT_MILK_SR)).toBe("no_evidence");
    expect(byName("tree-nut", "Nuts, coconut meat, raw")).toBe("no_evidence");
    expect(byName("tree-nut", "nuts, coconut cream, canned")).toBe("no_evidence");
  });

  it("still lists every real tree nut, including under the same head", () => {
    expect(byName("tree-nut", "Nuts, almonds")).toBe("listed");
    expect(byName("tree-nut", "Nuts, mixed nuts, dry roasted, with peanuts")).toBe("listed");
    expect(byName("tree-nut", "Nuts, chestnuts, european, roasted")).toBe("listed");
    expect(byName("tree-nut", "Coconut milk with cashews")).toBe("listed");
    expect(byName("tree-nut", "Trail mix, nuts, coconut, raisins")).toBe("listed");
  });

  it("never drops a 'nuts' listing from ingredient text", () => {
    for (const text of ["Nuts, coconut, raisins", "Contains: milk, tree nuts, coconut"]) {
      expect(deriveEvidence("tree-nut", { ingredientsText: text, labelComplete: true }).level)
        .toBe("listed");
    }
  });

  it("reads unknown for tree nut in the universe, never clear and never allowed", () => {
    expect(item("coconut-milk-canned").allergens["tree-nut"]).toBe("unknown");
    expect(allergenFinding("tree-nut", { foodName: COCONUT_MILK_SR }))
      .toMatchObject({ outcome: "unknown", checkable: true });
    expect(evaluatePolicy(avoiding("tree-nut"), {
      foodRefId: null, allergenTags: null, category: [], onEatsList: false, onAvoidList: false,
      foodName: COCONUT_MILK_SR,
    }).verdict).toBe("unverified");
  });

  it("keeps plain coconut on its fail-closed tree-nut mark", () => {
    expect(allergenFinding("tree-nut", { foodName: "Coconut" })).toMatchObject({ outcome: "unknown" });
  });
});
