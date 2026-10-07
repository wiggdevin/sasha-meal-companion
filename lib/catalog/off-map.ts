/**
 * OFF product → RevisionDraft. Three rules decide everything in this file.
 *
 * 1. `null` is not `0` (architecture §3.1). A nutrient OFF did not report stays null, and the
 *    rest of the app reads that as "not measured", never as a measured zero.
 * 2. A product with no energy AND no protein AND no carbohydrate AND no fat is useless as a log
 *    line, so it is rejected rather than written half-empty (fud-ai review §2, same rule).
 * 3. The apple trap in targets.md §5 is why the ingredient text is scanned as well as the
 *    allergens field: an OFF pouch with apple juice concentrate in the list often declares no
 *    allergen at all, and the user has to see it before the user logs it.
 *
 * Provider text is data, never instruction (contracts §10): every string here is stored and
 * rendered as text and is never interpolated into SQL or a prompt.
 */
import type { OffNutriments, OffProduct } from "@/lib/catalog/off";
import { policyCategoriesFor } from "@/lib/catalog/category-map";
import { NUTRIENT_CODES, type NutrientCode } from "@/lib/nutrients/codes";

export type RevisionDraft = {
  description: string;
  brand: string | null;
  qualityClass: "crowd" | "label";
  per100g: Record<NutrientCode, number | null>;
  portions: { description: string; gramWeight: number }[];
  ingredients: { seq: number; name: string; allergenTags: string[] }[];
  ingredientsText: string | null;
  qualityFlags: string[];
  category: string | null;
  /** The controlled keys the policy compares — `catalog_food_revisions.policy_categories`. */
  policyCategories: string[];
  sourceId: string;
  publishedAt: string;
};

export function emptyPer100g(): Record<NutrientCode, number | null> {
  const out = {} as Record<NutrientCode, number | null>;
  for (const code of NUTRIENT_CODES) out[code] = null;
  return out;
}

export function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function num(v: number | string | undefined): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || v.trim() === "") return null;
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : null;
}

/** OFF reports grams per 100 g; our canonical unit is mg for minerals and µg for D, B12, A, folate. */
const OFF_DIRECT: { code: NutrientCode; key: string; factor: number }[] = [
  { code: "protein", key: "proteins_100g", factor: 1 },
  { code: "carbohydrate", key: "carbohydrates_100g", factor: 1 },
  { code: "fat_total", key: "fat_100g", factor: 1 },
  { code: "fiber_total", key: "fiber_100g", factor: 1 },
  { code: "sugars_total", key: "sugars_100g", factor: 1 },
  { code: "saturated_fat", key: "saturated-fat_100g", factor: 1 },
  { code: "cholesterol", key: "cholesterol_100g", factor: 1000 },
  { code: "potassium", key: "potassium_100g", factor: 1000 },
  { code: "calcium", key: "calcium_100g", factor: 1000 },
  { code: "iron", key: "iron_100g", factor: 1000 },
  { code: "magnesium", key: "magnesium_100g", factor: 1000 },
  { code: "zinc", key: "zinc_100g", factor: 1000 },
  { code: "vitamin_c", key: "vitamin-c_100g", factor: 1000 },
  { code: "vitamin_d", key: "vitamin-d_100g", factor: 1_000_000 },
  { code: "vitamin_b12", key: "vitamin-b12_100g", factor: 1_000_000 },
  { code: "folate_dfe", key: "folates_100g", factor: 1_000_000 },
  { code: "vitamin_a_rae", key: "vitamin-a_100g", factor: 1_000_000 },
];

const KJ_TO_KCAL = 0.239;

