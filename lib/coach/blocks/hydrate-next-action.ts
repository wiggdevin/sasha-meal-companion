/**
 * Phase 13 slice 7 (§6 "next best action"): builds the schema-typed `next_action_chip` block
 * (lib/coach/ui-blocks.ts) from a ranked candidate (lib/coach/next-action.ts). Pure: no I/O.
 */
import type { NextActionCandidate } from "@/lib/coach/next-action";
import type { NextActionChipBlockV1 } from "@/lib/coach/ui-blocks";

export function hydrateNextActionChip(
  id: string, candidate: NextActionCandidate,
): NextActionChipBlockV1 {
  return { kind: "next_action_chip", v: 1, id, action: candidate.kind, label: candidate.label };
}
