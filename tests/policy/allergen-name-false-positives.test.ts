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
import { describe, expect, it, vi } from "vitest";
import { offPlanFlags } from "@/lib/catalog-client";
import { searchFoods as searchLocalFoods } from "@/lib/food-db";
import type { Food } from "@/lib/foods";
import { deriveItem } from "@/lib/foods/universe/derive";
import { universeEntry } from "@/lib/foods/universe/manifest";
import { allergenFinding, deriveEvidence, textNames } from "@/lib/policy/allergens";
import { EMPTY_PROFILE, evaluatePolicy, type ConstraintProfile } from "@/lib/policy/constraints";
import { recordAllergenEvidence } from "@/lib/server/allergen-evidence";

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

  it("keeps the off-plan dairy marker when an excluded phrase sits beside real dairy", () => {
    // Sol review (WARN): the exclusion list used to veto the whole name, so a seed or nut butter
    // hid the whey or milk next to it. Each excluded phrase is now removed and the rest is read.
    expect(offPlanFlags("Sesame butter, whey, salt")).toContain("dairy");
    expect(offPlanFlags("Peanut butter with milk chocolate")).toContain("dairy");
    expect(offPlanFlags("Oat milk latte, with whipped cream")).toContain("dairy");
    expect(offPlanFlags("Oat milk latte")).not.toContain("dairy");
    expect(offPlanFlags("Almond milk, unsweetened")).not.toContain("dairy");
    expect(offPlanFlags("Butternut squash soup")).not.toContain("dairy");
    const mine: Record<string, Food> = { sbw: { id: "sbw", name: "Sesame butter, whey", role: "fat",
      unit: "g", perUnit: { protein: 0.2, carbs: 0.1, fat: 0.5 }, status: "eats",
      updatedAt: "2026-10-10T00:00:00.000Z" } };
    expect(searchLocalFoods("sesame butter whey", mine).find((hit) => hit.id === "sbw")?.flags)
      .toContain("dairy");
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

  it("keeps a branded or custom name that only starts like the SR head", () => {
    // Sol review (WARN): only SR's coconut products (meat, milk, cream, water) lose the head.
    for (const name of ["Nuts, coconut, raisins", "Nuts, coconut and cashew mix", "nuts, coconut bites"]) {
      expect(byName("tree-nut", name)).toBe("listed");
    }
    // A complete label that does not name tree nuts never clears a name that does.
    expect(deriveEvidence("tree-nut", { ingredientsText: "Coconut, raisins, sugar.",
      labelComplete: true, foodName: "Nuts, coconut, raisins" }).level).toBe("listed");
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

/**
 * Sol review (WARN): the fix changes derivation only. A revision already warmed under the old
 * scan keeps its stored deterministic `listed`: `recordAllergenEvidence` merges upward only and
 * migration 20261212090000 refuses a lower rank on update. So such a row still blocks (the
 * cautious side) until an owner corrects it through a reviewed step; this PR adds no tool that
 * lowers stored evidence. These tests pin that behavior so the docs claim stays true.
 */
describe("stored name-derived listings from before the fix", () => {
  function writerWithStored(stored: Record<string, unknown>[]) {
    const written: Record<string, unknown>[] = [];
    const upsert = vi.fn(async (rows: Record<string, unknown>[]) => {
      written.push(...rows);
      return { error: null };
    });
    const from = () => {
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain, in: () => chain, order: () => chain, range: () => chain, upsert,
        then: (resolve: (v: { data: unknown; error: null }) => unknown) =>
          Promise.resolve({ data: stored, error: null }).then(resolve),
      });
      return chain;
    };
    return { client: { from } as never, written };
  }

  it("a re-warm keeps the stored dairy listing on tahini and the tree-nut listing on coconut milk", async () => {
    const { client, written } = writerWithStored([
      { food_key: "catalog_revision:1", allergen: "dairy", level: "listed", label_complete: false,
        source: "ingredients" },
      { food_key: "catalog_revision:2", allergen: "tree-nut", level: "listed", label_complete: false,
        source: "ingredients" },
    ]);
    await recordAllergenEvidence(client, [
      { foodKey: "catalog_revision:1", userId: null, ingredientsText: null, labelComplete: false,
        foodName: TAHINI_SR },
      { foodKey: "catalog_revision:2", userId: null, ingredientsText: null, labelComplete: false,
        foodName: COCONUT_MILK_SR },
    ]);
    const row = (key: string, allergen: string) =>
      written.find((r) => r.food_key === key && r.allergen === allergen);
    expect(row("catalog_revision:1", "dairy")).toMatchObject({ level: "listed" });
    expect(row("catalog_revision:2", "tree-nut")).toMatchObject({ level: "listed" });
  });

  it("a reader still blocks on the stored listing", () => {
    expect(allergenFinding("dairy", { foodName: TAHINI_SR,
      stored: { level: "listed", labelComplete: false } })).toMatchObject({ outcome: "present" });
    expect(allergenFinding("tree-nut", { foodName: COCONUT_MILK_SR,
      stored: { level: "listed", labelComplete: false } })).toMatchObject({ outcome: "present" });
  });
});
