/**
 * The coach's taste chip PROPOSAL (Phase 18 D9 item 3, slices W5b and W5b-2): the chips the
 * classifier offers for a stated taste dislike or cuisine, stored on the assistant message as
 * `tool_calls.tasteChips` (lib/server/coach-turn/reply.ts, dark behind TASTE_CHIPS_ENABLED) and read
 * back as the message view's `tasteChips`. The proposal writes nothing. The user's picks become ONE
 * `confirm_taste_chips` action (`coachConfirmRequest`): POST /api/profile/taste/confirm with the
 * card's message and proposal id, which the server checks against the stored card, writes, receipts
 * and records as the coach Undo record (record_mode taste_v1) in one transaction.
 *
 * Pure. No I/O.
 */
import { z } from "zod";
import { CUISINES, CUISINES_MAX } from "@/lib/profile/cuisines";
import { tasteDislike } from "@/lib/profile/taste";
import { provenanceSchema } from "@/lib/provenance";
import type { TasteConfirmRequest } from "@/lib/profile/taste-confirm";
import type { CuisineKey } from "@/lib/profile/cuisines";
import type { TasteDislike } from "@/lib/profile/taste";

/** A proposal holds at most this many dislike chips (4 families and 12 tags). */
export const PROPOSAL_DISLIKES_MAX = 16;

const chip = <K extends z.ZodType<string>>(key: K) => z.object({
  key, label: z.string().min(1).max(80), p: z.number().min(0.8).max(1),
}).strict();

const dislikeKey = z.string().refine((value) => tasteDislike(value) === value, "not a taste dislike");

export const tasteChipsProposalSchema = z.object({
  kind: z.literal("taste_chips_proposal"),
  v: z.literal(1),
  id: z.string().min(1).max(64),
  dislikes: z.array(chip(dislikeKey)).max(PROPOSAL_DISLIKES_MAX),
  cuisines: z.array(chip(z.enum(CUISINES))).max(CUISINES_MAX),
  /** Jev proposed the chips. */
  provenance: provenanceSchema.optional(),
}).strict().refine((card) => card.dislikes.length + card.cuisines.length > 0, "a proposal needs a chip");

export type TasteChipsProposal = z.infer<typeof tasteChipsProposalSchema>;
type ProposedChip = { key: string; label: string; p: number };

/** The proposal for these chips, or null when none is a dislike or a cuisine (likes have no proposal). */
export function hydrateTasteChipsProposal(
  id: string, chips: { dislikes: readonly ProposedChip[]; cuisines: readonly ProposedChip[] },
): TasteChipsProposal | null {
  const parsed = tasteChipsProposalSchema.safeParse({
    kind: "taste_chips_proposal", v: 1, id,
    dislikes: chips.dislikes.slice(0, PROPOSAL_DISLIKES_MAX), cuisines: chips.cuisines.slice(0, CUISINES_MAX),
  });
  return parsed.success ? parsed.data : null;
}

/** The coach action kind a confirmed card records (`coach_action_undos.kind`). */
export const CONFIRM_TASTE_CHIPS = "confirm_taste_chips" as const;

/**
 * The confirm request for the chips the user kept on one card, or null when they kept none or named
 * one the card did not offer. `actionId` is minted once per tap (lib/profile/taste-confirm-client.ts
 * `newTasteActionId`) and reused for that tap's retries.
 */
export function coachConfirmRequest(card: TasteChipsProposal, messageId: string,
  picks: { dislikes: readonly string[]; cuisines: readonly string[] }, actionId: string,
): TasteConfirmRequest | null {
  const offeredDislikes = new Set(card.dislikes.map((c) => c.key));
  const offeredCuisines = new Set<string>(card.cuisines.map((c) => c.key));
  const dislikes = [...new Set(picks.dislikes)];
  const cuisines = [...new Set(picks.cuisines)];
  if (dislikes.length + cuisines.length === 0) return null;
  if (!dislikes.every((key) => offeredDislikes.has(key)) || !cuisines.every((key) => offeredCuisines.has(key))) {
    return null;
  }
  return { actionId, source: "coach", dislikes: dislikes as TasteDislike[], cuisines: cuisines as CuisineKey[],
    coach: { messageId, proposalId: card.id } };
}
