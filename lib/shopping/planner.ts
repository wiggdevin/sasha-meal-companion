import type { RecipeCandidate } from "@/lib/recipe-catalog/types";
import type { IngredientIdentity, ShoppingPeriod, ShoppingPurchaseWindow } from "@/lib/shopping/types";
import { recipeServingFit, suggestedServingFraction } from "@/lib/recipes/adapt";
import { occasionFit } from "@/lib/recipes/occasion";
import type { Occasion } from "@/lib/meals/occasion";
import { recipeTastePoints, type TasteValues } from "@/lib/meals/preference";
import {
  aggregateShopping, identityKey, packageBuyGrams, type AggregateOptions, type RecipeUse, type ShoppingAggregation,
} from "@/lib/shopping/aggregate";

/** The same normalized identity `lib/meals/parts.ts`'s `foodKey` gives a plate row's food. */
const ingredientKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, " ");

/** `targetProtein` (grams) adds the protein-shortfall term to the fit (audit S3); null skips it. */
export type PlanSlot = { localDate: string; slotId: string; targetKcal: number | null;
  targetProtein?: number | null;
  /**
   * The slot's meal, read off its clock on that date (lib/shopping/coverage.ts). Recipes whose
   * dish tags name that meal are preferred; a slot with no fitting recipe still gets the best one,
   * and the preview says so (Phase 17 O4). Absent: no meal-type preference.
   */
  occasion?: Occasion };

/** The weight of a recipe's meal type in a slot's score: above a pin, below nothing hard. */
export const OCCASION_WEIGHT = 20;
const mealName = (slotId: string) => `Meal ${slotId.slice(5)}`;
/** A slot whose recipe the user already accepted. It is planned as-is, never re-chosen. */
export type KeptSlot = { localDate: string; slotId: string; recipe: RecipeCandidate;
  servingFraction: number; selectionId: string };
export type PlannerInput = {
  period: ShoppingPeriod;
  slots: readonly PlanSlot[];
  /** Accepted selections: they buy their ingredients but take no candidate choice. */
  kept?: readonly KeptSlot[];
  candidates: readonly RecipeCandidate[];
  /**
   * Recipe ids the user said No to (the "Have AI build my list" meal walk). They are dropped from
   * `candidates` before any score; this only removes, never admits. Absent or empty: unchanged.
   */
  excludeRecipeIds?: readonly string[];
  basket: readonly IngredientIdentity[];
  pins: readonly IngredientIdentity[];
  aggregate: AggregateOptions;
  /** Each recipe revision's confirmed equipment requirements. */
  requiredEquipmentByRevision?: Readonly<Record<string, readonly string[]>>;
  availableEquipment?: readonly string[];
  favoriteRecipeIds?: readonly string[];
  existingPurchaseWindows?: readonly ShoppingPurchaseWindow[];
  /**
   * D8's caller table ("Recipe search, the coach and the shopping planner"): when the account's
   * quantized pref-2 values are available, `RECIPE_TASTE_POINTS × (T − 1)` over a candidate's
   * ingredients by grams adds to its score. Absent (no caller wires this up yet): no term at all.
   */
  taste?: TasteValues;
};
export type PlanChoice = RecipeUse & { candidateRevisionId: string;
  servingFraction: number; preparedOn: string; reuseLimitDays: 3; storageGuidance: string;
  /** Set on a kept accepted selection; such a choice is its own one-slot batch. */
  keptSelectionId?: string;
  /**
   * Served protein minus the slot's protein target, in grams (negative is short); null when the
   * slot has no protein target, the recipe's protein is unknown, or the choice was kept as-is.
   */
  proteinGapGrams?: number | null };
export type PlanWindow = { startDate: string; endDate: string; kind: "weekly" | "remainder" };
export type PlanPreview = {
  choices: PlanChoice[];
  shopping: ShoppingAggregation;
  windows: PlanWindow[];
  replenishment: { window: PlanWindow; lines: { lineId: string; needGrams: number | null;
    confirmedStockGrams: number | null; buyGrams: number | null; checked: boolean;
    note: string | null; revision: number }[] }[];
  unmetPins: string[];
  unfilledSlots: { localDate: string; slotId: string; reasons: string[] }[];
  proposedAdditions: string[];
  compromise: string[];
};