function readNutriments(n: OffNutriments): { per100g: Record<NutrientCode, number | null>; flags: string[] } {
  const per100g = emptyPer100g();
  const flags: string[] = [];
  for (const { code, key, factor } of OFF_DIRECT) {
    const value = num(n[key]);
    if (value !== null) per100g[code] = round4(value * factor);
  }
  const kcal = num(n["energy-kcal_100g"]);
  const kj = num(n.energy_100g);
  if (kcal !== null) {
    per100g.energy_kcal = round4(kcal);
  } else if (kj !== null) {
    per100g.energy_kcal = round4(kj * KJ_TO_KCAL);
    flags.push("off_energy_from_kj");
  }
  const sodium = num(n.sodium_100g);
  const salt = num(n.salt_100g);
  if (sodium !== null) {
    per100g.sodium = round4(sodium * 1000);
  } else if (salt !== null) {
    per100g.sodium = round4((salt / 2.5) * 1000);
    flags.push("sodium_from_salt");
  }
  if (per100g.folate_dfe !== null) flags.push("folate_not_dfe");
  if (per100g.vitamin_a_rae !== null) flags.push("vitamin_a_not_rae");
  return { per100g, flags };
}

/** Architecture §3.1: 4/4/9 on protein, available carbohydrate and fat. Incomplete stays null. */
export function atwaterKcal(
  p: Record<NutrientCode, number | null>
): { kcal: number | null; complete: boolean } {
  const { protein, carbohydrate, fat_total: fat, fiber_total: fiber } = p;
  if (protein === null || carbohydrate === null || fat === null) {
    return { kcal: null, complete: false };
  }
  const available = fiber === null ? carbohydrate : Math.max(carbohydrate - fiber, 0);
  return { kcal: Math.round(4 * protein + 4 * available + 9 * fat), complete: true };
}

/** `energy_mismatch` only when both numbers exist: an incomplete Atwater is excluded (§3.1). */
export function energyFlags(reported: number | null, calc: number | null): string[] {
  if (calc === null) return ["atwater_incomplete"];
  if (reported === null) return [];
  return Math.abs(calc - reported) / Math.max(reported, 1) > 0.1 ? ["energy_mismatch"] : [];
}

