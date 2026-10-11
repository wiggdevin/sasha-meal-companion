/**
 * Phase 18 W2a (docs/specs/phase-18-open-world-foods.md §10 W2a, D4, D9, §8): Jev comes off the
 * allergy path, and the removal fails closed.
 *
 * A food that only Jev flagged is never `allowed`: with a stored Jev row it is a HOLD
 * (unverified, "Not verified"), and with only a cached facet it is unverified for lack of
 * evidence. Complete deterministic evidence of absence still allows. A Jev row that is really a
 * name match stays blocked. Admission (D4 step 2) takes only `allowed`, so "never allowed" is
 * "never admitted".
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { logCommitPolicyIssues, RULES_UNREADABLE_MESSAGE } from "@/lib/coach/log-policy";
import type { CatalogRecipe, RecipeIngredient } from "@/lib/recipe-catalog/types";
import { recipeEligibility } from "@/lib/recipes/eligibility";
import { suggestionFoodIdentity } from "@/lib/coach/suggest-policy";
import type { FoodFacetJudgments } from "@/lib/foods/facets";
import {
  allergenFinding, mergeEvidence, type StoredAllergenEvidence,
} from "@/lib/policy/allergens";
import { HELD_ALLERGEN_TEXT, isDeterministicListed, storedEvidenceFromRow } from "@/lib/policy/allergen-holds";
import { EMPTY_PROFILE, evaluatePolicy, type PolicyEvidence } from "@/lib/policy/constraints";
import { recordAllergenEvidence } from "@/lib/server/allergen-evidence";
import type { EvidenceRow } from "@/scripts/allergen-evidence-repair";

vi.mock("@/lib/server/admin", () => ({ adminClient: () => { throw new Error("no client in tests"); } }));
const { heldCountsByAllergen, planRederive, reviewReplacement, assertHoldsWriteTarget } =
  await import("@/scripts/allergen-jev-holds");

const DAIRY = { ...EMPTY_PROFILE, avoid_allergens: ["dairy"] };
const COMPLETE_NO_DAIRY = "Water, rice flour, sunflower oil, salt.";
const facet = (p: number): FoodFacetJudgments =>
  ({ contains_dairy: { p, rubricVersion: 1, judgedAt: "2026-10-05T00:00:00Z" } });
/** The stored row exactly as lib/server/allergen-evidence.ts reads it. */
const JEV_ROW: StoredAllergenEvidence = storedEvidenceFromRow({
  level: "listed", labelComplete: false, source: "jev" });

function evidence(partial: Partial<PolicyEvidence>): PolicyEvidence {
  return { foodRefId: null, allergenTags: null, category: [], onEatsList: false, onAvoidList: false,
    ...partial };
}

/** Fixture A: only a Jev facet, no tag, no text, no complete label, a non-whole-food name. */
const fixtureA = (p: number) => evidence({ foodName: "Mystery snack mix", facets: facet(p) });
/** Fixture A2: a stored Jev row, plus a complete label that does not list dairy. */
const fixtureA2 = (p: number, extra: Partial<PolicyEvidence> = {}) => evidence({
  foodName: "Mystery snack mix", facets: facet(p), allergenEvidence: { dairy: JEV_ROW },
  ingredientsText: COMPLETE_NO_DAIRY, ...extra });

describe("Fixture A: a food whose only dairy evidence is a Jev facet", () => {
  it("is unverified, never allowed (before W2a it was blocked; neither admits it)", () => {
    const verdict = evaluatePolicy(DAIRY, fixtureA(0.99));
    expect(verdict.verdict).toBe("unverified");
    expect(verdict.allergens).toEqual([expect.objectContaining({ allergen: "dairy", outcome: "unknown" })]);
  });
});

