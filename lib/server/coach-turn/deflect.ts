/** Medical deflection: before the model, so it costs nothing (lib/coach/deflect.ts). */

import { classifyMedical, MEDICAL_DEFLECTION } from "@/lib/coach/deflect";
import type { TurnOutcome } from "@/lib/server/coach-turn/outcome";
import type { OpenTurn } from "@/lib/server/coach-turn/types";

export function deflect(turn: OpenTurn): TurnOutcome | null {
  const medical = classifyMedical(turn.req.text);
  if (!medical.deflect) return null;
  return { kind: "deflected", content: MEDICAL_DEFLECTION, toolCalls: [], body: {
    suggestions: [], actions: [], draft: null, deflected: true, toolsUsed: [],
    model: { provider: "gemini", modelId: "" },
    // Deflection never reaches a model and never grounds anything, so both hops are zero.
    timings: { model: 0, ground: 0 },
  } };
}
