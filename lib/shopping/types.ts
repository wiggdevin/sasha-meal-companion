import type { RuleMark } from "@/lib/types";

/** Account-owned period and basket state. Derived requirements pin source revisions. */
export type ShoppingPeriod = {
  id: string;
  userId: string;
  startDate: string;
  endDate: string;
  timezone: string;
  people: number;
  mealCoverage: string[];
  mode: "simple" | "balanced";
  effort: "none" | "minimal" | "standard";
  maxActiveMinutes: number | null;
  variety: "repeat_friendly" | "balanced" | "high";
  budgetAmount: number | null;
  currency: string | null;
  locale: string | null;
  lockMode: "none" | "ingredients" | "available_quantities";
  planRevision: number;
  revision: number;
};
export type IngredientIdentity = {
  /** Same purchase identity only when dietary and preparation variants are compatible. */
  foodRefId: string | null;
  /** Bundled USDA-backed canonical ID when a unique Postgres food ref cannot be resolved. */
  foodDbId?: string | null;
  catalogFoodRevisionId: number | null;
  purchaseState: "raw" | "cooked" | "ready_to_eat" | "as_purchased";
  variantKey: string;
};
export type ShoppingSource = {
  localDate: string;
  slotId: string;
  recipeId: string;
  recipeRevisionId: string;
  ingredientSeq: number;
  batchId: string | null;
  requiredGrams: number | null;
};
export type ShoppingLine = {
  id: string;
  periodId: string;
  origin: "plan" | "manual";
  name: string;
  identity: IngredientIdentity | null;
  category: "core" | "pantry_top_up" | "optional_extra" | "manual";
  needGrams: number | null;
  confirmedStockGrams: number | null;
  buyGrams: number | null;
  packageGrams: number | null;
  purchaseConversionStatus: "known" | "estimated" | "unknown";
  sources: ShoppingSource[];
  pinned: boolean;
  checked: boolean;
  note: string | null;
  revision: number;
  /**
   * Response only, never stored: this line under the account's CURRENT food rules
   * (lib/shopping/rule-marks.ts). Null when it fits or names nothing a rule matches.
   */
  ruleMark?: RuleMark | null;
};
export type PantryItem = {
  id: string;
  userId: string;
  name: string;
  identity: IngredientIdentity;
  confirmedGrams: number | null;
  confirmedAt: string;
  revision: number;
  /** Response only, never stored: same meaning as ShoppingLine.ruleMark. */
  ruleMark?: RuleMark | null;
};

/** One dated, plan-derived purchase requirement. Manual lines stay in ShoppingLine only. */
export type ShoppingPurchaseWindow = {
  id: string;
  periodId: string;
  lineId: string;
  windowStartDate: string;
  windowEndDate: string;
  needGrams: number | null;
  confirmedStockGrams: number | null;
  buyGrams: number | null;
  checked: boolean;
  note: string | null;
  revision: number;
};
