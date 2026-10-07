/**
 * The `pair_plausibility` question set (Phase 18 D9 item 2, slice W1c), owned here so the payload
 * builder (lib/ai/payloads.ts `pairPlausibilityPayload`) builds it and no caller writes question
 * text (Phase 13 §9 R3). Data class D0: each item carries catalog food names and a stated meal
 * occasion only — no user, profile, rule or account data.
 *
 * The wording is frozen per PAIR_PROMPT_VERSION and PAIR_RUBRIC_VERSION. The offline label store
 * (scripts/pairing/labels.ts) keys every stored probability by the model id, both versions and
 * the item, so a refresh under the same three never changes a stored value (W1c acceptance 2), and
 * any wording change needs a version bump. The human labelling instructions
 * (docs/pairing/holdout-instructions.md) state the same rubric.
 *
 * Pure. Type imports only, so client-reachable payload code may load it.
 */
import type { NoulQuestion } from "@/lib/ai/jev-types";

export const PAIR_PROMPT_VERSION = "pair-prompt-1";
export const PAIR_RUBRIC_VERSION = "pair-rubric-1";

/** The stated occasion of each template, as the question reads it. */
export const PAIR_OCCASIONS = { breakfast: "breakfast", main: "lunch or dinner", snack: "snack" } as const;
export type PairOccasion = (typeof PAIR_OCCASIONS)[keyof typeof PAIR_OCCASIONS];

/** A pair (one side) or a plate pattern (two or more sides), with its stated occasion. */
export type PairItem = { id: string; anchor: string; sides: readonly string[]; occasion: PairOccasion };

/** The base question, before it is pointed at one item. */
export const PAIR_QUESTION: NoulQuestion = {
  type: "noul",
  instructions: "Is serving the listed side food or foods together with the anchor food, on one plate or in one "
    + "meal at the stated occasion, a normal, commonly eaten combination?",
  criteria: {
    true: "People commonly eat these foods together at this occasion, in at least one widely eaten cuisine; "
      + "nothing about the combination would seem odd to someone who eats that way.",
    false: "The combination is unusual, clashing, or not eaten together at this occasion in any widely eaten cuisine.",
  },
};

const NAME = /^[\p{L}\p{N}][\p{L}\p{N} ,'()%/&.-]{0,79}$/u;
const ID = /^[a-z0-9][a-z0-9_-]{0,95}$/;

/** The item as Jev reads it: names and the occasion, nothing else. Throws on a malformed item. */
export function pairItemState(item: PairItem): { anchor: string; sides: string[]; occasion: PairOccasion } {
  if (!ID.test(item.id)) throw new Error("pair item id must be a short slug");
  if (!NAME.test(item.anchor) || !item.sides.length || item.sides.length > 3 || !item.sides.every((side) => NAME.test(side))) {
    throw new Error("pair item names must be catalog food names");
  }
  if (!Object.values(PAIR_OCCASIONS).includes(item.occasion)) throw new Error("pair item occasion is not a stated occasion");
  return { anchor: item.anchor, sides: [...item.sides], occasion: item.occasion };
}

export function pairItemQuestion(id: string): NoulQuestion {
  return { ...PAIR_QUESTION, instructions: `Evaluate only state.items[${JSON.stringify(id)}]. ${PAIR_QUESTION.instructions}` };
}
