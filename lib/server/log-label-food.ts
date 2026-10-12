/**
 * The label-food half of the commit path: the placeholder ref, the label body's schema, and the
 * save that mints a real food_ref for it. Moved out of lib/server/log.ts unchanged (T9 §2); T3
 * reworks this path next, and it is easier to rework in a file of its own.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { per100gSchema } from "@/lib/ai/schemas";
import { namedAllergenHints } from "@/lib/policy/allergens";
import { labelFoodIdFor } from "@/lib/log/op-id";
import type { LogCommitFailure, LogCommitRequest } from "@/lib/log/contract";

/** The placeholder ref, shared with the capture sheet that sends it (lib/capture/label-food.ts). */
import { LABEL_FOOD_PLACEHOLDER_REF } from "@/lib/capture/label-food";
export { LABEL_FOOD_PLACEHOLDER_REF };

export type LabelFoodInput = {
  name: string; brand?: string; per100g: z.infer<typeof per100gSchema>;
  ingredientsText?: string; allergenTags: string[];
};

/** Parsed here, not in lib/log/contract.ts: that file is shared and stays frozen (contracts §1).
 * per100g reuses lib/ai/schemas' shape (all 20 codes, each nullable) — the propose response
 * always carries all 20, so a partial object here means the client dropped one, not that the user did. */
export const labelFoodSchema: z.ZodType<LabelFoodInput> = z.object({
  name: z.string().min(1).max(160),
  brand: z.string().max(120).optional(),
  per100g: per100gSchema,
  ingredientsText: z.string().max(4000).optional(),
  allergenTags: z.array(z.string().max(40)).max(30),
}) as z.ZodType<LabelFoodInput>;

/**
 * The label's own policy evidence, judged BEFORE commitLabelFood ever inserts.
 *
 * sol BLOCK (review round 1, phase 13 slice 2): the tags used to be rebuilt with
 * allergenTagsFromIngredients (lib/capture/propose.ts), a scanner limited to gluten, dairy and
 * apple — a label naming peanut committed as merely unverified instead of blocked. namedAllergenHints
 * reaches the same full vocabulary the capture card blocks against; "apple" stays an extra key so
 * a legacy profile that still avoids it (lib/reference.ts's RETIRED_ALLERGEN_KEYS) reads as before.
 *
 * sol BLOCK (s2 round 3): the verbatim ingredient text and the product name reach the policy too,
 * so a label commit gets the capture card's strict completeness check (a complete allergen-free
 * list clears; an incomplete one stays unverified) and §9 R1's name-based tuna rule.
 */
export function labelPolicyEvidence(label: LabelFoodInput) {
  return {
    allergenTags: [...new Set([...label.allergenTags,
      ...namedAllergenHints(label.ingredientsText, ["apple"])])],
    ingredientsText: label.ingredientsText ?? null, ingredientsTextIsLabel: true,
    foodName: label.name,
    // 2026-10-02 DeepSeek audit (F2, MED): a photographed label is packaged by definition,
    // whatever its own `brand` string reads — an unbranded store label is still packaged, so it
    // must never read as a generic whole-food identity by name alone
    // (lib/policy/whole-foods.ts).
    foodBrand: label.brand ?? null, packaged: true,
  };
}

/** Their own food, from the label the user photographed. Runs after the refs and revisions are
 * validated (A036) and before the RPC, so the swap is honoured. */
