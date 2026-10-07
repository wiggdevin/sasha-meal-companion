"use client";

import { accountFetch, accountHandle, accountJson } from "@/lib/device/account";
import type { AcceptedRecipeSelection, RecipePreviewResult } from "@/lib/shopping/preview-contract";
import { ruleMarkFromWire } from "@/lib/foods/rule-mark-wire";
import { RECIPE_UNCHECKED } from "@/lib/foods/rule-marks";
import { RecipeRulesUncheckedError, withRecipeRuleMark } from "@/lib/recipes/rule-mark-wire";

export { RecipeRulesUncheckedError };

export async function previewRecipePlan(recipeId: string, date: string, slotId: string,
  servingFraction?: number, signal?: AbortSignal): Promise<RecipePreviewResult> {
  const h = accountHandle();
  const response = await accountFetch(h, `/api/recipes/${encodeURIComponent(recipeId)}/preview`, {
    method: "POST", headers: { "content-type": "application/json" }, cache: "no-store", signal,
    body: JSON.stringify({ date, slotId, ...(servingFraction === undefined ? {} : { servingFraction }) }),
  }, { budget: "commit" });
  if (response.status === 409) throw new Error("Your target or plan changed. Refresh and preview again.");
  if (response.status === 422) {
    // `recipe_rules_unchecked` / `recipe_ineligible` carry a plain sentence worth showing.
    const body = await accountJson<{ error?: unknown; message?: unknown; ruleMark?: unknown }>(h, response)
      .catch(() => null);
    const message = typeof body?.message === "string" && body.message.trim()
      ? body.message : "This recipe cannot be planned right now.";
    if (body?.error === "recipe_rules_unchecked") {
      const mark = ruleMarkFromWire(body.ruleMark);
      throw new RecipeRulesUncheckedError(message, mark?.verdict === "unknown" ? mark
        : { verdict: "unknown", reason: typeof body.message === "string" && body.message.trim()
          ? body.message : RECIPE_UNCHECKED });
    }
    throw new Error(message);
  }
  if (!response.ok) throw new Error(`Recipe preview failed (${response.status}).`);
  return withRecipeRuleMark(await accountJson<RecipePreviewResult>(h, response));
}

export async function acceptRecipePlan(recipeId: string, previewId: string,
  requestId: string, acceptApproximate: boolean): Promise<AcceptedRecipeSelection> {
  const h = accountHandle();
  const response = await accountFetch(h, `/api/recipes/${encodeURIComponent(recipeId)}/plan`, {
    method: "POST", headers: { "content-type": "application/json" }, cache: "no-store",
    body: JSON.stringify({ previewId, requestId, acceptApproximate }),
  }, { budget: "commit" });
  if (response.status === 409) throw new Error("This preview is stale. Preview the recipe again.");
  if (!response.ok) throw new Error(`Recipe could not be added (${response.status}).`);
  return withRecipeRuleMark((await accountJson<{ selection: AcceptedRecipeSelection }>(h, response)).selection);
}
