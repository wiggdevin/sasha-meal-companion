import { z } from "zod";
import type { RecipeCandidate, RecipeNutrient } from "@/lib/recipe-catalog/types";
import type { AdaptedLine, AdaptationIssue } from "@/lib/recipes/adapt";
import type { Macros } from "@/lib/types";
import type { PlanPreview } from "./planner";
import type { ShoppingLine, ShoppingPeriod } from "./types";
// Keep this route boundary independent of the CRUD schema module: its periodPatch
// composition is loaded by A's routes and may change without altering preview proof.
const date = z.iso.date();
const id = z.uuid();
const requestId = z.uuid();
const timezone = z.string().min(1).max(80).refine((value) => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; }
  catch { return false; }
});
const identity = z.object({ foodRefId: id.nullable(), foodDbId: z.string().max(120).nullable().optional(),
  catalogFoodRevisionId: z.number().int().positive().nullable(),
  purchaseState: z.enum(["raw", "cooked", "ready_to_eat", "as_purchased"]),
  variantKey: z.string().min(1).max(120) })
  .refine((value) => Boolean(value.foodRefId || value.foodDbId));
const periodDraft = z.object({ startDate: date, endDate: date,
  timezone, people: z.number().int().positive().max(30),
  mealCoverage: z.array(z.string().min(1).max(80)).min(1).max(6),
  mode: z.enum(["simple", "balanced"]), effort: z.enum(["none", "minimal", "standard"]),
  maxActiveMinutes: z.number().int().nonnegative().max(1440).nullable(),
  variety: z.enum(["repeat_friendly", "balanced", "high"]),
  budgetAmount: z.number().nonnegative().max(1_000_000).nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  locale: z.string().max(80).nullable(),
  lockMode: z.enum(["none", "ingredients", "available_quantities"]),
}).strict().refine((row) => row.startDate <= row.endDate
  && (Date.parse(row.endDate) - Date.parse(row.startDate)) / 86_400_000 <= 30);

export const mealSlot = z.enum(["meal-1", "meal-2", "meal-3", "meal-4", "meal-5", "meal-6"]);
export const recipePreviewBody = z.object({ date, slotId: mealSlot,
  servingFraction: z.number().finite().positive().max(2).optional() }).strict();
export const recipePlanBody = z.object({ previewId: id, requestId,
  acceptApproximate: z.boolean() }).strict();
export const shoppingPreviewBody = z.object({ periodId: id.optional(),
  expectedRevision: z.number().int().positive().optional(), draft: periodDraft,
  basket: z.array(identity).max(100),
  // UI makeover W7: recipes the meal walk said No to; the planner only drops them.
  excludeRecipeIds: z.array(id).max(50).optional() }).strict()
  .refine((value) => Boolean(value.periodId) === (value.expectedRevision !== undefined));
export const shoppingAcceptBody = z.object({ previewId: id, requestId }).strict();

export type RecipeAuthority = { targetRevisionId: string; targetRevision: number;
  rulesFingerprint: string; planRevision: number; stateRevision: number };
export type RecipePreviewResult = {
  previewId: string; recipe: RecipeCandidate; servingFraction: number;
  ingredientSnapshot: AdaptedLine[]; nutritionSnapshot: Record<string, RecipeNutrient>;
  gap: Record<keyof Macros, number | null>; mealTarget: Macros | null;
  exactFitAvailable: boolean; approximateFitAvailable: boolean;
  evidenceIssues: AdaptationIssue[]; authority: RecipeAuthority;
  /**
   * This recipe and its adapted lines under the account's CURRENT rules, judged as the selection
   * GET judges an accepted row: null clear, else blocked/unknown. Absent from an older server;
   * treat absence as unknown.
   */
  ruleMark?: import("@/lib/types").RuleMark | null;
  /** The normalized diet flags `ruleMark` was judged under. */
  ruleFlags?: string[];
};
export type AcceptedRecipeSelection = {
  id: string; localDate: string; slotId: string; recipeId: string;
  recipeRevisionId: string; recipeName: string; servingFraction: number;
  ingredientSnapshot: AdaptedLine[]; nutritionSnapshot: Record<string, RecipeNutrient>;
  exactFitAvailable: boolean; approximateFitAvailable: boolean;
  evidenceIssues: AdaptationIssue[]; planRevision: number;
  /** Captured slot before this acceptance; only that older local edit can be reconciled. */
  baselineSwap?: unknown; baselineOverride?: unknown; acceptedAt?: string;
  batchId?: string | null; servingsConsumed?: number;
  preparedOn?: string; reuseLimitDays?: 3; storageGuidance?: string;
  /**
   * The selection GET's verdict under the account's CURRENT rules (2026-10-05 F2): null when the
   * recipe still fits, a mark when it no longer does or cannot be checked. Absent on an eaten slot
   * and on answers that never judged it; the phone then fails closed to unknown.
   */
  ruleMark?: import("@/lib/types").RuleMark | null;
  /** Phone only: the rules epoch its read started in (lib/recipes/accepted-client.ts). */
  ruleMarkEpoch?: number;
  /** Phone only: `foodRulesKey` of the diet flags the GET judged under (absent = never a pass). */
  ruleMarkRulesKey?: string;
  /** Shopping preview only: the accepted selection this slot keeps unchanged (equals `id`). */
  keptSelectionId?: string;
  /**
   * Shopping preview only: served protein minus the slot's protein target, in grams (negative is
   * short); null for a kept slot, a slot with no protein target, or unknown recipe protein (S3).
   */
  proteinGapGrams?: number | null;
};
export type ShoppingAuthority = Omit<RecipeAuthority, "planRevision"> & {
  periodRevision: number | null; pantryFingerprint: string; listFingerprint: string;
};
export type ShoppingPreviewResult = Pick<PlanPreview, "windows" | "replenishment" |
  "unmetPins" | "unfilledSlots" | "proposedAdditions" | "compromise"> & {
  previewId: string; period: ShoppingPeriod; choices: AcceptedRecipeSelection[];
  lines: ShoppingLine[]; informationalIssues: string[]; blockingIssues: string[];
  authority: ShoppingAuthority; price: PlanPreview["shopping"]["price"];
};