describe("Fixture A2: a stored source='jev' row beside a complete label that omits dairy", () => {
  it("stays unverified with the hold's text; the complete label does not lift it", () => {
    const verdict = evaluatePolicy(DAIRY, fixtureA2(0.99));
    expect(verdict.verdict).toBe("unverified");
    expect(verdict.allergens).toEqual([{ allergen: "dairy", outcome: "unknown",
      text: HELD_ALLERGEN_TEXT, checkable: false }]);
  });

  it("the whole-food class does not lift it", () => {
    // Without the hold, plain chicken clears dairy by class (control).
    expect(evaluatePolicy(DAIRY, evidence({ foodName: "Chicken breast" })).verdict).toBe("allowed");
    expect(evaluatePolicy(DAIRY, evidence({ foodName: "Chicken breast",
      allergenEvidence: { dairy: JEV_ROW } })).verdict).toBe("unverified");
  });

  it("the user's exact-product check does not lift it", () => {
    expect(evaluatePolicy(DAIRY, fixtureA2(0.99, { checkedAllergens: ["dairy"] })).verdict)
      .toBe("unverified");
  });

  it("a fresh complete-label merge never downgrades the hold", () => {
    const merged = mergeEvidence(JEV_ROW, { level: "not_listed", labelComplete: true });
    expect(merged).toEqual({ level: "listed", labelComplete: true, held: true });
  });

  it("the writer keeps source 'jev' for a hold it cannot re-derive, whatever the label says", async () => {
    const { client, rows } = writerWith([{ food_key: "catalog_revision:7", allergen: "dairy",
      level: "listed", label_complete: false, source: "jev" }]);
    await recordAllergenEvidence(client, [{ foodKey: "catalog_revision:7", userId: null,
      ingredientsText: COMPLETE_NO_DAIRY, labelComplete: true, foodName: "Mystery snack mix" }]);
    expect(rows.find((row) => row.allergen === "dairy")).toMatchObject({ level: "listed", source: "jev" });
  });
});

describe("Fixture A3: no deterministic evidence and a cached facet that would flag it", () => {
  it("is unverified, not admitted, and the log marks it", () => {
    expect(evaluatePolicy(DAIRY, fixtureA(0.97)).verdict).toBe("unverified");
    const item = { id: "00000000-0000-4000-8000-000000000001", seq: 1, food_ref_id: "food-ref-1",
      food_revision_id: 467, qty: 100, unit: "g", grams: 100 } as const;
    const identity = suggestionFoodIdentity({ foodRefId: item.food_ref_id,
      catalogFoodRevisionId: item.food_revision_id });
    const issues = logCommitPolicyIssues(DAIRY, [item], [evidence({ foodRefId: "food-ref-1",
      foodName: "Mystery snack mix" })], {
      status: "ready", preferenceFlags: [],
      byIdentity: { [identity]: { allergenTags: null, policyCategories: [], facets: facet(0.97),
        noCook: null, onEatsList: false, onAvoidList: false, role: null } },
    } as never);
    // The log commit marks it "Not verified" (lib/coach/log-policy.ts), never blocked or clean.
    expect(issues).toEqual([{ path: "items.0", message: "unverified:allergen:dairy" }]);
  });

  it("the writer never writes a source='jev' row for it", async () => {
    const { client, rows } = writerWith([]);
    await recordAllergenEvidence(client, [{ foodKey: "catalog_revision:8", userId: null,
      ingredientsText: null, labelComplete: false, foodName: "Mystery snack mix" }]);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.source === "jev")).toBe(false);
    expect(rows.find((row) => row.allergen === "dairy")).toMatchObject({ level: "no_evidence" });
  });
});

