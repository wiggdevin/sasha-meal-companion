import { z } from "zod";
import { isFoodKey } from "@/lib/meals/food-key";
import type { StoredDay } from "@/lib/types";

const slot = z.enum(["coffee", "pouches-pre", "post-refuel", "meal-1", "meal-2", "meal-3", "meal-4", "meal-5", "meal-6", "hot-chocolate"]);
const amount = z.number().finite().nonnegative();
const component = z.object({
  name: z.string().min(1), qty: amount,
  unit: z.enum(["oz", "cup", "tbsp", "tsp", "whole", "pouch", "can", "g", "ml"]),
  role: z.enum(["protein", "carb", "fat", "free"]),
  macros: z.object({ kcal: amount, protein: amount, carbs: amount, fat: amount }),
  // Phase 18 W3: optional, so stored snapshots and older clients (which strip it) still parse. A
  // malformed key never refuses the day, and is never silently dropped either: it becomes the
  // `foodKeyInvalid` marker, so the server's taste reader treats the line as unreadable instead of
  // matching it by name (lib/server/taste-resolve.ts).
  foodKey: z.unknown().optional(),
  foodKeyInvalid: z.literal(true).optional().catch(undefined),
}).transform(({ foodKey, foodKeyInvalid, ...line }): typeof line & { foodKey?: string; foodKeyInvalid?: true } =>
  foodKey === undefined ? { ...line, ...(foodKeyInvalid ? { foodKeyInvalid } : {}) }
    : isFoodKey(foodKey) && !foodKeyInvalid ? { ...line, foodKey } : { ...line, foodKeyInvalid: true });

/** Edits record what happened, including off-plan foods; validation checks shape, not diet rules. */
export const itemOverridesSchema = z.partialRecord(slot, z.object({
  baseMealId: z.string().min(1).nullable(),
  title: z.string().min(1).max(80).optional(),
  components: z.array(component),
  followPlan: z.boolean().optional(),
  added: z.boolean().optional(),
  removed: z.boolean().optional(),
  cleared: z.boolean().optional(),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  mutationId: z.uuid().optional(),
}));

export const consumedRecipeSnapshotSchema = z.object({
  baseMealId: z.string().min(8).max(160).startsWith("recipe:"),
  title: z.string().min(1).max(80),
  components: z.tuple([z.object({
    name: z.string().min(1).max(80), qty: z.number().finite().positive().max(20),
    unit: z.literal("whole"), role: z.literal("free"),
    macros: z.object({ kcal: amount.max(1_000_000), protein: amount.max(1_000_000),
      carbs: amount.max(1_000_000), fat: amount.max(1_000_000) }).strict(),
  }).strict()]),
}).strict();

export const eatenSlotsSchema = z.partialRecord(slot, z.object({
  eaten_at: z.iso.datetime({ offset: true }).nullable(),
  changed_at: z.iso.datetime({ offset: true }),
  consumed: consumedRecipeSnapshotSchema.optional(),
  history_epoch: z.uuid().optional(),
}).strict().refine((mark) => mark.eaten_at !== null || mark.consumed === undefined));

export const planDayProjectionSchema = z.object({
  day_type_override: z.enum(["training-10", "training-7-fasted", "rest"]).nullable().optional(),
  floor_day: z.boolean().optional(),
  swaps: z.partialRecord(slot, z.string()).optional(),
  slot_notes: z.partialRecord(slot, z.string()).optional(),
  item_overrides: itemOverridesSchema.optional(),
  eaten_slots: eatenSlotsSchema.optional(),
  day_complete_at: z.iso.datetime({ offset: true }).nullable().optional(),
  updated_at: z.iso.datetime({ offset: true }).optional(),
});


/** Shared mapping for browser projection and the server's legacy MCP snapshot overlay. */
export function planDayFields(plan: z.infer<typeof planDayProjectionSchema>): Partial<StoredDay> {
  const eaten = Object.fromEntries(Object.entries(plan.eaten_slots ?? {})
    .filter(([, mark]) => typeof mark?.eaten_at === "string")
    .map(([key, mark]) => [key, mark!.eaten_at!]));
  const consumedSlots = Object.fromEntries(Object.entries(plan.eaten_slots ?? {})
    .filter(([, mark]) => typeof mark?.eaten_at === "string" && mark?.consumed !== undefined)
    .map(([key, mark]) => [key, mark!.consumed!]));
  return {
    dayTypeOverride: plan.day_type_override ?? undefined,
    floorDay: plan.floor_day ?? false,
    swaps: plan.swaps ?? {}, notes: plan.slot_notes ?? {}, itemOverrides: plan.item_overrides ?? {},
    eaten, consumedSlots,
    // Absent on a row from a server without the column: leave the local mark as it is.
    ...(plan.day_complete_at !== undefined ? { dayCompleteAt: plan.day_complete_at ?? undefined } : {}),
  };
}
