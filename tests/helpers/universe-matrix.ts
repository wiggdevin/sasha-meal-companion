/**
 * The W1 cuisine × rule-profile matrix (docs/specs/phase-18-open-world-foods.md W1, acceptance 2):
 * for each cuisine (its pack staples plus the base), each of 8 rule profiles and 7 dates, a 4-meal
 * day at 2,000 kcal and 140 g protein gets a plate in every slot from lib/meals `planDay`.
 *
 * The pool is what D4's admission order would hand the engine: universe items whose
 * `evaluatePolicy` verdict is `allowed` under the profile, from deterministic evidence only (no Jev
 * facets: the W2a/W2c rule), with usable nutrition, and countable (a herb seasons a plate, it never
 * fills a part). `planDay`'s pool still reads Eats, so admitted foods enter it marked `eats`; W8
 * widens the pool itself.
 */
import { describe, expect, it } from "vitest";
import type { Food } from "@/lib/foods";
import { deriveItem, type UniverseItem } from "@/lib/foods/universe/derive";
import { cuisineEntries } from "@/lib/foods/universe/manifest";
import type { CuisineKey } from "@/lib/foods/universe/vocabulary";
import { planDay, type DayPlan, type DaySlot } from "@/lib/meals/day";
import { usableForGeneration } from "@/lib/meals/pool";
import { universeVerdict as admissionVerdict } from "@/lib/foods/world/admission";
import { EMPTY_PROFILE, type ConstraintProfile, type PolicyVerdict } from "@/lib/policy/constraints";
import type { PolicyPreferenceFlag } from "@/lib/policy/facet-rules";

export type RuleProfile = { key: string; profile: ConstraintProfile; flags: PolicyPreferenceFlag[] };

const allergens = (...keys: string[]): ConstraintProfile => ({ ...EMPTY_PROFILE, avoid_allergens: keys });

/**
 * Eight realistic rule profiles. Halal is tested as its no-pork food rule: the `halal` flag also
 * needs certification evidence (`requiresVerification`), which no universe item carries, so it
 * admits nothing automatically by design.
 */
export const RULE_PROFILES: readonly RuleProfile[] = [
  { key: "none", profile: EMPTY_PROFILE, flags: [] },
  { key: "vegetarian", profile: EMPTY_PROFILE, flags: ["vegetarian"] },
  { key: "vegan", profile: EMPTY_PROFILE, flags: ["vegan"] },
  { key: "gluten-free", profile: allergens("gluten"), flags: [] },
  { key: "dairy-free", profile: allergens("dairy"), flags: [] },
  { key: "peanut+tree-nut", profile: allergens("peanut", "tree-nut"), flags: [] },
  { key: "shellfish+fish", profile: allergens("shellfish", "fish"), flags: [] },
  { key: "no-pork (halal practice)", profile: EMPTY_PROFILE, flags: ["no_pork"] },
];

export const MATRIX_DATES = [
  "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11",
] as const;

/** 2,000 kcal and 140 g protein over 4 meals, split evenly the way open slots share a day. */
const SLOT = { kcal: 500, protein: 35, carbs: 52.5, fat: 16.7 };
export const MATRIX_SLOTS: readonly DaySlot[] = ["08:00", "11:30", "15:00", "18:30"].map((clock, i) => ({
  id: `meal-${i + 1}` as DaySlot["id"], clock, target: SLOT }));

/**
 * The verdict for one item: the production admission rule (lib/foods/world/admission.ts, W2b's
 * candidate reader), with no Avoid family. It is the raw `evaluatePolicy` verdict on the item's own
 * inputs (no Eats mark, no Jev facet); only `allowed` is admitted.
 */
export function universeVerdict(rules: RuleProfile, item: UniverseItem): PolicyVerdict["verdict"] {
  return admissionVerdict({ profile: rules.profile, preferenceFlags: rules.flags, avoidFamilies: new Set() },
    item).verdict;
}

export function admittedPool(cuisine: CuisineKey, rules: RuleProfile): Food[] {
  return cuisineEntries(cuisine).map((entry) => deriveItem(entry))
    .filter((item): item is UniverseItem => item !== null && item.entry.countable)
    .filter((item) => universeVerdict(rules, item) === "allowed")
    .map((item) => ({ ...item.food, status: "eats" as const }))
    .filter(usableForGeneration);
}

export function matrixDay(date: string, pool: readonly Food[]): DayPlan {
  return planDay(date, MATRIX_SLOTS, pool);
}

/** The 12 cuisines, split over tests/foods/universe-matrix-{a,b,c,d}.test.ts so CI shards share them. */
export const MATRIX_SPLIT: readonly (readonly CuisineKey[])[] = [
  ["american", "latin_american", "italian"],
  ["mediterranean", "south_asian", "chinese"],
  ["japanese", "korean", "southeast_asian"],
  ["caribbean", "african", "european_other"],
];

/** One `it` per rule profile: all 7 dates of that cuisine fill every slot (no shortage). */
export function describeCuisineMatrix(cuisines: readonly CuisineKey[]): void {
  for (const cuisine of cuisines) {
    describe(`universe matrix: ${cuisine} (with the base)`, () => {
      it.each(RULE_PROFILES.map((rules) => [rules.key, rules] as const))("%s: a plate in every slot on 7 dates",
        (_key, rules) => {
          const pool = admittedPool(cuisine, rules);
          for (const date of MATRIX_DATES) {
            const plan = matrixDay(date, pool);
            expect([date, plan.shortages]).toEqual([date, []]);
            expect(plan.plates.map((row) => row.slot)).toEqual(MATRIX_SLOTS.map((slot) => slot.id));
          }
        }, 60_000);
    });
  }
}