describe("Fixture B: complete deterministic evidence of absence", () => {
  it("a complete label that does not list a major allergen is allowed, as today", () => {
    expect(evaluatePolicy(DAIRY, evidence({ foodName: "Rice crackers",
      ingredientsText: COMPLETE_NO_DAIRY })).verdict).toBe("allowed");
    expect(evaluatePolicy(DAIRY, evidence({ foodName: "Rice crackers",
      allergenEvidence: { dairy: { level: "not_listed", labelComplete: true } } })).verdict)
      .toBe("allowed");
  });

  it("a whole-food class that rules it out is allowed, as today", () => {
    expect(evaluatePolicy(DAIRY, evidence({ foodName: "Chicken breast" })).verdict).toBe("allowed");
  });

  it("a cached facet beside complete evidence no longer changes the verdict", () => {
    expect(evaluatePolicy(DAIRY, evidence({ foodName: "Rice crackers",
      ingredientsText: COMPLETE_NO_DAIRY, facets: facet(0.99) })).verdict).toBe("allowed");
  });
});

describe("Fixture C: a source='jev' row whose food's own name names the allergen", () => {
  const WHEY = "Whey protein powder";

  it("stays blocked on a read that has the name, not merely unverified", () => {
    const verdict = evaluatePolicy(DAIRY, evidence({ foodName: WHEY, allergenEvidence: { dairy: JEV_ROW } }));
    expect(verdict.verdict).toBe("blocked");
    expect(allergenFinding("dairy", { stored: JEV_ROW, foodName: WHEY }))
      .toMatchObject({ outcome: "present", text: "Contains dairy" });
  });

  it("is re-derived first, so a read with stored evidence only also blocks", () => {
    const row: EvidenceRow = { food_key: "catalog_revision:42", allergen: "dairy", level: "listed",
      label_complete: false, source: "jev", user_id: null, updated_at: "2026-10-05T00:00:00Z" };
    const plan = planRederive([row], () => ({ foodName: WHEY, ingredientsText: null, tags: [] }));
    expect(plan).toEqual([{ foodKey: "catalog_revision:42", allergen: "dairy", userId: null,
      updatedAt: row.updated_at }]);
    // The re-derived row (source 'ingredients') is a deterministic block for a name-less reader.
    const rederived = storedEvidenceFromRow({ level: "listed", labelComplete: false, source: "ingredients" });
    expect(isDeterministicListed(rederived)).toBe(true);
    expect(evaluatePolicy(DAIRY, evidence({ allergenEvidence: { dairy: rederived } })).verdict)
      .toBe("blocked");
  });

  it("the warm writer never strips the hold itself: re-derive is a logged review", async () => {
    const { client, rows } = writerWith([{ food_key: "catalog_revision:42", allergen: "dairy",
      level: "listed", label_complete: false, source: "jev" }]);
    await recordAllergenEvidence(client, [{ foodKey: "catalog_revision:42", userId: null,
      ingredientsText: null, labelComplete: false, foodName: WHEY }]);
    expect(rows.find((row) => row.allergen === "dairy")).toMatchObject({ level: "listed", source: "jev" });
  });

  it("re-derive leaves a hold whose food names nothing, or cannot be read, held", () => {
    const row: EvidenceRow = { food_key: "catalog_revision:43", allergen: "dairy", level: "listed",
      label_complete: false, source: "jev", user_id: null, updated_at: "t" };
    expect(planRederive([row], () => ({ foodName: "Mystery snack mix", ingredientsText: null, tags: [] })))
      .toEqual([]);
    expect(planRederive([row], () => undefined)).toEqual([]);
  });
});

describe("property: for any facet probability in [0, 1], fixtures A and A2 are never allowed", () => {
  // A dense grid plus a seeded sample; the ends and the old "present" bands are on the grid.
  let seed = 18;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const ps = [...Array.from({ length: 1001 }, (_, i) => i / 1000),
    ...Array.from({ length: 500 }, random), 0.051, 0.0505, 1 - Number.EPSILON];

  it.each([
    ["A", (p: number) => fixtureA(p)],
    ["A2", (p: number) => fixtureA2(p)],
    ["A2 with a user check", (p: number) => fixtureA2(p, { checkedAllergens: ["dairy"] })],
    ["A2 on a whole food", (p: number) => fixtureA2(p, { foodName: "Chicken breast", ingredientsText: null })],
  ])("%s", (_name, build) => {
    for (const p of ps) expect(evaluatePolicy(DAIRY, build(p)).verdict, `p=${p}`).not.toBe("allowed");
  });
});

