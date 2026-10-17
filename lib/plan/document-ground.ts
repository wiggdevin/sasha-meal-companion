/**
 * The matched meal's foods, grounded the way the coach grounds a set_slot_meal item: the same food
 * search, the same household-portion fallback for a missing amount, and the same policy check
 * (lib/coach/actions/ground-kit.ts groundNamedFood → checkItemWithMarks), then the full plan pass a
 * coach plan write runs (lib/coach/plan-item-policy.ts: diet flags, confirmed profile hard rules,
 * the human-food check; W014, audit 2026-10-10 A134). Only a food that is found, has a real gram
 * amount and is allowed by every rule of the account is kept; every other one is listed with its
 * reason and left out, never guessed. Port-driven; no I/O of its own.
 */
import { groundNamedFood } from "@/lib/coach/actions/ground-kit";
import { judgePlanFood, type PlanEvidencePort } from "@/lib/coach/plan-item-policy";
import { loadSuggestionEvidence } from "@/lib/coach/suggest-policy";
import { profileRuleFacets } from "@/lib/policy/profiles/account-rules";
import type { GroundedActionItem } from "@/lib/coach/actions/fields";
import type { FoodHit } from "@/lib/coach/executors";
import type { ConstraintProfile } from "@/lib/policy/constraints";
import { isWeightUnit, labelHasMeasure, parseAmount, type ParsedAmount } from "@/lib/plan/document-clean";
import type { DocumentFood, DocumentMeal, LeftOutFood } from "@/lib/plan/document-types";
import type { Macros } from "@/lib/types";

/** set_slot_meal takes at most this many items. */
export const MAX_PLACED_ITEMS = 8;

export type DocumentGroundPorts = {
  searchFoods: (userId: string, query: string, limit: number) => Promise<FoodHit[]>;
  /** The full policy evidence of the grounded foods; default loadSuggestionEvidence. */
  evidence?: PlanEvidencePort;
};

const CONCENTRATE = /\b(powder|mix|dried|dry|concentrate|instant)\b/i;

/** Units a portion label can be written in that measure the portion rather than count it. */
const AMOUNT_UNITS = /^(ml|millilitres?|milliliters?|l|litres?|liters?)$/;

/**
 * How many units one catalog portion is, from its label. For a measure ("1 cup" against a
 * "1/2 cup" portion) the label is in that same measure, so its number counts it: a cup is twice
 * the portion. For a plain count ("2", or no amount) the label's number counts household units
 * only: "2 slices" is two slices, but a "100 g" or "250 ml" portion is ONE portion of that weight,
 * so "2" is two portions (200 g), never 2/100 of one. 1 when the label has no number.
 */
export function labelQuantity(label: string, measured: boolean): number {
  const text = label.trim().toLowerCase().replace(/(\d)([a-z])/g, "$1 $2");
  const read = leadingNumber(text);
  if (!read) return 1;
  const unit = text.slice(read.length).trim().match(/^[a-z]*/)?.[0] ?? "";
  if (isWeightUnit(unit) || (!measured && AMOUNT_UNITS.test(unit))) return 1;
  return read.value > 0 ? read.value : 1;
}

const VULGAR: Record<string, number> = { "½": 0.5, "¼": 0.25, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3 };

/**
 * The number a label starts with and how many characters it took: "1 1/2" and "1½" are 1.5, "1/2"
 * is 0.5, "2.5" is 2.5 (re-audit r1 #7: "1 1/2 cups" read as 1 placed a 1-cup amount as 1.5).
 */
function leadingNumber(text: string): { value: number; length: number } | null {
  const mixed = text.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)/);
  if (mixed && Number(mixed[3]) > 0) {
    return { value: Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]), length: mixed[0].length };
  }
  const vulgar = text.match(/^(\d+)?\s*([½¼¾⅓⅔])/);
  if (vulgar) return { value: Number(vulgar[1] ?? 0) + VULGAR[vulgar[2]], length: vulgar[0].length };
  const fraction = text.match(/^(\d+)\s*\/\s*(\d+)/);
  if (fraction && Number(fraction[2]) > 0) {
    return { value: Number(fraction[1]) / Number(fraction[2]), length: fraction[0].length };
  }
  const decimal = text.match(/^\d+(?:\.\d+)?/);
  return decimal ? { value: Number(decimal[0]), length: decimal[0].length } : null;
}

