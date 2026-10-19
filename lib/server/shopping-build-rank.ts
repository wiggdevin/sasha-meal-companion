import "server-only";
/**
 * POST /api/shopping/build/rank (UI makeover W8 §7.3): the order of the Have AI build my list
 * Ingredients deck. The phone sends the admitted candidates it already built (id and name only);
 * Jev rates each name once as a grocery staple and the deck is sorted by that rating. Jev may only
 * REORDER: the answer is always every input id exactly once — an id Jev's answer would add is
 * dropped, an id it leaves out keeps its input place after the rated ones — and any Jev failure
 * (no key, timeout, open circuit, spend cap, request budget, malformed answer) is the plain input
 * order with app provenance, still a 200. Jev never sees the caller's ids, a budget, a place or any
 * profile or health field (lib/ai/payloads.ts `shoppingRankPayload`), and it is never on the rule,
 * Avoid or allergen path: the candidates were admitted on the phone before they got here.
 *
 * No database read here: the spend ledger and the `ai_calls` row are lib/ai/typesafe.ts's own.
 */
import { z } from "zod";
import { shoppingRankPayload, SHOPPING_RANK_MAX } from "@/lib/ai/payloads";
import { systemOne } from "@/lib/ai/typesafe";
import type { ScoreAnswer } from "@/lib/ai/jev-types";
import { BY_APP, byJev, type Provenance } from "@/lib/provenance";

export const SHOPPING_RANK_PURPOSE = "shopping-build-rank";

/** Jev's own deadline, under the phone's 5 s `rank` budget. */
export const RANK_JEV_DEADLINE_MS = 3_000;

/** An answer below this confidence does not move its food. */
export const RANK_MIN_CONFIDENCE = 0.6;

export const shoppingRankRequestSchema = z.object({
  candidates: z.array(z.object({
    id: z.string().min(1).max(120),
    name: z.string().trim().min(1).max(160),
  }).strict()).min(1).max(SHOPPING_RANK_MAX)
    .refine((list) => new Set(list.map((c) => c.id)).size === list.length, "candidate ids must be distinct"),
}).strict();

export type ShoppingRankRequest = z.infer<typeof shoppingRankRequestSchema>;
export type ShoppingRankResponse = { order: string[]; provenance: Provenance };

type RankAnswers = Record<string, ScoreAnswer>;
/** The Jev port: lib/ai/typesafe.ts `systemOne`, or a test double. */
export type ShoppingRankPort = (payload: ReturnType<typeof shoppingRankPayload>,
  options: { userId?: string; deadlineMs?: number }) => Promise<RankAnswers | null>;

/**
 * The reorder-only rule: the ids of `proposed` that are in `input`, each once and in proposed
 * order, then every input id the proposal left out, in input order. Nothing outside `input` is
 * ever admitted, and nothing in it is ever lost.
 */
export function reorderOnly(input: readonly string[], proposed: readonly unknown[]): string[] {
  const known = new Set(input);
  const seen = new Set<string>();
  const order: string[] = [];
  for (const id of proposed) {
    if (typeof id !== "string" || !known.has(id) || seen.has(id)) continue;
    seen.add(id);
    order.push(id);
  }
  for (const id of input) if (!seen.has(id)) { seen.add(id); order.push(id); }
  return order;
}

/** The rated candidates by staple score (highest first, input order on ties); unrated left out. */
function proposedOrder(ids: readonly string[], answers: RankAnswers): string[] {
  return ids.map((id, index) => {
    const answer = answers[`buy_${index}`];
    const usable = answer !== undefined && Number.isFinite(answer.score)
      && Number.isFinite(answer.confidence) && answer.confidence >= RANK_MIN_CONFIDENCE;
    return { id, index, score: usable ? answer.score : null };
  }).filter((row): row is { id: string; index: number; score: number } => row.score !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((row) => row.id);
}

export async function rankShoppingCandidates(
  request: ShoppingRankRequest, userId: string,
  port: ShoppingRankPort = systemOne as unknown as ShoppingRankPort,
): Promise<ShoppingRankResponse> {
  const ids = request.candidates.map((candidate) => candidate.id);
  const plain: ShoppingRankResponse = { order: [...ids], provenance: BY_APP };
  let answers: RankAnswers | null;
  try {
    const payload = shoppingRankPayload({ names: request.candidates.map((candidate) => candidate.name) });
    answers = await port(payload, { userId, deadlineMs: RANK_JEV_DEADLINE_MS });
  } catch {
    return plain;
  }
  if (!answers || typeof answers !== "object") return plain;
  const proposed = proposedOrder(ids, answers);
  if (proposed.length === 0) return plain;
  return { order: reorderOnly(ids, proposed), provenance: byJev(SHOPPING_RANK_PURPOSE) };
}