/** Review r1 BLOCK 1: a branded or packaged product is never cleared as a plain whole food. */
describe("identity: a branded item is never cleared as a whole food", () => {
  const EGG = "Egg, whole, cooked, hard-boiled";
  const line: RecipeIngredient = { seq: 1, name: "hard-boiled eggs", foodRefId: "ref-1",
    catalogFoodRevisionId: 101, foodDbId: null, quantity: 100, unit: "g", grams: 100,
    state: "cooked", required: true, purchaseGrams: null, purchaseConversionStatus: "unknown",
    nutrition: {}, allergenEvidence: {} };
  const recipe = { sourceKind: "shared", recipeId: "r", revisionId: "r:1",
    publicationState: "published", withdrawalReason: null, name: "Eggs", cuisine: "American",
    dishTags: [], activeMinutes: 5, totalMinutes: 5, effort: "none", servings: 1, yieldGrams: null,
    yieldStatus: "unknown", minServingFraction: 0.5, maxServingFraction: 2, ingredients: [line],
    steps: [{ seq: 1, text: "Peel." }], nutritionPerServing: {},
    source: { author: "Meal Companion", sourceUrl: null, rightsKind: "original",
      rightsRecord: "Original.", sourceRevision: "t", kitchenTested: false } } as CatalogRecipe;
  const status = (extra: Record<string, unknown>) => recipeEligibility(recipe, { profile: DAIRY,
    evidenceBySeq: { 1: { foodName: EGG, category: [], facets: facet(0.11), ...extra } } as never }).status;

  it("a recipe line on a branded or packaged egg revision with only a Jev dairy flag is not eligible", () => {
    expect(status({})).toBe("eligible"); // control: a plain, unbranded USDA egg clears by class
    expect(status({ foodBrand: "BrandCo" })).not.toBe("eligible");
    expect(status({ packaged: true })).not.toBe("eligible");
  });

  it("the recipe loader passes the revision's brand and packaging into the policy evidence", () => {
    const source = readFileSync(path.join(process.cwd(), "lib/server/recipe-candidates.ts"), "utf8");
    expect(source).toMatch(/foodBrand: row\.brand \?\? null/);
    expect(source).toMatch(/packaged: isPackagedCatalogSource\(revisionSource\(row\)\)/);
    expect(source).toContain("catalog_foods(source)");
  });

  it("evaluatePolicy never clears a branded or packaged whole-food name", () => {
    for (const extra of [{ foodBrand: "BrandCo" }, { packaged: true }]) {
      expect(evaluatePolicy(DAIRY, evidence({ foodName: "Chicken breast", ...extra })).verdict)
        .not.toBe("allowed");
    }
  });
});

/** Review r1 BLOCK 2: an unread evidence port never yields a log with no mark. */
describe("log marks when the evidence read fails", () => {
  const item = { id: "00000000-0000-4000-8000-000000000001", seq: 1, food_ref_id: "food-ref-1",
    food_revision_id: null, qty: 100, unit: "g", grams: 100 } as const;
  // The commit lane's own base evidence for a user food named "Chicken breast": its stored hold is
  // only in the (unavailable) evidence port, so the base alone would clear it by class.
  const base = evidence({ foodRefId: "food-ref-1", foodName: "Chicken breast", allergenTags: [] });

  it("marks the held 'Chicken breast' when the evidence is unavailable", () => {
    expect(evaluatePolicy(DAIRY, base).verdict).toBe("allowed"); // what the fallback alone says
    const issues = logCommitPolicyIssues(DAIRY, [item], [base],
      { status: "unavailable", preferenceFlags: [], byIdentity: {} } as never);
    expect(issues).toEqual([{ path: "items.0", message: RULES_UNREADABLE_MESSAGE }]);
  });

  it("with the evidence read, the hold itself is the mark", () => {
    const identity = suggestionFoodIdentity({ foodRefId: "food-ref-1", catalogFoodRevisionId: null });
    const issues = logCommitPolicyIssues(DAIRY, [item], [base], {
      status: "ready", preferenceFlags: [],
      byIdentity: { [identity]: { allergenTags: [], policyCategories: [], facets: {},
        allergenEvidence: { dairy: JEV_ROW }, foodName: "Chicken breast",
        noCook: null, onEatsList: false, onAvoidList: false, role: null } },
    } as never);
    expect(issues).toEqual([{ path: "items.0", message: `unverified:dairy:${HELD_ALLERGEN_TEXT}` }]);
  });

  it("never returns an empty list for an unread port, whatever the rules", () => {
    for (const profile of [EMPTY_PROFILE, DAIRY]) {
      const issues = logCommitPolicyIssues(profile, [item, { ...item, seq: 2 }], [base, base],
        { status: "unavailable", preferenceFlags: [], byIdentity: {} } as never);
      expect(issues.map((issue) => issue.path)).toEqual(["items.0", "items.1"]);
    }
  });
});

