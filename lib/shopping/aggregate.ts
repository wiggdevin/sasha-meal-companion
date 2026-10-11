import type { CatalogRecipe, RecipeIngredient } from "@/lib/recipe-catalog/types";
import type {
  IngredientIdentity, PantryItem, ShoppingLine, ShoppingPeriod, ShoppingSource,
} from "@/lib/shopping/types";
import { purchaseMassGrams } from "./purchase-mass";

export type RecipeUse = {
  recipe: CatalogRecipe;
  localDate: string;
  slotId: string;
  /** Number of recipe servings eaten in this slot, across the period's people. */
  servingsConsumed: number;
  /** Shared cooked batch identifier. Equal IDs buy ingredients once across leftovers. */
  batchId: string | null;
};
export type PackageOption = { identity: IngredientIdentity; grams: number };
export type PriceQuote = {
  identity: IngredientIdentity; packageGrams: number; amount: number;
  currency: string; locale: string; source: string; observedAt: string;
};
export type ShoppingDiff = { lineId: string; previousNeedGrams: number | null;
  nextNeedGrams: number | null; additionalNeedGrams: number | null };
export type ShoppingAggregation = {
  lines: ShoppingLine[];
  diff: ShoppingDiff[];
  price: { estimatedCheckoutAmount: number | null; currency: string | null;
    pricedLines: number; requiredLines: number; budgetMet: boolean | null; unknownReasons: string[] };
  issues: string[];
};
export type AggregateOptions = {
  pantry?: readonly PantryItem[];
  existingLines?: readonly ShoppingLine[];
  packages?: readonly PackageOption[];
  prices?: readonly PriceQuote[];
  /** Resolves compatible canonical purchase identity. Unknown variants must remain distinct. */
  identityFor: (ingredient: RecipeIngredient) => IngredientIdentity | null;
  categoryFor?: (ingredient: RecipeIngredient) => ShoppingLine["category"];
};

/**
 * One purchase identity as a map key. An identity with neither a food ref nor a FoodDB id (a pantry
 * photo item the catalog search never resolved, `lib/server/pantry-photo.ts`) gets a key of its own
 * by name: it is never equal to a ref-backed key, so it never counts as stock for a recipe line.
 */
export function identityKey(identity: IngredientIdentity): string {
  if (!identity.foodRefId && !identity.foodDbId) {
    return JSON.stringify(["text", identity.purchaseState, identity.variantKey]);
  }
  return JSON.stringify([identity.foodRefId, identity.foodDbId ?? null,
    identity.catalogFoodRevisionId,
    identity.purchaseState, identity.variantKey]);
}
const round = (value: number) => Math.round(value * 10_000) / 10_000;
/**
 * Whole packages that cover `grams` (audit A018). Both inputs are decimal grams, so an exact
 * multiple can divide to k + 1e-15, and a bought mass is rounded to 4 decimals (up to 0.00005 g
 * off). A remainder under 1 mg is that rounding, never a reason to buy another package.
 */
export function packageCount(grams: number, packageGrams: number): number {
  const ratio = grams / packageGrams;
  const nearest = Math.round(ratio);
  return Math.abs(grams - nearest * packageGrams) < 0.001 ? nearest : Math.ceil(ratio);
}
/** Grams bought as whole packages, or null with no package size. */
export function packageBuyGrams(net: number, packageGrams: number | null): number | null {
  if (net === 0) return 0;
  return packageGrams ? round(packageCount(net, packageGrams) * packageGrams) : null;
}
const conversionRank = { known: 0, estimated: 1, unknown: 2 } as const;
/** Preview-only ID. Persistence assigns a UUID; later previews preserve that UUID by identity. */
const stableLineId = (periodId: string, key: string) => `preview:${periodId}:${key}`;
const sameBatch = (a: RecipeUse, b: RecipeUse) => a.batchId !== null && a.batchId === b.batchId
  && a.recipe.revisionId === b.recipe.revisionId;

