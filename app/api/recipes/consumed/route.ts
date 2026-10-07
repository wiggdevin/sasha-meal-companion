import { z } from "zod";
import { HttpError } from "@/lib/server/auth";
import { requireRecipeUser } from "@/lib/server/recipe-access";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { noStore } from "@/lib/server/recipe-plan";
import { acceptedSelectionRuleMarks } from "@/lib/server/recipe-candidates";
import type { RuleMark } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const bodySchema = z.object({
  requestId: z.uuid(), localDate: z.iso.date(),
  slotId: z.enum(["meal-1", "meal-2", "meal-3", "meal-4", "meal-5", "meal-6"]),
  selectionId: z.uuid(), planRevision: z.number().int().positive(),
  actualServings: z.number().finite().positive().max(20),
}).strict();
const undoSchema = z.object({
  requestId: z.uuid(), localDate: z.iso.date(),
  slotId: z.enum(["meal-1", "meal-2", "meal-3", "meal-4", "meal-5", "meal-6"]),
  expectedChangedAt: z.iso.datetime({ offset: true }),
}).strict();

async function consumedRuleMark(client: Awaited<ReturnType<typeof requireRecipeUser>>["client"],
  userId: string, selectionId: string): Promise<RuleMark | null> {
  const unchecked: RuleMark = { verdict: "unknown",
    reason: "This recipe could not be checked against your current food rules." };
  // The snapshot is what the plan holds; without it a substituted line would go unjudged (round 4).
  const row = await client.from("recipe_plan_selections").select("id,recipe_revision_id,ingredient_snapshot")
    .eq("id", selectionId).eq("user_id", userId).maybeSingle();
  if (row.error || !row.data) return unchecked;
  const marks = await acceptedSelectionRuleMarks(client, userId,
    [{ id: row.data.id as string, recipeRevisionId: row.data.recipe_revision_id as string,
      ingredientSnapshot: Array.isArray(row.data.ingredient_snapshot)
        ? row.data.ingredient_snapshot as unknown[] : undefined }]);
  return marks.has(selectionId) ? marks.get(selectionId) ?? null : unchecked;
}

export async function POST(req: Request): Promise<Response> {
  try {
    const { client, userId } = await requireRecipeUser(req);
    await enforceRateLimit(`recipe-consumed:${userId}`, 30, 60);
    const body = await readJson(req, bodySchema, 1000);
    const saved = await client.rpc("recipe_log_consumed", {
      p_request_id: body.requestId, p_local_date: body.localDate,
      p_slot_id: body.slotId, p_selection_id: body.selectionId,
      p_plan_revision: body.planRevision, p_actual_servings: body.actualServings,
    });
    if (saved.error) {
      if (saved.error.code === "40001" || saved.error.code === "55P03") {
        throw new HttpError(409, "accepted_plan_changed",
          "This meal changed. Refresh Today and open it again.");
      }
      if (saved.error.code === "22023") {
        throw new HttpError(400, "invalid_consumption", "This eaten amount cannot be saved.");
      }
      throw new HttpError(503, "consumed_unavailable", undefined, { cause: saved.error });
    }
    // Logging marks, it never refuses: the eaten write above stands, and the answer says whether
    // the recipe still fits the account's CURRENT rules (2026-10-05 F2).
    // The write above is committed: a failed check is reported as unknown, never as an error.
    const ruleMark = await consumedRuleMark(client, userId, body.selectionId).catch((): RuleMark => ({
      verdict: "unknown", reason: "This recipe could not be checked against your current food rules." }));
    return Response.json({ ...(saved.data as Record<string, unknown>), ruleMark }, { headers: noStore });
  } catch (error) { return jsonError(error); }
}

export async function DELETE(req: Request): Promise<Response> {
  try {
    const { client, userId } = await requireRecipeUser(req);
    await enforceRateLimit(`recipe-consumed:${userId}`, 30, 60);
    const body = await readJson(req, undoSchema, 1000);
    const saved = await client.rpc("recipe_undo_consumed", {
      p_request_id: body.requestId, p_local_date: body.localDate,
      p_slot_id: body.slotId, p_expected_changed_at: body.expectedChangedAt,
    });
    if (saved.error) {
      if (saved.error.code === "40001" || saved.error.code === "55P03") {
        throw new HttpError(409, "logged_meal_changed",
          "This logged meal changed. Refresh Today before undoing it.");
      }
      if (saved.error.code === "22023") {
        throw new HttpError(400, "invalid_undo", "This logged meal cannot be undone.");
      }
      throw new HttpError(503, "undo_unavailable", undefined, { cause: saved.error });
    }
    return Response.json(saved.data, { headers: noStore });
  } catch (error) { return jsonError(error); }
}
