import { z } from "zod";

export const date = z.iso.date();
export const id = z.uuid();
export const requestId = z.uuid();
export const revision = z.number().int().positive();
/** A list's name: trimmed, 1-60 characters; null is an untitled list (migration 20270107090200). */
export const periodTitle = z.string().trim().min(1).max(60).nullable();
export const identity = z.object({ foodRefId: z.uuid().nullable(), foodDbId: z.string().max(120).nullable().optional(),
  catalogFoodRevisionId: z.number().int().positive().nullable(),
  purchaseState: z.enum(["raw", "cooked", "ready_to_eat", "as_purchased"]),
  variantKey: z.string().max(120) });
export const source = z.object({ localDate: date, slotId: z.string().max(80),
  recipeId: z.uuid(), recipeRevisionId: z.uuid(), ingredientSeq: z.number().int().positive(),
  batchId: z.string().max(100).nullable(), requiredGrams: z.number().nonnegative().nullable() });
const periodFields = z.object({
  startDate: date, endDate: date, timezone: z.string().min(1).max(80),
  people: z.number().positive().max(30), mealCoverage: z.array(z.string().max(80)).max(30),
  mode: z.enum(["simple", "balanced"]), effort: z.enum(["none", "minimal", "standard"]),
  maxActiveMinutes: z.number().int().nonnegative().nullable(),
  variety: z.enum(["repeat_friendly", "balanced", "high"]),
  budgetAmount: z.number().nonnegative().nullable(),
  currency: z.string().length(3).nullable(), locale: z.string().max(80).nullable(),
  lockMode: z.enum(["none", "ingredients", "available_quantities"]),
  title: periodTitle.optional(),
});
export const periodDraft = periodFields.refine((row) => row.startDate <= row.endDate,
  "End date precedes start date");
export const periodPatch = periodFields.partial().extend({
  planRevision: z.number().int().nonnegative().optional(),
}).refine((row) => !row.startDate || !row.endDate || row.startDate <= row.endDate,
  "End date precedes start date");
const lineFields = z.object({
  origin: z.enum(["plan", "manual"]), name: z.string().min(1).max(160),
  identity: identity.nullable(), category: z.enum(["core", "pantry_top_up", "optional_extra", "manual"]),
  needGrams: z.number().nonnegative().nullable(), confirmedStockGrams: z.number().nonnegative().nullable(),
  buyGrams: z.number().nonnegative().nullable(), packageGrams: z.number().positive().nullable(),
  purchaseConversionStatus: z.enum(["known", "estimated", "unknown"]),
  sources: z.array(source).max(200), pinned: z.boolean(), checked: z.boolean(),
  note: z.string().max(500).nullable(),
});
export const lineDraft = lineFields.refine((row) => row.origin !== "manual" || row.category === "manual",
  "Manual lines need manual category");
export const linePatch = lineFields.partial().refine((row) => row.origin !== "manual"
  || row.category === undefined || row.category === "manual",
"Manual lines need manual category");
export const pantryDraft = z.object({ id: id.optional(), name: z.string().min(1).max(160),
  identity, confirmedGrams: z.number().nonnegative().nullable() });
export const purchaseWindowPatch = z.object({ checked: z.boolean().optional(),
  note: z.string().max(500).nullable().optional() }).strict()
  .refine((patch) => Object.keys(patch).length > 0, "Choose a purchase field to edit");
