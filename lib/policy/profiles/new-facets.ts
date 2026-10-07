/**
 * Phase 13 §4/§5.2, §9 R5: deterministic evaluators for `NEW_FACETS`
 * (lib/foods/facet-vocabulary.ts) — the map's first-value-order facets, not yet wired into the
 * Jev rubric-v1 pipeline (see that file's comment for why). Pure: no I/O, no Jev call.
 *
 * Every evaluator returns "present" only on a positive match against evidence the food itself
 * carries (ingredient/description keywords, or a measured nutrient); it never returns "absent"
 * from missing text, because a keyword miss does not prove a food's absence of a property the
 * way a complete, legally-mandated ingredient list can for an allergen (lib/policy/allergens.ts
 * owns that stronger claim). The one deliberate exception is `high_listeria_risk`: the map's own
 * rubric says "when preparation is not stated, answer as if unheated", so an unstated risk
 * category food stays "present" rather than "unknown".
 */
import type { NutrientCode } from "@/lib/nutrients/codes";
import type { NewFacet } from "@/lib/foods/facet-vocabulary";
import type { FacetOutcome } from "@/lib/policy/facet-rules";

export type NewFacetInput = {
  /** Name, brand, description and ingredient text, already concatenated. Case is ignored. */
  text: string;
  /** True only when the food's own text states it is fully cooked, heated, or pasteurized. */
  statedFullyCooked?: boolean;
  nutrientsPerServing?: Readonly<Partial<Record<NutrientCode, number>>>;
};

type KeywordRule = {
  kind: "keyword";
  /** A named match: always "present", whatever `exclusions` also hits. */
  present: readonly string[];
  /** A broad word (high_mercury_fish's bare "tuna") that `exclusions` may clear. */
  generic?: readonly string[];
  /** Checked after `present` and before `generic`: a hit forces "absent" over a generic word. */
  exclusions?: readonly string[];
  /** high_listeria_risk only: an unstated preparation counts as present, per the map's rubric. */
  defaultPresentUnlessCooked?: boolean;
};

type NutrientRule = {
  kind: "nutrient";
  code: NutrientCode;
  /** >= this value is present. */
  highAt: number;
  /** <= this value is absent; between the two is unknown. */
  lowAt: number;
};

type ProteinDensityRule = { kind: "protein_density"; highAt: number; lowAt: number };

type NewFacetRule = KeywordRule | NutrientRule | ProteinDensityRule;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function hasWord(text: string, word: string): boolean {
  return new RegExp(`(^|[^a-z])${escape(word)}([^a-z]|$)`).test(text);
}

const RULES: Record<NewFacet, NewFacetRule> = {
  red_meat: { kind: "keyword", present: [
    "beef", "veal", "pork", "ham", "bacon", "lamb", "mutton", "goat", "venison", "deer",
    "bison", "rabbit", "horsemeat", "horse meat", "cattle", "steak", "brisket",
  ] },
  poultry: { kind: "keyword", present: ["chicken", "turkey", "duck", "goose", "quail", "poultry"] },
  processed_meat: { kind: "keyword", present: [
    "bacon", "ham", "sausage", "hot dog", "hotdog", "salami", "pepperoni", "deli meat",
    "luncheon meat", "corned beef", "jerky", "pastrami", "chorizo", "prosciutto",
  ] },
  raw_or_undercooked_animal: { kind: "keyword", present: [
    "sashimi", "tartare", "ceviche", "raw oyster", "raw egg", "runny egg", "rare burger",
    "cookie dough", "raw cookie dough", "homemade mayo", "homemade caesar",
  ] },
  unpasteurized: { kind: "keyword", present: [
    "raw milk", "unpasteurized", "unpasteurised", "raw-milk cheese", "raw milk cheese",
    "unpasteurized juice", "unpasteurized cider", "raw cider",
  ] },
  high_listeria_risk: { kind: "keyword", defaultPresentUnlessCooked: true, present: [
    "deli meat", "cold cut", "hot dog", "dry sausage", "fermented sausage", "deli-sliced cheese",
    "deli sliced cheese", "deli salad", "pate", "pâté", "meat spread", "smoked fish",
    "queso fresco", "queso blanco", "requeson", "requesón", "raw-milk cheese", "raw milk",
    "sprouts", "enoki", "cut melon",
  ] },
  high_mercury_fish: { kind: "keyword", exclusions: [
    "canned light tuna", "skipjack", "canned tuna", "albacore", "yellowfin",
  ], present: [
    "king mackerel", "marlin", "orange roughy", "shark", "swordfish", "tilefish", "bigeye tuna",
    "bigeye",
  ], generic: ["tuna"] },
  ultra_processed: { kind: "keyword", present: [
    "high fructose corn syrup", "hydrogenated oil", "emulsifier", "artificial flavor",
    "artificial flavour", "protein isolate", "modified starch", "instant noodle",
    "soda", "packaged snack",
  ] },
  high_sodium: { kind: "nutrient", code: "sodium", highAt: 460, lowAt: 140 },
  // sugars_total is the best-available proxy: the catalog has no separate added-sugars code
  // (lib/nutrients/codes.ts). This over-counts naturally-occurring sugar in whole fruit/dairy;
  // documented as a known approximation, not a fix for this slice.
  added_sugar: { kind: "nutrient", code: "sugars_total", highAt: 10, lowAt: 5 },
  protein_dense: { kind: "protein_density", highAt: 10, lowAt: 5 },
};

export function evaluateNewFacet(facet: NewFacet, input: NewFacetInput): FacetOutcome {
  const rule = RULES[facet];
  if (rule.kind === "nutrient") return nutrientOutcome(input, rule);
  if (rule.kind === "protein_density") return proteinDensityOutcome(input, rule);
  return keywordOutcome(input, rule);
}

function keywordOutcome(input: NewFacetInput, rule: KeywordRule): FacetOutcome {
  const text = input.text.toLowerCase();
  const hits = (words: readonly string[] | undefined) => (words ?? []).some((w) => hasWord(text, w));
  // sol FIX: a named species ("bigeye tuna", "swordfish") is checked before the exclusions, so a
  // broad lower-mercury word elsewhere in the text ("albacore") can never clear it.
  if (hits(rule.present)) {
    return rule.defaultPresentUnlessCooked && input.statedFullyCooked ? "absent" : "present";
  }
  if (hits(rule.exclusions)) return "absent";
  return hits(rule.generic) ? "present" : "unknown";
}

function nutrientOutcome(input: NewFacetInput, rule: NutrientRule): FacetOutcome {
  const value = input.nutrientsPerServing?.[rule.code];
  if (value === undefined || !Number.isFinite(value)) return "unknown";
  if (value >= rule.highAt) return "present";
  if (value <= rule.lowAt) return "absent";
  return "unknown";
}

function proteinDensityOutcome(input: NewFacetInput, rule: ProteinDensityRule): FacetOutcome {
  const protein = input.nutrientsPerServing?.protein;
  const kcal = input.nutrientsPerServing?.energy_kcal ?? input.nutrientsPerServing?.energy_kcal_calc;
  if (protein === undefined || kcal === undefined || !Number.isFinite(protein)
    || !Number.isFinite(kcal) || kcal <= 0) return "unknown";
  const perHundredKcal = (protein / kcal) * 100;
  if (perHundredKcal >= rule.highAt) return "present";
  if (perHundredKcal <= rule.lowAt) return "absent";
  return "unknown";
}
