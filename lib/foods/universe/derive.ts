/**
 * Everything about a universe item that is derived, never typed (Phase 18 D1): its bundled row,
 * role and plate parts (lib/foods/role.ts, lib/meals/parts.ts), its `policy_categories`
 * (lib/catalog/category-map.ts, from the SR description and food group exactly as the catalog
 * annotator reads the revision), and its allergen state for every key in ALLERGEN_RULES.
 *
 * Allergen evidence is deterministic only (D4, W2a; never Jev). Per key:
 *   listed   the curated name or the SR description names the allergen (escalation by name);
 *   clear    nothing names it and the whole-food class rules it out;
 *   unknown  neither: a declared gap that keeps the item out of generation for an account that
 *            avoids that allergen (fail-closed, "Check the label").
 * The whole-food class reads the curated name (the reviewed bundled name, passed as
 * `wholeFoodName`): SR descriptions carry survey qualifiers ("mature seeds", "with salt") the
 * class table does not know, while escalation reads both names. The curated name is not read when
 * the SR description discloses what the name hides (an additive, a preparation, sweetening): then
 * nothing clears by class (GPT-6 Sol review, 2026-10-05: shrimp "may contain additives").
 * `universePolicyEvidence` hands
 * `evaluatePolicy` the same inputs, so the states here and a verdict there never disagree.
 *
 * Pure. No I/O.
 */

import { policyCategoriesFor, type PolicyCategoryKey } from "@/lib/catalog/category-map";
import { dbFood, type DbFood } from "@/lib/food-db";
import type { Food } from "@/lib/foods";
import { universeFood } from "@/lib/foods/universe/food";
import { partsOf, type Part } from "@/lib/meals/parts";
import {
  ALLERGEN_RULES, allergenFinding, deriveEvidence, type StoredAllergenEvidence,
} from "@/lib/policy/allergens";
import type { PolicyEvidence } from "@/lib/policy/constraints";
import type { UniverseEntry } from "@/lib/foods/universe/manifest";

export type AllergenState = "listed" | "clear" | "unknown";
export const ALLERGEN_KEYS = Object.keys(ALLERGEN_RULES);

export type UniverseItem = {
  entry: UniverseEntry;
  row: DbFood;
  /** The account-facing food: per-gram macros, unit "g", marked nothing (`neutral`). */
  food: Food;
  parts: Part[];
  policyCategories: PolicyCategoryKey[];
  allergens: Readonly<Record<string, AllergenState>>;
};

/**
 * SR wording that says the row is more than its curated name. "prepared with calcium sulfate" is
 * tofu's coagulant, named on every plain tofu row, and stays readable.
 */
const SR_DISCLOSES = /\badditives?\b|\bprepared\b(?! with calcium sulfate)|\bsweetened\b|\bseasoned\b|\bflavou?red\b|\bfortified\b/i;

/** The name the whole-food class reads: the curated name, or null when the SR row discloses more. */
export function clearanceName(row: Pick<DbFood, "name" | "sr">): string | null {
  return SR_DISCLOSES.test(row.sr) ? null : row.name;
}

function storedNameEvidence(row: DbFood): Record<string, StoredAllergenEvidence> {
  return Object.fromEntries(ALLERGEN_KEYS.map((key) => [key,
    deriveEvidence(key, { ingredientsText: null, labelComplete: false, foodName: row.name })]));
}

/** The policy inputs for one item: no tags, no ingredient text, no Eats mark, no facets. */
export function universePolicyEvidence(item: Pick<UniverseItem, "row" | "policyCategories">):
  PolicyEvidence {
  return {
    foodRefId: null, allergenTags: null, category: [...item.policyCategories],
    onEatsList: false, onAvoidList: false, foodName: item.row.sr, wholeFoodName: clearanceName(item.row),
    allergenEvidence: storedNameEvidence(item.row),
  };
}

function allergenStates(row: DbFood): Record<string, AllergenState> {
  const evidence = universePolicyEvidence({ row, policyCategories: [] });
  return Object.fromEntries(ALLERGEN_KEYS.map((key) => {
    const finding = allergenFinding(key, { stored: evidence.allergenEvidence?.[key],
      foodName: evidence.foodName, wholeFoodName: evidence.wholeFoodName });
    const state: AllergenState = finding.outcome === "present" ? "listed"
      : finding.outcome === "absent" ? "clear" : "unknown";
    return [key, state];
  }));
}

const cache = new Map<string, UniverseItem>();

/** The derived item, or null when the bundled list no longer has the entry's food. */
export function deriveItem(entry: UniverseEntry): UniverseItem | null {
  const hit = cache.get(entry.id);
  if (hit && hit.entry === entry) return hit;
  const row = dbFood(entry.id);
  if (!row) return null;
  const food = universeFood(row);
  const item: UniverseItem = {
    entry, row, food, parts: partsOf(food),
    policyCategories: policyCategoriesFor({ description: row.sr, category: row.srCategory ?? null }),
    allergens: allergenStates(row),
  };
  cache.set(entry.id, item);
  return item;
}

/** Share of items whose state for `key` is `clear` (the per-allergen report, W1 acceptance 3). */
export function clearShare(items: readonly UniverseItem[], key: string): number {
  if (!items.length) return 0;
  return items.filter((item) => item.allergens[key] === "clear").length / items.length;
}