const heat = /\b(bake|boil|broil|fry|heat|microwave|roast|saut[eé]|simmer|steam|stovetop|toast|cook)\b/i;
const roundServings = (value: number) => Math.round(value * 10_000) / 10_000;
const dayNumber = (date: string) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
const dateAt = (day: number) => new Date(day * 86_400_000).toISOString().slice(0, 10);

export function periodWindows(period: ShoppingPeriod): PlanWindow[] {
  const first = dayNumber(period.startDate);
  const last = dayNumber(period.endDate);
  if (!Number.isFinite(first) || !Number.isFinite(last) || dateAt(first) !== period.startDate
    || dateAt(last) !== period.endDate || last < first || last - first > 30) {
    throw new RangeError("Shopping period must be a valid 1 to 31 day date range");
  }
  const result: PlanWindow[] = [];
  for (let day = first; day <= last; day += 7) {
    result.push({ startDate: dateAt(day), endDate: dateAt(Math.min(day + 6, last)),
      kind: day + 6 <= last ? "weekly" : "remainder" });
  }
  return result;
}

function ingredientsOf(candidate: RecipeCandidate, identityFor: AggregateOptions["identityFor"]):
  (IngredientIdentity | null)[] {
  return candidate.ingredients.map(identityFor);
}

function hardReason(input: PlannerInput, candidate: RecipeCandidate,
  identities: readonly (IngredientIdentity | null)[]): string | null {
  if (candidate.eligibility.status !== "eligible") {
    return candidate.eligibility.reasons[0]?.message ?? "Recipe is not eligible.";
  }
  if (input.period.effort === "none" && (candidate.effort !== "none"
    || candidate.steps.some((step) => heat.test(step.text)))) return "This plan allows no cooking.";
  if (input.period.effort === "minimal" && candidate.effort === "standard") {
    return "This recipe exceeds the selected cooking effort.";
  }
  if (input.period.maxActiveMinutes !== null
    && (candidate.activeMinutes === null || candidate.activeMinutes > input.period.maxActiveMinutes)) {
    return "Active cooking time exceeds the limit or is unknown.";
  }
  const equipment = new Set(input.availableEquipment ?? []);
  if ((input.requiredEquipmentByRevision?.[candidate.revisionId] ?? [])
    .some((item) => !equipment.has(item))) return "Required cooking equipment is unavailable.";
  if (input.period.lockMode !== "none") {
    const allowed = new Set(input.basket.map(identityKey));
    for (const stock of input.aggregate.pantry ?? []) {
      if (stock.userId === input.period.userId && stock.confirmedGrams !== null
        && stock.confirmedGrams > 0) allowed.add(identityKey(stock.identity));
    }
    if (identities.some((identity) => !identity || !allowed.has(identityKey(identity)))) {
      return "A required ingredient, including seasoning, is outside the locked basket and pantry.";
    }
  }
  return null;
}

