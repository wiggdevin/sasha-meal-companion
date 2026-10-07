import { HttpError } from "@/lib/server/auth";
import { requireRecipeUser } from "@/lib/server/recipe-access";
import { jsonError } from "@/lib/server/http";
import { noStore } from "@/lib/server/recipe-plan";
import { acceptedSelectionRuleMarks } from "@/lib/server/recipe-candidates";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { z } from "zod";
export const runtime = "nodejs";

/** `date:slot` for every eaten slot in range; null when the read failed (every row is unknown). */
async function eatenSlotKeys(client: Awaited<ReturnType<typeof requireRecipeUser>>["client"],
  userId: string, start: string, end: string): Promise<Set<string> | null> {
  const days = await client.from("plan_days").select("local_date,eaten_slots")
    .eq("user_id", userId).gte("local_date", start).lte("local_date", end);
  if (days.error) return null;
  return new Set((days.data ?? []).flatMap((day) => Object.entries(
    (day.eaten_slots ?? {}) as Record<string, { eaten_at?: string | null; consumed?: unknown } | null>)
    .filter(([, mark]) => Boolean(mark?.eaten_at || mark?.consumed))
    .map(([slot]) => `${day.local_date}:${slot}`)));
}
export const dynamic = "force-dynamic";
export async function GET(req: Request): Promise<Response> {
  try {
    const { client, userId } = await requireRecipeUser(req);
    await enforceRateLimit(`recipe-plan-read:${userId}`, 30, 60);
    if (req.url.length > 512) throw new HttpError(400, "bad_request", "Date query is too long.");
    const params = new URL(req.url).searchParams;
    if (params.size !== 2 || params.getAll("start").length !== 1
      || params.getAll("end").length !== 1) {
      throw new HttpError(400, "bad_request", "Only start and end dates are supported.");
    }
    const start = params.get("start") ?? ""; const end = params.get("end") ?? "";
    if (!z.iso.date().safeParse(start).success || !z.iso.date().safeParse(end).success || end < start
      || (Date.parse(end) - Date.parse(start)) / 86400000 > 30) {
      throw new HttpError(400, "bad_request", "Choose a range of at most 31 days.");
    }
    const result = await client.from("recipe_plan_selections").select("*")
      .eq("user_id", userId).is("superseded_at", null)
      .gte("local_date", start).lte("local_date", end)
      .order("local_date").order("slot_id");
    if (result.error) throw new HttpError(503, "plan_unavailable", undefined, { cause: result.error });
    const selections = (result.data ?? []).map((row) => ({ id: row.id,
      localDate: row.local_date, slotId: row.slot_id, recipeId: row.recipe_id,
      recipeRevisionId: row.recipe_revision_id, recipeName: row.recipe_name,
      servingFraction: Number(row.serving_fraction), ingredientSnapshot: row.ingredient_snapshot,
      nutritionSnapshot: row.nutrition_snapshot, exactFitAvailable: row.exact_fit_available,
      approximateFitAvailable: row.approximate_fit_available, evidenceIssues: row.evidence_issues,
      planRevision: row.plan_revision, batchId: row.batch_id,
      baselineSwap: row.baseline_swap, baselineOverride: row.baseline_override,
      acceptedAt: row.accepted_at,
      preparedOn: row.prepared_on, reuseLimitDays: row.reuse_limit_days,
      storageGuidance: row.storage_guidance }));
    // F2: each selection is judged against the CURRENT rules on read and marked, never dropped.
    // An eaten slot is history: it is not re-judged and carries NO ruleMark key (absent, not
    // null), so a phone that has not seen the eaten mark yet fails closed instead of passing it.
    const unchecked = { verdict: "unknown" as const,
      reason: "This recipe could not be checked against your current food rules." };
    const eaten = await eatenSlotKeys(client, userId, start, end);
    // Without the eaten read no row can be told apart: each is unknown, never a pass.
    if (eaten === null) {
      return Response.json({ selections: selections.map((row) => ({ ...row, ruleMark: unchecked })) },
        { headers: noStore });
    }
    const open = selections.filter((row) => !eaten.has(`${row.localDate}:${row.slotId}`));
    const marks = await acceptedSelectionRuleMarks(client, userId, open);
    return Response.json({ selections: selections.map((row) =>
      eaten.has(`${row.localDate}:${row.slotId}`) ? row
        : { ...row, ruleMark: marks.has(row.id) ? marks.get(row.id) ?? null : unchecked }),
    // The diet flags these marks were judged under; the phone trusts a mark only under the same
    // flags it holds now (round 3 BLOCK). Absent when the rules could not be read.
    ...(marks.preferenceFlags ? { ruleFlags: marks.preferenceFlags } : {}) },
    { headers: noStore });
  } catch (error) { return jsonError(error); }
}