describe("the review and report script (scripts/allergen-jev-holds.ts)", () => {
  it("counts held rows by allergen and ignores everything else", () => {
    const base = { label_complete: false, user_id: null, updated_at: "t" };
    expect(heldCountsByAllergen([
      { ...base, food_key: "a", allergen: "dairy", level: "listed", source: "jev" },
      { ...base, food_key: "b", allergen: "milk", level: "listed", source: "jev" },
      { ...base, food_key: "c", allergen: "gluten", level: "listed", source: "jev" },
      { ...base, food_key: "d", allergen: "dairy", level: "listed", source: "ingredients" },
      { ...base, food_key: "e", allergen: "dairy", level: "no_evidence", source: "legacy" },
    ])).toEqual({ dairy: 2, gluten: 1 });
  });

  it("a review replaces a hold only with deterministic evidence", () => {
    expect(reviewReplacement("dairy", { ingredientsText: null, labelComplete: false, tags: null,
      foodName: "Mystery snack mix" })).toBeNull();
    // A whole-food name is not stored evidence: the hold stays.
    expect(reviewReplacement("dairy", { ingredientsText: null, labelComplete: false, tags: null,
      foodName: "Chicken breast" })).toBeNull();
    expect(reviewReplacement("dairy", { ingredientsText: COMPLETE_NO_DAIRY, labelComplete: true,
      tags: null, foodName: "Rice crackers" })).toEqual({ level: "not_listed", labelComplete: true });
    expect(reviewReplacement("gluten", { ingredientsText: null, labelComplete: false,
      tags: ["wheat"], foodName: "Crackers" })).toMatchObject({ level: "listed" });
  });

  it("refuses writes on production without --production, and on an unknown project", () => {
    const prod = "https://fivatgdpuenszxxnijpc.supabase.co";
    expect(() => assertHoldsWriteTarget([], prod)).not.toThrow();
    expect(() => assertHoldsWriteTarget(["--rederive"], prod)).toThrow(/without --production/);
    expect(() => assertHoldsWriteTarget(["--rederive", "--production"], prod)).not.toThrow();
    expect(() => assertHoldsWriteTarget(["--review"], "not a url")).toThrow(/cannot identify/);
    expect(() => assertHoldsWriteTarget(["--production"], prod)).toThrow(/only applies/);
  });

  it("a review dry run is a read: no --production, and never with it", () => {
    const prod = "https://fivatgdpuenszxxnijpc.supabase.co";
    expect(() => assertHoldsWriteTarget(["--review", "--dry-run"], prod)).not.toThrow();
    expect(() => assertHoldsWriteTarget(["--review", "--dry-run", "--production"], prod))
      .toThrow(/writes nothing/);
    expect(() => assertHoldsWriteTarget(["--dry-run"], prod)).toThrow(/only applies with --review/);
    expect(() => assertHoldsWriteTarget(["--rederive", "--dry-run"], prod)).toThrow(/only applies/);
  });

  it("W022 (B277): a rice or tuna revision held for gluten stays held on review", () => {
    // The last name is the one rice row production holds for gluten (read-only, 2026-10-10): it
    // has no ingredient rows, so a review finds no deterministic evidence and the hold stays.
    for (const foodName of ["Rice, white, long-grain, regular, enriched, cooked",
      "Fish, tuna, light, canned in water, drained solids",
      "Soup, HEALTHY CHOICE Chicken and Rice Soup, canned"]) {
      expect(reviewReplacement("gluten", { ingredientsText: null, labelComplete: false, tags: null,
        foodName })).toBeNull();
    }
  });
});