/** Top-level commas only, so "chocolate (cocoa mass, sugar)" stays one ingredient. */
export function splitIngredients(text: string | null): string[] {
  if (!text) return [];
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(" || ch === "[") depth += 1;
    if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0).slice(0, 60);
}

/* The three the user cannot eat (targets.md §5, architecture §4.4 default profile). The `_OK` lists
   are the same exclusions lib/catalog-client.ts uses, so a scanned row and a searched row mark
   the same food the same way. "Malic acid" is deliberately not an apple word. */
const GLUTEN = /\b(gluten|wheat|barley|rye|spelt|semolina|farro|malt extract)\b/i;
const GLUTEN_OK = /\b(gluten[- ]free|rice noodles|corn tortilla|buckwheat|quinoa)\b/i;
const DAIRY = /\b(milk|whey|casein|caseinate|lactose|cheese|yogurt|cream|butterfat|ghee)\b/i;
const DAIRY_OK =
  /\b(almond milk|oat milk|soy milk|rice milk|coconut milk|coconut cream|peanut butter|almond butter|cashew butter|sunflower seed butter|cocoa butter|shea butter)\b/i;
const APPLE = /\bapple/i;

export function scanAllergens(text: string): string[] {
  const out: string[] = [];
  if (GLUTEN.test(text) && !GLUTEN_OK.test(text)) out.push("gluten");
  if (DAIRY.test(text) && !DAIRY_OK.test(text)) out.push("dairy");
  if (APPLE.test(text)) out.push("apple");
  return out;
}

/**
 * "en:milk" → "dairy"; anything outside our vocabulary keeps its bare OFF name.
 *
 * `wheat` is deliberately NOT aliased here (finding #8): it is one of the nine FALCPA allergens
 * with its own rule (lib/policy/allergens.ts ALLERGEN_RULES.wheat), distinct from the broader,
 * non-major `gluten` rule. Renaming a declared "wheat" tag to "gluten" orphaned the wheat rule —
 * a product that declares wheat and ships no ingredient text read as unverified rather than
 * blocked. `declareGlutenFamily` below adds the `gluten` tag back alongside it.
 *
 * ORCHESTRATOR fix (round 7, item 1): `spelt`, `kamut`, `triticale`, `einkorn` and `farro` are
 * themselves wheat species (Triticum spelta, T. turgidum ssp. polonicum/durum, T. monococcum) —
 * FALCPA's own wheat definition names them — so an OFF tag declaring one of them is a WHEAT
 * declaration, not only a broader-gluten one. `barley` and `rye` are not wheat and stay
 * gluten-only, same as before. A value here may now be more than one mapped tag.
 *
 * Review round 2 (sol/BLOCK): the same gap existed for tree nuts. OFF's own taxonomy tags several
 * species individually (`en:almonds`, `en:cashews`, ...), which without an alias here stayed as
 * the bare species word — `almonds`, `cashews`, ... — and `lib/policy/allergens.ts`'s `tree-nut`
 * rule only recognizes its own key, `tree-nut` (or the generic `nuts` / `tree nuts` aliases it
 * already resolves). A product declaring only a species tag and shipping no ingredient text has
 * no other signal, so it read as `no_evidence` (unverified) instead of `listed` (blocked) — and a
 * user tapping "I checked the label" could then mark it allowed despite the declaration. Each
 * species tag maps straight to the rule's own key, the same shape the wheat fix above uses.
 */
const TAG_ALIASES: Record<string, string | readonly string[]> = {
  milk: "dairy", lactose: "dairy", barley: "gluten", rye: "gluten",
  spelt: ["wheat", "gluten"], kamut: ["wheat", "gluten"], triticale: ["wheat", "gluten"],
  einkorn: ["wheat", "gluten"], farro: ["wheat", "gluten"],
  almond: "tree-nut", almonds: "tree-nut", cashew: "tree-nut", cashews: "tree-nut",
  walnut: "tree-nut", walnuts: "tree-nut", pecan: "tree-nut", pecans: "tree-nut",
  pistachio: "tree-nut", pistachios: "tree-nut", hazelnut: "tree-nut", hazelnuts: "tree-nut",
  filbert: "tree-nut", filberts: "tree-nut", macadamia: "tree-nut", macadamias: "tree-nut",
  "macadamia-nuts": "tree-nut", "brazil-nut": "tree-nut", "brazil-nuts": "tree-nut",
  "pine-nut": "tree-nut", "pine-nuts": "tree-nut",
  "en:milk": "dairy", "en:gluten": "gluten",
};

/** wheat, barley, rye, spelt and kamut are all gluten sources; a bare `wheat` tag also means
 * `gluten` for anyone avoiding gluten broadly, even though it keeps its own identity for the
 * wheat-specific FALCPA rule (finding #8). */
function declareGlutenFamily(tags: readonly string[]): string[] {
  return tags.includes("wheat") && !tags.includes("gluten") ? [...tags, "gluten"] : [...tags];
}

export function mapAllergenTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of tags) {
    const bare = raw.includes(":") ? raw.slice(raw.indexOf(":") + 1) : raw;
    const mapped = TAG_ALIASES[bare] ?? bare;
    for (const one of Array.isArray(mapped) ? mapped : [mapped]) {
      if (one.length > 0 && !out.includes(one)) out.push(one);
    }
  }
  return out;
}

/**
 * Ingredient rows. Seq 0, when present, is the provider's own declared-allergen line — it reads
 * like the "Contains:" line on a label and gives the policy something to judge when the product
 * ships no ingredient text at all. Real ingredients start at seq 1.
 */
