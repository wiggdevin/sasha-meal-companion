import { z } from "zod";
import { prefsPayload } from "@/lib/ai/payloads";
import { withJevBudget } from "@/lib/ai/request-budget";
import { systemOne } from "@/lib/ai/typesafe";
import { jsonError, readJson } from "@/lib/server/http";
import { HttpError, requireUser } from "@/lib/server/auth";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";
import { PREFERENCE_FLAGS } from "@/lib/profile/onboarding-state";
import { suggestTasteChips, tasteChipsEnabled } from "@/lib/server/taste-chips";
import { localOffer } from "@/lib/profile/taste-chips";
import { tasteTextRoute } from "@/lib/profile/taste-safety";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 2 * 1024;
/**
 * Either the dietary-preference text (`text`, the original flag classifier) or one optional taste
 * text (`taste`, Phase 18 W5b): `{ route: "local", reason, offer }` with no model call when the local
 * safety check keeps it, else `{ route: "send", jev, likes, dislikes, cuisines }` (each chip with its
 * probability, all at 0.8 or more). Nothing is written either way.
 */
const bodySchema = z.union([
  z.object({ text: z.string().max(2_000) }).strict(),
  z.object({ taste: z.string().max(2_000) }).strict(),
]);
export const COOKING_EFFORT_SUGGESTION_THRESHOLD = 0.8;

export { COOKING_EFFORT_CHOICES, PREF_QUESTIONS } from "@/lib/profile/pref-questions";

/** One Jev request budget per request, as on the coach route (lib/ai/request-budget.ts). */
export function POST(req: Request): Promise<Response> {
  return withJevBudget(() => handle(req));
}

async function handle(req: Request): Promise<Response> {
  try {
    await enforceRateLimit(`profile-prefs:pre:ip:${requestIp(req)}`, 120, 60);
    const { userId } = await requireUser(req);
    await enforceRateLimit(`profile-prefs:${userId}`, 30, 60);
    const body = await readJson(req, bodySchema, MAX_BYTES);
    if ("taste" in body) {
      if (!tasteChipsEnabled()) throw new HttpError(404, "not_enabled", "Taste chips are not available yet.");
      return Response.json(await suggestTasteChips(body.taste, { userId }));
    }
    const { text } = body;
    // Phase 18 W5b (D9, Sol r1 BLOCK 2): the same local check gates the dietary text. Kept text (a
    // rule, a symptom, anything unsure) makes no Jev call; the field continues with manual chips.
    const route = tasteTextRoute(text);
    if (route.route === "local") {
      return Response.json({ flags: {}, cookingEffortSuggestion: null, mentionsFoods: 0, jev: false,
        route: "local", reason: route.reason, offer: localOffer(route.reason) });
    }
    const answers = await systemOne(prefsPayload({ text }), { userId });
    if (answers === null) {
      return Response.json({
        flags: {}, cookingEffortSuggestion: null, mentionsFoods: 0, jev: false, route: "send",
      });
    }
    const flags = Object.fromEntries(PREFERENCE_FLAGS.map((flag) => [flag, answers[flag].noul]));
    const effort = answers.cooking_effort;
    const cookingEffortSuggestion = effort.choice !== "unstated"
      && effort.confidence >= COOKING_EFFORT_SUGGESTION_THRESHOLD
      ? effort.choice
      : null;
    return Response.json({
      flags,
      cookingEffortSuggestion,
      mentionsFoods: answers.mentions_specific_foods.noul,
      jev: true,
      route: "send",
    });
  } catch (error) {
    return jsonError(error);
  }
}
