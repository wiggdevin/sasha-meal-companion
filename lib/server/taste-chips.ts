import "server-only";

/**
 * Taste text to confirmable chips (Phase 18 D9 item 3, slice W5b), shared by
 * `POST /api/profile/prefs` (`{ taste }`) and the coach's `taste_chips_proposal` card.
 *
 *   1. The local safety check (lib/profile/taste-safety.ts) runs first. Text it keeps local returns
 *      `{ route: "local", reason, offer }` and NO model is called.
 *   2. Otherwise the families the text names are matched against the universe family list, and Jev
 *      answers the fixed question set (lib/profile/taste-chips.ts) through `systemOne`, the governed
 *      path: the call registry, the circuit, the daily spend cap and the one `ai_calls` row.
 *   3. Every proposal is validated with the settings parsers; invalid ones are dropped.
 *
 * Nothing is written here: the user confirms each chip (onboarding, Settings, the coach card) and
 * only that confirmation writes. Jev down, slow or malformed answers `jev: false` with no chips, so
 * the flow continues with manual chips.
 */
import { tastePayload } from "@/lib/ai/payloads";
import { systemOne } from "@/lib/ai/typesafe";
import {
  localOffer, matchFamilies, tasteChipsFromAnswers, type TasteSuggestion,
} from "@/lib/profile/taste-chips";
import { tasteFamilies } from "@/lib/profile/taste-families";
import { tasteTextRoute } from "@/lib/profile/taste-safety";

export type { TasteSuggestion };

/** The switch lives in a model-free module so the probe route can read it (W5b-3). */
export { tasteChipsEnabled } from "@/lib/server/taste-flag";

export type TasteChipOptions = { userId: string; deadlineMs?: number; signal?: AbortSignal };

export async function suggestTasteChips(text: string, options: TasteChipOptions): Promise<TasteSuggestion> {
  const route = tasteTextRoute(text);
  if (route.route === "local") {
    return { route: "local", reason: route.reason, offer: localOffer(route.reason) };
  }
  const families = matchFamilies(text, tasteFamilies());
  const payload = tastePayload({ text, families });
  const answers = await systemOne(payload, {
    userId: options.userId,
    ...(options.deadlineMs !== undefined ? { deadlineMs: options.deadlineMs } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (answers === null) return { route: "send", jev: false, likes: [], dislikes: [], cuisines: [] };
  return { route: "send", jev: true, ...tasteChipsFromAnswers(families, answers) };
}