export function ingredientRows(
  ingredientsText: string | null,
  declaredTags: string[]
): { rows: RevisionDraft["ingredients"]; flags: string[] } {
  const rows: RevisionDraft["ingredients"] = [];
  const flags: string[] = [];
  if (declaredTags.length > 0) {
    rows.push({ seq: 0, name: `Contains: ${declaredTags.join(", ")}`, allergenTags: declaredTags });
    flags.push("allergens_from_tags");
  }
  const textRows = splitIngredients(ingredientsText).map((name, i) => ({
    seq: i + 1, name, allergenTags: scanAllergens(name),
  }));
  rows.push(...textRows);
  // No provider-declared tags, and our English word lists matched nothing: this could be a real
  // "no allergen" product, or it could be non-English text or vocabulary the lists don't cover
  // (finding #8). Flag it so a caller doesn't read the empty result as a confirmed clean scan.
  if (declaredTags.length === 0 && textRows.length > 0 && !textRows.some((r) => r.allergenTags.length > 0)) {
    flags.push("allergens_text_unconfirmed");
  }
  return { rows, flags };
}

function firstBrand(brands: string | undefined): string | null {
  const first = (brands ?? "").split(",")[0]?.trim();
  return first && first.length > 0 ? first : null;
}

/**
 * lib/policy/constraints.ts's `banned_categories` compares `category` verbatim
 * (case-insensitive) against their constraint profile, so a provider's own free-text category
 * has to land on one of those controlled names to ever be enforceable. This is deliberately a
 * narrow, additive keyword net for `DEFAULT_PROFILE.banned_categories` (finding #33's own
 * scenario: honey, maple syrup, agave, jam) rather than a full OFF/FDC taxonomy — an
 * unrecognized category stays `null`, same as no category at all, never a false block.
 */
const SIMPLE_SUGARS_KEYWORDS = /honey|sugar|syrup|agave|jam|jelly|preserve|marmalade/i;

export function deriveCategory(text: string | null | undefined): string | null {
  if (!text) return null;
  return SIMPLE_SUGARS_KEYWORDS.test(text) ? "simple_sugars" : null;
}

/** OFF's `categories_tags` (e.g. "en:honeys") → the bare, space-joined tag names deriveCategory scans. */
export function mapCategory(tags: readonly string[] | undefined): string | null {
  if (!tags || tags.length === 0) return null;
  const bare = tags.map((t) => (t.includes(":") ? t.slice(t.indexOf(":") + 1) : t)).join(" ");
  return deriveCategory(bare);
}

/** A provider draft's own policy keys, so an imported row is annotated the moment it is written. */
export function draftPolicyCategories(description: string, category: string | null): string[] {
  return policyCategoriesFor({ description, category });
}

export function offToRevision(p: OffProduct, fetchedAt: string): RevisionDraft | { reject: string } {
  const { per100g, flags } = readNutriments(p.nutriments ?? {});
  if (
    per100g.energy_kcal === null && per100g.protein === null &&
    per100g.carbohydrate === null && per100g.fat_total === null
  ) {
    return { reject: "no_nutrition" };
  }
  const atwater = atwaterKcal(per100g);
  per100g.energy_kcal_calc = atwater.kcal;
  if (atwater.complete && per100g.fiber_total === null) flags.push("carb_basis_total");
  flags.push(...energyFlags(per100g.energy_kcal, atwater.kcal));

  const declared = declareGlutenFamily(
    mapAllergenTags([...(p.allergens_tags ?? []), ...(p.traces_tags ?? [])]));
  const ingredientsText = p.ingredients_text?.trim() || null;
  const { rows, flags: rowFlags } = ingredientRows(ingredientsText, declared);

  const servingGrams = num(p.serving_quantity);
  const portions =
    servingGrams !== null && servingGrams > 0
      ? [{ description: p.serving_size?.trim() || `${servingGrams} g`, gramWeight: round4(servingGrams) }]
      : [];

  const description = p.product_name?.trim() || firstBrand(p.brands) || "Scanned product";
  const category = mapCategory(p.categories_tags);
  return {
    description,
    brand: firstBrand(p.brands),
    qualityClass: "crowd",
    per100g,
    portions,
    ingredients: rows,
    ingredientsText,
    qualityFlags: [...new Set([...flags, ...rowFlags])],
    category,
    policyCategories: draftPolicyCategories(description, category),
    sourceId: "",
    publishedAt: fetchedAt,
  };
}
