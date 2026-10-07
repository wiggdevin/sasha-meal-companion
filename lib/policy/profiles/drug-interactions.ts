/**
 * Phase 13 §9 R6: medication rules per drug and formulation, not one rule per drug class. The
 * `maoi` profile's `target_modifiers.label_list` said, in prose, "match the specific drug's
 * label list in code" — this module is that code (§9 R5: prose converted to typed rules). An
 * unknown drug or formulation always stays `unverified`; it is never guessed from the class.
 * Pure: no I/O.
 */
import type { ProfileInstance } from "@/lib/policy/profiles/types";

export type DrugFinding =
  | { outcome: "unknown"; text: string }
  | { outcome: "present" | "absent"; text: string };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function hasWord(text: string, word: string): boolean {
  return new RegExp(`(^|[^a-z])${escape(word.toLowerCase())}([^a-z]|$)`).test(text.toLowerCase());
}

/**
 * The FDA label tyramine-restriction list differs by drug (§9 R6). Phenelzine's list is the
 * one the map's `maoi` profile citations name directly (DailyMed); tranylcypromine's product
 * label additionally names sauerkraut and soy sauce/fermented soy and omits phenelzine's
 * "yogurt"/"fava pods" wording — the two are deliberately not the same list.
 */
export const MAOI_DRUGS = ["phenelzine", "tranylcypromine"] as const;
export type MaoiDrug = (typeof MAOI_DRUGS)[number];

export const MAOI_TYRAMINE_LISTS: Record<MaoiDrug, { keywords: readonly string[]; citation: string }> = {
  phenelzine: {
    citation: "dailymed_phenelzine",
    keywords: [
      "aged cheese", "cheese", "pickled herring", "beer", "wine", "liver", "yeast extract",
      "dry sausage", "fava pod", "fava pods", "yogurt",
    ],
  },
  tranylcypromine: {
    citation: "maoi_2012",
    keywords: [
      "aged cheese", "cheese", "cured meat", "pepperoni", "salami", "tap beer", "red wine",
      "sauerkraut", "soy sauce", "tofu", "fermented soy", "fava pod", "fava pods",
    ],
  },
};

/** Alcohol and excess caffeine/chocolate are on every MAOI label, not just phenelzine's. */
const MAOI_ALCOHOL_KEYWORDS = ["beer", "wine", "spirits", "liqueur", "alcohol"];

/**
 * `drug` outside `MAOI_TYRAMINE_LISTS` (isocarboxazid, "unknown", a typo) stays `unverified` —
 * never falls back to a generic MAOI list, because the map's own audit finding is that the lists
 * differ by label.
 */
export function maoiTyramineFinding(drug: string, ingredientsText: string | null): DrugFinding {
  const list = Object.hasOwn(MAOI_TYRAMINE_LISTS, drug) ? MAOI_TYRAMINE_LISTS[drug as MaoiDrug] : undefined;
  if (!list) return { outcome: "unknown", text: "Unknown MAOI — check with your pharmacist" };
  if (!ingredientsText || ingredientsText.trim() === "") {
    return { outcome: "unknown", text: "Check with your pharmacist" };
  }
  const present = list.keywords.some((word) => hasWord(ingredientsText, word))
    || MAOI_ALCOHOL_KEYWORDS.some((word) => hasWord(ingredientsText, word));
  return present
    ? { outcome: "present", text: "Contains a tyramine-restricted ingredient for this MAOI" }
    : { outcome: "unknown", text: "Check with your pharmacist" };
}

/**
 * Oral bisphosphonate dosing timing differs by drug AND formulation (§9 R6): risedronate alone
 * has two, immediate- and delayed-release (Atelvia), with opposite instructions (before food vs.
 * immediately after breakfast). The Atelvia card also separates calcium, antacids and iron from
 * the dose — those divalent minerals block absorption the same way food does, on top of its own
 * timing (map profile `bisphosphonate`, FDA Atelvia label).
 */
export const BISPHOSPHONATE_FORMULATIONS = [
  "alendronate_tablet", "risedronate_immediate_release", "risedronate_delayed_release_atelvia",
  "ibandronate_oral",
] as const;
export type BisphosphonateFormulation = (typeof BISPHOSPHONATE_FORMULATIONS)[number];

export type BisphosphonateTiming = {
  instructions: string;
  /** Ingredients/products to take at a different time than the dose, on top of the timing above. */
  separateFrom: readonly string[];
  citation: string;
};

export const BISPHOSPHONATE_TIMING: Record<BisphosphonateFormulation, BisphosphonateTiming> = {
  alendronate_tablet: {
    citation: "ml_alendronate", separateFrom: [],
    instructions: "First thing in the morning, with 6-8 oz plain water. Nothing else to eat, "
      + "drink, or take for at least 30 minutes. Stay upright until after your first food.",
  },
  risedronate_immediate_release: {
    citation: "ml_alendronate", separateFrom: [],
    instructions: "At least 30 minutes before your first food or drink of the day, with 6-8 oz "
      + "plain water. Stay upright for 30 minutes.",
  },
  risedronate_delayed_release_atelvia: {
    citation: "fda_atelvia_label", separateFrom: ["calcium", "antacids", "iron"],
    instructions: "Immediately after breakfast, with at least 4 oz plain water. Swallow whole "
      + "while upright, and do not lie down for 30 minutes. Take calcium, antacids and iron "
      + "supplements at a different time from this dose — they can block how much you absorb.",
  },
  ibandronate_oral: {
    citation: "fda_boniva_label", separateFrom: [],
    instructions: "60 minutes before food, drink, or any other medicine, with plain water. Stay "
      + "upright for 60 minutes.",
  },
};

export type BisphosphonateCard =
  | { known: true; formulation: BisphosphonateFormulation; timing: BisphosphonateTiming }
  | { known: false; text: "No timing advice until the exact product is known" };

/** `formulation` outside the table (a drug named but not the exact product) stays unknown; the
 *  map's own `unknown_drug` field says "no timing advice until the exact product is known". */
export function bisphosphonateCard(formulation: string): BisphosphonateCard {
  const timing = Object.hasOwn(BISPHOSPHONATE_TIMING, formulation)
    ? BISPHOSPHONATE_TIMING[formulation as BisphosphonateFormulation] : undefined;
  return timing
    ? { known: true, formulation: formulation as BisphosphonateFormulation, timing }
    : { known: false, text: "No timing advice until the exact product is known" };
}

/**
 * sol FIX (p13-s3 fix round): the per-drug functions above, reached from a built profile. The
 * instance's own `drug` (lib/policy/profiles/loader.ts `buildProfileInstance`) picks the label
 * list or timing card; an instance with no drug, or one outside the tables, stays unverified.
 * Returns null for a profile whose guidance is not per drug.
 */
export function medicationTimingCard(instance: ProfileInstance): BisphosphonateCard | null {
  return instance.profileId === "bisphosphonate" ? bisphosphonateCard(instance.drug ?? "") : null;
}

export function medicationFoodFinding(
  instance: ProfileInstance,
  ingredientsText: string | null,
): DrugFinding | null {
  return instance.profileId === "maoi" ? maoiTyramineFinding(instance.drug ?? "", ingredientsText) : null;
}
