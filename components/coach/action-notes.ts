import { NUTRITION_UNCHECKED_COPY } from "@/lib/nutrition-display";

export type CoachActionStatus = "pending" | "applied" | "failed" | "undoing" | "undone";
/** Reuses the server's copy for the same outcome (lib/server/coach-undo.ts, "already_undone"). */
export const ALREADY_UNDONE_COPY = "This was already undone.";

/**
 * CoachActionCard's body notes, by status: an applied save's notices plus "nutrition not fully
 * checked" when relevant (t23 #7). An undone entry's one line: `already` is every other action
 * kind's shared "this tap did not freshly undo anything" copy (t23 #8); `reason` on an "undone"
 * entry says something more specific instead — today, only a taste record
 * (components/coach/use-coach-undo.ts) — and wins when both are given. Every kind that never sets
 * `reason` on "undone" keeps exactly today's ALREADY_UNDONE_COPY output, unchanged.
 */
export function actionCardNotes(args: {
  status: CoachActionStatus; already: boolean; reason?: string;
  notices: readonly string[]; nutritionUnchecked: boolean;
}): string[] {
  if (args.status === "applied") {
    return [...args.notices, ...(args.nutritionUnchecked ? [NUTRITION_UNCHECKED_COPY] : [])];
  }
  if (args.status === "undone" && (args.already || args.reason)) return [args.reason ?? ALREADY_UNDONE_COPY];
  return [];
}