function scoreCandidate(input: PlannerInput, candidate: RecipeCandidate,
  slot: PlanSlot, identities: readonly (IngredientIdentity | null)[],
  chosen: readonly PlanChoice[], unfilledPins: ReadonlySet<string>,
  incrementalCheckout: number | null): number {
  const basket = new Set(input.basket.map(identityKey));
  const already = new Set(chosen.flatMap((use) => ingredientsOf(use.recipe as RecipeCandidate,
    input.aggregate.identityFor).filter((identity): identity is IngredientIdentity => identity !== null)
    .map(identityKey)));
  const keys = identities.filter((identity): identity is IngredientIdentity => identity !== null).map(identityKey);
  const fraction = suggestedServingFraction(candidate, slot.targetKcal);
  // Calories AND protein (audit S3): a protein-poor recipe at the right kcal no longer wins.
  const servingFit = recipeServingFit(candidate, fraction, slot.targetKcal, slot.targetProtein);
  const fit = servingFit.kcalFit * servingFit.proteinFit;
  const pinBonus = keys.filter((key) => unfilledPins.has(key)).length * 20;
  const repeat = chosen.filter((use) => use.recipe.revisionId === candidate.revisionId).length;
  const varietyPenalty = input.period.variety === "high" ? repeat * 8
    : input.period.variety === "balanced" ? repeat * 3 : 0;
  const simplePenalty = input.period.mode === "simple" ? (candidate.activeMinutes ?? 60) / 15 : 0;
  const costPenalty = incrementalCheckout === null ? 0
    : Math.min(5, incrementalCheckout / Math.max(1, input.period.budgetAmount ?? 20) * 5);
  const occasion = slot.occasion ? occasionFit(candidate, slot.occasion) * OCCASION_WEIGHT : 0;
  const taste = input.taste
    ? recipeTastePoints(candidate.ingredients.map((ingredient) => ({
      key: ingredientKey(ingredient.name), amount: ingredient.grams ?? 0,
    })), input.taste, slot.occasion ?? null)
    : 0;
  return occasion + fit * 10 + pinBonus + keys.filter((key) => basket.has(key)).length * 3
    + keys.filter((key) => already.has(key)).length * 2
    - keys.filter((key) => !basket.has(key) && !already.has(key)).length * 2
    + (input.favoriteRecipeIds?.includes(candidate.recipeId) ? 1 : 0) + taste
    + (input.period.variety === "repeat_friendly" ? repeat * 2 : 0)
    - varietyPenalty - simplePenalty - costPenalty;
}

function replenishmentByWindow(windows: readonly PlanWindow[], shopping: ShoppingAggregation,
  pantry: readonly NonNullable<AggregateOptions["pantry"]>[number][],
  existing: readonly ShoppingPurchaseWindow[], userId: string): PlanPreview["replenishment"] {
  const rows = windows.map((window) => ({ window, lines: [] as PlanPreview["replenishment"][number]["lines"] }));
  for (const line of shopping.lines.filter((item) => item.origin === "plan" && item.identity)) {
    const key = identityKey(line.identity!);
    let remaining = pantry.filter((item) => item.userId === userId
      && identityKey(item.identity) === key && item.confirmedGrams !== null)
      .reduce((sum, item) => sum + Math.max(0, item.confirmedGrams ?? 0), 0);
    for (const row of rows) {
      const sources = line.sources.filter((source) => source.localDate >= row.window.startDate
        && source.localDate <= row.window.endDate);
      if (!sources.length) continue;
      const needGrams = sources.some((source) => source.requiredGrams === null) ? null
        : roundServings(sources.reduce((sum, source) => sum + source.requiredGrams!, 0));
      const confirmedStockGrams = needGrams === null ? null : Math.min(needGrams, remaining);
      if (confirmedStockGrams !== null) remaining = roundServings(remaining - confirmedStockGrams);
      const net = needGrams === null || confirmedStockGrams === null ? null
        : roundServings(Math.max(0, needGrams - confirmedStockGrams));
      const buyGrams = net === null ? null : packageBuyGrams(net, line.packageGrams);
      const prior = existing.find((item) => item.lineId === line.id
        && item.windowStartDate === row.window.startDate);
      const preserve = prior && needGrams !== null && prior.needGrams !== null
        && needGrams <= prior.needGrams
        && (buyGrams === null ? prior.buyGrams === null
          : prior.buyGrams === null || buyGrams <= prior.buyGrams);
      row.lines.push({ lineId: line.id, needGrams, confirmedStockGrams, buyGrams,
        checked: Boolean(preserve && prior?.checked), note: preserve ? prior?.note ?? null : null,
        revision: prior?.revision ?? 0 });
    }
  }
  return rows;
}

