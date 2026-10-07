/**
 * The fixed Jev plausibility questions for suggestion ranking (purpose `suggest-options`), one
 * per candidate. The payload builder (lib/ai/payloads.ts suggestPayload) calls this; no caller
 * chooses questions (Phase 13 §9 R3). Pure: the browser graph reaches it through the builders.
 */
import { score, type ScoreQuestion } from "@/lib/ai/jev-types";

export type SuggestKind = "meal" | "snack" | "recipe";

export function questionsFor(
  kind: SuggestKind, count: number,
): Record<string, ScoreQuestion> {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [
    `plausible_${index}`,
    score(`Rank candidates[${index}] as a ${kind} for state.slot and state.wish. `
      + "state.slot.label may name the meal (breakfast, lunch, dinner, snack) and its clock time: "
      + "judge whether these foods, in these amounts, go together as people usually eat them at "
      + "that time of day.", [
      `not a ${kind} — a bare ingredient, ${kind === "snack" ? "a full dinner, " : ""}odd together, `
        + "or wrong for that time of day",
      `acceptable as a ${kind}`,
      `a natural ${kind} someone would actually choose for that slot, time and wish`,
    ]),
  ]));
}