/**
 * W2a acceptance 2: no allergen decision in lib/policy/ reads FoodFacetJudgments. Since W2c no
 * diet, religious or profile rule decision reads one either (tests/policy/diet-rule-jev-removal);
 * the remaining readers are an explicit allowlist, so a new importer fails here and must be reviewed.
 */
describe("import graph: no Jev facet reaches an allergen decision in lib/policy", () => {
  const root = path.join(process.cwd(), "lib/policy");
  const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : full.endsWith(".ts") && !full.endsWith(".test.ts") ? [full] : [];
  });
  const sources = new Map(files(root).map((file) => [path.relative(process.cwd(), file), readFileSync(file, "utf8")]));
  const readsFacets = (source: string) =>
    /from "@\/lib\/foods\/facets"|FoodFacetJudgments|facetOutcome|allergen-write-guard/.test(source);

  it("the allergen modules read no facet", () => {
    for (const file of ["lib/policy/allergens.ts", "lib/policy/whole-foods.ts",
      "lib/policy/whole-food-classes.ts", "lib/policy/label-completeness.ts",
      "lib/policy/lookup-evidence.ts", "lib/policy/pregnancy-tuna.ts"]) {
      expect(sources.has(file), file).toBe(true);
      expect(readsFacets(sources.get(file) as string), file).toBe(false);
    }
  });

  it("only the type carrier and the threshold table name facets, and none hands them to a finding", () => {
    const readers = [...sources.entries()].filter(([, source]) => readsFacets(source)).map(([file]) => file).sort();
    // constraints.ts only carries the type on PolicyEvidence; facet-rules.ts defines facetOutcome
    // for non-rule judgments. Neither decides a rule from it (W2c).
    expect(readers).toEqual(["lib/policy/constraints.ts", "lib/policy/facet-rules.ts"]);
    const constraints = sources.get("lib/policy/constraints.ts") as string;
    const start = constraints.indexOf("function allergenFindings(");
    const body = constraints.slice(start, constraints.indexOf("\n}\n", start));
    expect(start).toBeGreaterThan(0);
    expect(body).not.toMatch(/facets/);
  });

  it("allergenFinding and deriveEvidence take no facet input", () => {
    const allergens = sources.get("lib/policy/allergens.ts") as string;
    for (const fn of ["export function deriveEvidence(", "export function allergenFinding(",
      "export function evidenceFromInputs("]) {
      const start = allergens.indexOf(fn);
      const signature = allergens.slice(start, allergens.indexOf("{\n", allergens.indexOf("): ", start)));
      expect(start, fn).toBeGreaterThan(0);
      expect(signature, fn).not.toMatch(/facets/);
    }
  });
});

type Upserted = { allergen: string; level: string; source: string };

function writerWith(existing: { food_key: string; allergen: string; level: string;
  label_complete: boolean; source: string }[]) {
  const rows: Upserted[] = [];
  const from = () => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain, in: () => chain, order: () => chain, range: () => chain,
      then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve({ data: existing, error: null }).then(resolve),
      upsert: async (value: unknown) => { rows.push(...(value as Upserted[])); return { error: null }; },
    });
    return chain;
  };
  return { client: { from } as never, rows };
}