/** Deterministic whole-period preview. Slots share one stock and purchase calculation. */
export function planShoppingPeriod(input: PlannerInput): PlanPreview {
  if (!input.period.userId) throw new Error("Account identity is required");
  const windows = periodWindows(input.period);
  const slots = [...input.slots].sort((a, b) => a.localDate.localeCompare(b.localDate)
    || a.slotId.localeCompare(b.slotId));
  const keptKeys = new Set((input.kept ?? []).map((row) => `${row.localDate}:${row.slotId}`));
  if (slots.some((slot) => keptKeys.has(`${slot.localDate}:${slot.slotId}`))) {
    throw new RangeError("A kept slot cannot also be planned");
  }
  const chosen: PlanChoice[] = [...(input.kept ?? [])]
    .sort((a, b) => a.localDate.localeCompare(b.localDate) || a.slotId.localeCompare(b.slotId))
    .map((row) => {
      if (row.localDate < input.period.startDate || row.localDate > input.period.endDate) {
        throw new RangeError("Kept slot is outside the shopping period");
      }
      return { recipe: row.recipe, localDate: row.localDate, slotId: row.slotId,
        servingsConsumed: roundServings(input.period.people * row.servingFraction),
        servingFraction: row.servingFraction, batchId: `kept:${row.selectionId}`,
        candidateRevisionId: row.recipe.revisionId, preparedOn: row.localDate,
        reuseLimitDays: 3 as const, keptSelectionId: row.selectionId, proteinGapGrams: null,
        storageGuidance: "Your accepted recipe for this meal, kept as you chose it." };
    });
  const unfilledSlots: PlanPreview["unfilledSlots"] = [];
  const pinKeys = new Set(input.pins.map(identityKey));
  for (const use of chosen) {
    for (const identity of ingredientsOf(use.recipe as RecipeCandidate, input.aggregate.identityFor)) {
      if (identity) pinKeys.delete(identityKey(identity));
    }
  }
  const reasons = new Set<string>();
  const proteinShort: string[] = [];
  const excluded = new Set(input.excludeRecipeIds ?? []);
  const candidates = excluded.size
    ? input.candidates.filter((candidate) => !excluded.has(candidate.recipeId)) : input.candidates;
  for (const slot of slots) {
    if (slot.localDate < input.period.startDate || slot.localDate > input.period.endDate) {
      throw new RangeError("Plan slot is outside the shopping period");
    }
    const ranked: { recipe: RecipeCandidate; score: number }[] = [];
    const slotReasons = new Set<string>();
    const baselinePrice = aggregateShopping(input.period, chosen, input.aggregate)
      .price.estimatedCheckoutAmount;
    for (const candidate of candidates) {
      const identities = ingredientsOf(candidate, input.aggregate.identityFor);
      const hard = hardReason(input, candidate, identities);
      if (hard) { slotReasons.add(hard); continue; }
      const use: RecipeUse = { recipe: candidate, localDate: slot.localDate, slotId: slot.slotId,
        servingsConsumed: roundServings(input.period.people
          * suggestedServingFraction(candidate, slot.targetKcal)),
        batchId: null };
      const preview = aggregateShopping(input.period, [...chosen, use], input.aggregate);
      if (input.period.lockMode === "available_quantities") {
        if (preview.lines.some((line) => line.origin === "plan"
          && (line.buyGrams === null || line.buyGrams > 0))) {
          slotReasons.add("Confirmed pantry quantity is insufficient or unknown.");
          continue;
        }
      }
      const trialPrice = preview.price.estimatedCheckoutAmount;
      const incrementalCheckout = baselinePrice === null || trialPrice === null
        ? null : Math.max(0, trialPrice - baselinePrice);
      ranked.push({ recipe: candidate,
        score: scoreCandidate(input, candidate, slot, identities, chosen, pinKeys,
          incrementalCheckout) });
    }
    ranked.sort((a, b) => b.score - a.score
      || a.recipe.revisionId.localeCompare(b.recipe.revisionId));
    const best = ranked[0]?.recipe;
    if (!best) {
      const listed = [...slotReasons];
      unfilledSlots.push({ localDate: slot.localDate, slotId: slot.slotId,
        reasons: listed.length ? listed : ["No eligible complete recipe is available."] });
      listed.forEach((entry) => reasons.add(entry));
      continue;
    }
    // A prepared batch is held for at most three calendar days and cannot cross a
    // fresh weekly shopping window. Longer reuse needs recipe-specific storage proof.
    const currentDay = dayNumber(slot.localDate);
    const currentWindow = Math.floor((currentDay - dayNumber(input.period.startDate)) / 7);
    const servingFraction = suggestedServingFraction(best, slot.targetKcal);
    const { proteinGapGrams, proteinFit } = recipeServingFit(best, servingFraction, slot.targetKcal,
      slot.targetProtein);
    if (proteinGapGrams === null && slot.targetProtein) {
      proteinShort.push(`${best.name}'s protein is not measured, so ${slot.localDate} ${slot.slotId} may be short.`);
    } else if (proteinGapGrams !== null && slot.targetProtein && proteinFit < 1) {
      proteinShort.push(`${best.name} is ${Math.abs(proteinGapGrams)} g short of the protein for ${slot.localDate} ${slot.slotId}.`);
    }
    const servingsConsumed = roundServings(input.period.people * servingFraction);
    // Judge each batch by its FIRST row (audit A046): a later row of an older batch is never the
    // way in, or the batch would outlive its storage window.
    const prior = chosen.find((use) => {
      if (use.recipe.revisionId !== best.revisionId || use.batchId === null || use.keptSelectionId) {
        return false;
      }
      const batch = chosen.filter((row) => row.batchId === use.batchId);
      if (batch[0] !== use) return false;
      const firstDay = dayNumber(use.localDate);
      return currentDay - firstDay <= 2
        && Math.floor((firstDay - dayNumber(input.period.startDate)) / 7) === currentWindow
        && batch.reduce((sum, row) => sum + row.servingsConsumed, 0) + servingsConsumed <= best.servings;
    });
    const batchId = prior?.batchId ?? `${input.period.id}:${slot.localDate}:${slot.slotId}:${best.revisionId}`;
    // Said only when no feasible recipe of the slot's meal type existed: a fitting recipe that
    // lost on pins, basket or cost is a ranking choice, not a missing breakfast.
    const occasion = slot.occasion;
    if (occasion && occasion !== "other"
      && !ranked.some((row) => occasionFit(row.recipe, occasion) >= 0.5)) {
      reasons.add(`No ${slot.occasion} recipe fit ${mealName(slot.slotId)} on ${slot.localDate}; it gets ${best.name} instead.`);
    }
    chosen.push({ recipe: best, localDate: slot.localDate, slotId: slot.slotId,
      servingsConsumed, servingFraction, proteinGapGrams, batchId, candidateRevisionId: best.revisionId,
      preparedOn: prior?.preparedOn ?? slot.localDate, reuseLimitDays: 3,
      storageGuidance: "This plan reuses a prepared batch for at most three calendar days within one shopping week. Follow the recipe's storage instructions." });
    for (const identity of ingredientsOf(best, input.aggregate.identityFor)) {
      if (identity) pinKeys.delete(identityKey(identity));
    }
  }
  const shopping = aggregateShopping(input.period, chosen, input.aggregate);
  const basket = new Set(input.basket.map(identityKey));
  const pantry = new Set((input.aggregate.pantry ?? [])
    .filter((item) => item.userId === input.period.userId && (item.confirmedGrams ?? 0) > 0)
    .map((item) => identityKey(item.identity)));
  const proposedAdditions = input.period.lockMode === "none"
    ? shopping.lines.filter((line) => line.identity && line.origin === "plan"
      && !basket.has(identityKey(line.identity)) && !pantry.has(identityKey(line.identity)))
      .map((line) => line.name) : [];
  const compromise = [...reasons, ...proteinShort];
  if (pinKeys.size) compromise.push("Some pinned ingredients could not be used without changing the plan or rules.");
  if (input.period.budgetAmount !== null && shopping.price.budgetMet === null) {
    compromise.push("Price coverage is incomplete; the budget cannot be confirmed.");
  } else if (shopping.price.budgetMet === false) {
    compromise.push("Estimated checkout cost exceeds the selected budget.");
  }
  return { choices: chosen, shopping, windows,
    replenishment: replenishmentByWindow(windows, shopping, input.aggregate.pantry ?? [],
      input.existingPurchaseWindows ?? [], input.period.userId), unmetPins: [...pinKeys],
    unfilledSlots, proposedAdditions, compromise };
}