async function saveLabelFood(
  client: SupabaseClient, userId: string, entryId: string, label: LabelFoodInput
): Promise<{ userFoodId?: string; foodRefId: string }> {
  // sol BLOCK (review round 1, phase 13 slice 2): this used to re-scan with
  // lib/capture/propose.ts's allergenTagsFromIngredients, a scanner limited to gluten, dairy and
  // apple (spec AC9, a Phase 3/4 leftover from before the account-driven allergen system
  // existed) — a label naming peanut (or any of the other six major allergens) saved no tag for
  // it at all when the client's own declared tags also missed it. namedAllergenHints reaches the
  // same full, canonical allergen vocabulary the capture card itself blocks against; "apple" is
  // passed as an extra key so a legacy row that still names it (lib/reference.ts's
  // RETIRED_ALLERGEN_KEYS — not offered to a new profile, but an existing one may still avoid it)
  // keeps reading exactly as it always did.
  const fromIngredients = namedAllergenHints(label.ingredientsText, ["apple"]);
  const allergenTags = [...new Set([...label.allergenTags, ...fromIngredients])];
  // A036: the id is named by the account and the entry, so an attempt the RPC refused or that
  // died after this insert is met by its retry here, never answered with a second row.
  const id = labelFoodIdFor(userId, entryId);
  const food = await client.from("user_foods").insert({
    id, user_id: userId, name: label.name, brand: label.brand ?? null, kind: "label_scan",
    per_100g: label.per100g, ingredients_text: label.ingredientsText ?? null,
    allergen_tags: allergenTags,
  }).select("id").single();
  const created = !food.error && Boolean(food.data);
  if (!created && (food.error as { code?: string } | null)?.code !== "23505") {
    throw food.error ?? new Error("could not save the label food");
  }
  if (!created) {
    // The earlier attempt's row. Read through RLS, so only this account's own row answers.
    const held = await client.from("user_foods").select("id").eq("id", id).maybeSingle();
    if (held.error || !held.data) throw held.error ?? new Error("could not read the label food");
  }
  const ref = await client.rpc("get_or_create_food_ref", { p_user_id: userId, p_kind: "user",
    p_catalog_food_id: null, p_user_food_id: id });
  if (ref.error || !ref.data) throw ref.error ?? new Error("could not register the label food");
  return { userFoodId: created ? id : undefined, foodRefId: ref.data as string };
}

/**
 * The label item's food_ref when entry_id was already committed — a retry must not insert a
 * second user_foods row (commit is idempotent on entry_id, spec §5). Found by the placeholder
 * item's own id: the client numbers items from 1, so the old seq-0 lookup never matched (A036).
 * RLS scopes the read to their rows, so a guessed id from another user reads nothing.
 */
async function existingLabelRef(
  client: SupabaseClient, entryId: string, itemId: string,
): Promise<string | null> {
  const item = await client.from("log_items").select("food_ref_id")
    .eq("entry_id", entryId).eq("id", itemId).maybeSingle();
  if (item.error) console.error("existing label item lookup failed", { entry_id: entryId, error: item.error });
  return (item.data as { food_ref_id: string } | null)?.food_ref_id ?? null;
}

/**
 * Validates the label_food body with no I/O and no write — split from the save so the constraint
 * policy (§4.4) can run against the label's own allergen tags BEFORE any user_foods row exists.
 * Returns a failure when save_label_as_food was asked for but no valid label_food body came with it.
 */
export function labelFoodOrFailure(
  req: LogCommitRequest, labelFood: unknown
): { label: LabelFoodInput | null } | LogCommitFailure {
  if (!req.save_label_as_food) return { label: null };
  if (!req.items.some((item) => item.food_ref_id === LABEL_FOOD_PLACEHOLDER_REF)) {
    return { status: "invalid", issues: [{ path: "items",
      message: "save_label_as_food needs one item with the placeholder ref" }] };
  }
  const label = labelFoodSchema.safeParse(labelFood);
  if (!label.success) {
    return { status: "invalid",
      issues: [{ path: "label_food", message: "save_label_as_food needs a label_food body" }] };
  }
  return { label: label.data };
}

/**
 * Saves the label food and swaps the placeholder ref, mutating req.items in place. Called only once
 * labelFoodOrFailure has validated the body and the other items' refs and revisions have passed
 * (A036), so a refused commit never leaves a food behind. Returns the user_food_id
 * only when this call actually saved a new food — a retry that finds the entry already committed
 * reuses its existing ref and reports no user_food_id, keeping the duplicate/ok response shape
 * unchanged.
 */
export async function commitLabelFood(
  client: SupabaseClient, userId: string, req: LogCommitRequest, label: LabelFoodInput | null
): Promise<{ userFoodId?: string }> {
  if (!label) return {};
  const placeholder = req.items.find((item) => item.food_ref_id === LABEL_FOOD_PLACEHOLDER_REF);
  const existingRef = placeholder
    ? await existingLabelRef(client, req.entry_id, placeholder.id) : null;
  const saved = existingRef ? null : await saveLabelFood(client, userId, req.entry_id, label);
  const foodRefId = existingRef ?? (saved as { foodRefId: string }).foodRefId;
  for (const item of req.items) {
    if (item.food_ref_id === LABEL_FOOD_PLACEHOLDER_REF) item.food_ref_id = foodRefId;
  }
  return { userFoodId: saved?.userFoodId };
}