/** The hit and grams for one food, or why there are none. */
function sized(hits: FoodHit[], amount: ParsedAmount): { hit: FoodHit; grams: number } | { reason: string } {
  const usable = hits.filter((row) => row.foodRefId !== null);
  if (usable.length === 0) return { reason: "Not found in the food list" };
  if ("grams" in amount) return { hit: usable[0], grams: amount.grams };
  // A measure binds only to a portion labelled in that same unit, as a whole word (labelHasMeasure).
  const portioned = usable.filter((row) => (row.portionGrams ?? 0) > 0 && (!("measure" in amount)
    || labelHasMeasure(row.portionLabel ?? "", amount.measure)));
  const hit = portioned[0];
  if (!hit) {
    return { reason: "measure" in amount ? `No gram weight for that amount` : "No amount given and no usual portion" };
  }
  const grams = Math.round((hit.portionGrams ?? 0) * amount.count / labelQuantity(hit.portionLabel ?? "", "measure" in amount));
  return { hit, grams };
}

async function groundFood(userId: string, food: DocumentFood, profile: ConstraintProfile,
  ports: DocumentGroundPorts): Promise<GroundedActionItem | LeftOutFood> {
  const leave = (reason: string): LeftOutFood => ({ name: food.name, amount: food.amount, reason });
  const amount = food.amountUnreadable ? null : parseAmount(food.amount);
  if (!amount) return leave("Couldn’t read the amount");
  const pick = sized(await ports.searchFoods(userId, food.name, "grams" in amount ? 1 : 3), amount);
  if ("reason" in pick) return leave(pick.reason);
  if (pick.grams <= 0 || pick.grams > 2000) return leave("The amount is out of range");
  const portion = pick.hit.portionGrams ?? 0;
  if (portion > 0 && CONCENTRATE.test(pick.hit.name) && pick.grams > portion * 5) {
    return leave("That amount looks like a drink, not the powder");
  }
  const grounded = await groundNamedFood(userId, food.name, pick.grams, profile,
    { searchFoods: ports.searchFoods, newActionId: () => "" }, pick.hit);
  if (!grounded) return leave("Not found in the food list");
  return { ...grounded, grams: pick.grams };
}

/** The reason a grounded food is left out under every rule of the account, or null to keep it. */
function ruleReason(verdict: GroundedActionItem["verdict"]): string | null {
  if (verdict === "blocked") return "Off your food rules";
  return verdict === "allowed" ? null : "Couldn’t confirm it against your food rules";
}

const per = (value: number | null, grams: number) => (value ?? 0) * grams / 100;

export function itemTotals(items: readonly GroundedActionItem[]): Macros {
  const sum = (pick: (item: GroundedActionItem) => number) =>
    Math.round(items.reduce((total, item) => total + pick(item), 0));
  return {
    kcal: sum((item) => per(item.kcalPer100g, item.grams)),
    protein: sum((item) => per(item.proteinPer100g, item.grams)),
    carbs: sum((item) => per(item.carbsPer100g, item.grams)),
    fat: sum((item) => per(item.fatPer100g, item.grams)),
  };
}

/** Every food of the meal, grounded together; kept items in the meal's order, the rest listed. */
export async function groundDocumentMeal(userId: string, meal: DocumentMeal, profile: ConstraintProfile,
  ports: DocumentGroundPorts): Promise<{ items: GroundedActionItem[]; left: LeftOutFood[] }> {
  const grounded = await Promise.all(meal.foods.map((food) => groundFood(userId, food, profile, ports)));
  const found = grounded.filter((result): result is GroundedActionItem => !("reason" in result));
  const evidence = found.length === 0 ? null : await (ports.evidence ?? loadSuggestionEvidence)(
    userId, found, { needsNoCook: false, facets: profileRuleFacets(profile.profileRules) });
  const results = grounded.map((result, index): GroundedActionItem | LeftOutFood => {
    if ("reason" in result || evidence === null) return result;
    const reason = ruleReason(judgePlanFood(result, evidence, profile).verdict);
    return reason === null ? result : { ...meal.foods[index], reason };
  });
  const items: GroundedActionItem[] = [];
  const left: LeftOutFood[] = [];
  for (const [index, result] of results.entries()) {
    if ("reason" in result) left.push(result);
    else if (items.length < MAX_PLACED_ITEMS) items.push(result);
    else left.push({ ...meal.foods[index], reason: "Only 8 foods fit one meal" });
  }
  return { items, left };
}
