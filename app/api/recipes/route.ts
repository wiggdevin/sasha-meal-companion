import { z } from "zod";
import { HttpError } from "@/lib/server/auth";
import { requireRecipeUser } from "@/lib/server/recipe-access";
import { jsonError } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";
import { loadMarkedRecipeCandidates } from "@/lib/server/recipe-candidates";
import { recipeSearchFromWish } from "@/lib/coach/recipe-query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const Query = z.object({
  q: z.string().max(120).default(""), cuisine: z.string().max(80).optional(),
  maxMinutes: z.coerce.number().int().min(1).max(1440).optional(),
  effort: z.enum(["none", "minimal", "standard"]).optional(),
  limit: z.coerce.number().int().min(1).max(64).default(3),
});

export async function GET(req: Request): Promise<Response> {
  try {
    await enforceRateLimit(`recipe-search:pre:ip:${requestIp(req)}`, 120, 60);
    const { client, userId } = await requireRecipeUser(req);
    await enforceRateLimit(`recipe-search:${userId}`, 30, 60);
    const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
    if (!parsed.success) throw new HttpError(400, "bad_request", "Check recipe search filters.");
    // The Coach parser is pure and type-only dependent on the catalog. Use the same
    // extraction here so a conversational q reaches SQL as dish terms and filters.
    const inferred = recipeSearchFromWish(parsed.data.q, parsed.data.limit);
    if (inferred.unsupportedExclusion) throw new HttpError(422, "unsupported_exclusion",
      "This search cannot check a one-off ingredient exclusion. Add it to Avoids, then search again.");
    if (parsed.data.cuisine && inferred.search.cuisine
      && parsed.data.cuisine.toLowerCase() !== inferred.search.cuisine.toLowerCase()) {
      throw new HttpError(400, "conflicting_filters", "The cuisine in your search differs from the selected cuisine.");
    }
    const effortOrder = { none: 0, minimal: 1, standard: 2 } as const;
    const effort = parsed.data.effort && inferred.search.effort
      ? effortOrder[parsed.data.effort] < effortOrder[inferred.search.effort]
        ? parsed.data.effort : inferred.search.effort
      : parsed.data.effort ?? inferred.search.effort;
    const maxMinutes = parsed.data.maxMinutes && inferred.search.maxMinutes
      ? Math.min(parsed.data.maxMinutes, inferred.search.maxMinutes)
      : parsed.data.maxMinutes ?? inferred.search.maxMinutes;
    const result = await loadMarkedRecipeCandidates(client, userId,
      { query: inferred.search.query, cuisine: parsed.data.cuisine ?? inferred.search.cuisine,
        maxMinutes, effort, ...(inferred.search.occasion ? { occasion: inferred.search.occasion } : {}),
        limit: parsed.data.limit });
    // Each candidate carries the selection GET's verdict under the current rules (`ruleMark`;
    // unknown when the rules could not be read), and `ruleFlags` names the normalized diet flags
    // it was judged under (absent when unread).
    return Response.json({ recipes: result.candidates,
      count: result.candidates.length, limitations: result.noResultReasons,
      // False: no recipe carries every word asked for; these are the closest ("No exact match").
      exactMatch: result.exactMatch,
      rulesFingerprint: result.rulesFingerprint,
      ...(result.preferenceFlags ? { ruleFlags: result.preferenceFlags } : {}) },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}