/** Build a whole-period list from cooked batches, then reserve confirmed pantry once. */
export function aggregateShopping(
  period: ShoppingPeriod, uses: readonly RecipeUse[], options: AggregateOptions,
): ShoppingAggregation {
  const issues: string[] = [];
  const groupedUses: RecipeUse[][] = [];
  for (const use of uses) {
    if (!(use.servingsConsumed > 0) || !Number.isFinite(use.servingsConsumed)) {
      throw new RangeError("Servings consumed must be positive");
    }
    if (use.localDate < period.startDate || use.localDate > period.endDate) {
      throw new RangeError("Recipe use falls outside this shopping period");
    }
    const group = groupedUses.find((rows) => sameBatch(rows[0], use));
    if (group) {
      const firstDay = Date.parse(`${group[0].localDate}T00:00:00Z`) / 86_400_000;
      const useDay = Date.parse(`${use.localDate}T00:00:00Z`) / 86_400_000;
      const startDay = Date.parse(`${period.startDate}T00:00:00Z`) / 86_400_000;
      if (Math.abs(useDay - firstDay) > 2
        || Math.floor((useDay - startDay) / 7) !== Math.floor((firstDay - startDay) / 7)) {
        throw new RangeError("A prepared batch cannot cross its storage window");
      }
      group.push(use);
    } else groupedUses.push([use]);
  }
  const rows = new Map<string, ShoppingLine>();
  for (const group of groupedUses) {
    const recipe = group[0].recipe;
    if (!(recipe.servings > 0)) throw new RangeError("Recipe yield must be positive");
    // Purchase the selected portions, even when several slots share preparation.
    // Rounding a fractional portion to a whole authored batch would overbuy.
    for (const ingredient of recipe.ingredients) {
      const identity = options.identityFor(ingredient);
      const key = identity ? identityKey(identity)
        : `unresolved:${recipe.revisionId}:${ingredient.seq}`;
      const sourceMasses = group.map((use) => ingredient.purchaseGrams === null
        || ingredient.purchaseConversionStatus === "unknown" ? null
        : purchaseMassGrams(ingredient.purchaseGrams, use.servingsConsumed, recipe.servings));
      const need = sourceMasses.some((mass) => mass === null) ? null
        : round(sourceMasses.reduce<number>((sum, mass) => sum + mass!, 0));
      if (need === null) issues.push(`Raw purchase amount for ${ingredient.name} is unknown.`);
      const sources: ShoppingSource[] = group.map((use, index) => ({
        localDate: use.localDate, slotId: use.slotId, recipeId: recipe.recipeId,
        recipeRevisionId: recipe.revisionId, ingredientSeq: ingredient.seq,
        batchId: use.batchId,
        requiredGrams: sourceMasses[index],
      }));
      const existing = rows.get(key);
      if (existing) {
        existing.needGrams = existing.needGrams === null || need === null
          ? null : round(existing.needGrams + need);
        existing.sources.push(...sources);
        if (ingredient.required) existing.category = "core";
        if (conversionRank[ingredient.purchaseConversionStatus]
          > conversionRank[existing.purchaseConversionStatus]) {
          existing.purchaseConversionStatus = ingredient.purchaseConversionStatus;
        }
      } else {
        rows.set(key, {
          id: stableLineId(period.id, key), periodId: period.id, origin: "plan",
          name: ingredient.name, identity,
          category: options.categoryFor?.(ingredient)
            ?? (ingredient.required ? "core" : "optional_extra"),
          needGrams: need, confirmedStockGrams: null, buyGrams: null,
          packageGrams: null, purchaseConversionStatus: ingredient.purchaseConversionStatus,
          sources, pinned: false, checked: false, note: null, revision: 0,
        });
      }
    }
  }
  const prior = new Map((options.existingLines ?? [])
    .filter((line) => line.periodId === period.id).map((line) => [line.id, line]));
  const priorByIdentity = new Map((options.existingLines ?? [])
    .filter((line) => line.periodId === period.id && line.origin === "plan" && line.identity)
    .map((line) => [identityKey(line.identity!), line]));
  const pantry = new Map<string, number>();
  for (const item of options.pantry ?? []) {
    if (item.userId !== period.userId) continue;
    if (item.confirmedGrams !== null && item.confirmedGrams > 0) {
      const key = identityKey(item.identity);
      pantry.set(key, (pantry.get(key) ?? 0) + item.confirmedGrams);
    }
  }
  const packageByKey = new Map((options.packages ?? [])
    .filter((pack) => pack.grams > 0).map((pack) => [identityKey(pack.identity), pack.grams]));
  const diff: ShoppingDiff[] = [];
  const lines = [...rows.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  for (const line of lines) {
    const key = line.identity ? identityKey(line.identity) : null;
    const priorIdentity = key ? priorByIdentity.get(key) : undefined;
    if (priorIdentity) line.id = priorIdentity.id;
    const available = key ? pantry.get(key) ?? 0 : 0;
    const used = line.needGrams === null ? 0 : Math.min(line.needGrams, available);
    line.confirmedStockGrams = line.needGrams === null ? null : used;
    if (key) pantry.set(key, available - used);
    const net = line.needGrams === null ? null : Math.max(0, round(line.needGrams - used));
    const pricedPackage = key ? (options.prices ?? []).find((quote) =>
      identityKey(quote.identity) === key && quote.packageGrams > 0
      && quote.currency === period.currency && quote.locale === period.locale)?.packageGrams : null;
    line.packageGrams = key ? packageByKey.get(key) ?? pricedPackage ?? null : null;
    line.buyGrams = net === null ? null : packageBuyGrams(net, line.packageGrams);
    const old = prior.get(line.id);
    if (old) {
      const additionalNeedGrams = old.needGrams === null || line.needGrams === null
        ? null : Math.max(0, round(line.needGrams - old.needGrams));
      diff.push({ lineId: line.id, previousNeedGrams: old.needGrams,
        nextNeedGrams: line.needGrams, additionalNeedGrams });
      line.pinned = old.pinned;
      line.note = old.note;
      line.revision = old.revision;
      // A previously checked purchase cannot hide newly increased need.
      line.checked = old.checked && additionalNeedGrams === 0;
    }
  }
  for (const old of options.existingLines ?? []) {
    if (old.periodId !== period.id || old.origin !== "manual") continue;
    lines.push({ ...old, sources: [...old.sources] });
  }
  const required = lines.filter((line) => line.origin === "plan" && (line.buyGrams ?? 1) > 0);
  const priceUnknown: string[] = [];
  let amount = 0;
  let pricedLines = 0;
  for (const line of required) {
    if (!line.identity || line.buyGrams === null || line.purchaseConversionStatus !== "known") {
      priceUnknown.push(`Price or purchase quantity for ${line.name} is not reliable.`);
      continue;
    }
    const lineIdentity = line.identity;
    const quote = (options.prices ?? []).find((candidate) => identityKey(candidate.identity) === identityKey(lineIdentity)
      && candidate.packageGrams > 0 && candidate.amount >= 0 && candidate.source.trim()
      && candidate.observedAt.trim() && candidate.currency === period.currency
      && candidate.locale === period.locale);
    if (!quote) {
      priceUnknown.push(`No sourced local price for ${line.name}.`);
      continue;
    }
    amount += packageCount(line.buyGrams, quote.packageGrams) * quote.amount;
    pricedLines++;
  }
  const complete = priceUnknown.length === 0 && period.currency !== null;
  return {
    lines, diff, issues,
    price: {
      estimatedCheckoutAmount: complete ? round(amount) : null,
      currency: period.currency, pricedLines, requiredLines: required.length,
      budgetMet: complete && period.budgetAmount !== null ? amount <= period.budgetAmount : null,
      unknownReasons: priceUnknown,
    },
  };
}
