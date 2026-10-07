import "server-only";

/**
 * The coach's taste chip PROPOSAL builder (Phase 18 D9 item 3, slice W5b): when the user's own
 * message states a taste — a texture or flavour they cannot stand, a cuisine they grew up on — the
 * same classifier as `POST /api/profile/prefs` proposes chips (lib/coach/taste-chips-card.ts).
 *
 * Wired by slice W5b-2: a delivered model reply carries the card as `tool_calls.tasteChips`
 * (lib/server/coach-turn/reply.ts); it writes nothing, and the user's picks confirm through
 * POST /api/profile/taste/confirm. Dark behind `TASTE_CHIPS_ENABLED` like the route.
 *
 * `mayProposeTaste` is plain string work, safe on every turn: the local safety check must send the
 * text and it must use a taste word. Text the check keeps local never reaches Jev; the turn then
 * keeps its existing proposal path (the rule card) unchanged.
 */
import { hydrateTasteChipsProposal, type TasteChipsProposal } from "@/lib/coach/taste-chips-card";
import { TASTE_WORD, tasteTextRoute } from "@/lib/profile/taste-safety";
import { suggestTasteChips, tasteChipsEnabled } from "@/lib/server/taste-chips";
import { byJev } from "@/lib/provenance";

/** Jev's share of a coach turn for the card; a slower answer leaves the turn without it. */
export const TASTE_CARD_DEADLINE_MS = 2_000;

export function mayProposeTaste(text: string): boolean {
  return tasteChipsEnabled() && TASTE_WORD.test(text) && tasteTextRoute(text).route === "send";
}

/** The card for this message, or null: kept text, no taste word, Jev down, or no dislike or cuisine chip. */
export async function tasteChipsCard(
  text: string, userId: string, newId: () => string, signal?: AbortSignal,
): Promise<TasteChipsProposal | null> {
  if (!mayProposeTaste(text)) return null;
  const suggestion = await suggestTasteChips(text, { userId, deadlineMs: TASTE_CARD_DEADLINE_MS, signal });
  if (suggestion.route !== "send" || !suggestion.jev) return null;
  const card = hydrateTasteChipsProposal(newId(), suggestion);
  return card ? { ...card, provenance: byJev("profile-taste") } : null;
}
