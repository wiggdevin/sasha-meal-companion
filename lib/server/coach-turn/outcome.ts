/**
 * The ways a coach turn ends. Every stage that answers returns one of these; finish() saves it and
 * builds the response, so the save, the ai_calls link, the telemetry and the after-response work
 * are written once.
 */

import { uiBlockSchema, type UiBlock } from "@/lib/coach/ui-blocks";
import type { CoachTurnResponse } from "@/lib/coach/types";
import { BY_APP, byModel, type Provenance } from "@/lib/provenance";
import { isOpenRouterModelId } from "@/lib/ai/models";

/** The response a stage built; finish() adds the thread id and the two saved messages. */
export type TurnBody = Omit<CoachTurnResponse, "threadId" | "messages">;

export type TurnOutcome =
  /** Medical deflection: no model, no grounding, the row marked `deflected`. */
  | { kind: "deflected"; content: string; toolCalls: unknown; body: TurnBody }
  /**
   * A read of a saved conversation: the cited excerpts, or a cited synthesis of them when
   * `synthesisModel` is set — then the row carries that call's ai_calls link.
   */
  | { kind: "history_recall"; content: string; toolCalls: unknown; synthesisModel: string;
      body: TurnBody }
  /**
   * The Jev fast path answered without Gemini. `telemetry` files the intent row; `messages` is the
   * view the branch has always returned ("plain": id, role, content, seq).
   */
  | { kind: "fast_path"; content: string; toolCalls: unknown;
      telemetry: () => Promise<void>; messages: "plain" | "full"; body: TurnBody;
      /** Jev chose this answer (its intent), or the app did (the Plan sheet's structured request). */
      provenance: Provenance }
  /** The Gemini turn: its policy checks, the model that answered and the memory it set. */
  | { kind: "model"; content: string; toolCalls: unknown; policyChecks: unknown[];
      modelId: string; memory: string | null; body: TurnBody };

export function validatedBlocks(...candidates: (UiBlock | null)[]): UiBlock[] {
  const valid = candidates.flatMap((candidate) => {
    const parsed = uiBlockSchema.safeParse(candidate);
    return parsed.success ? [parsed.data] : [];
  });
  // The model earns at most one content block. A server-selected next action can follow it.
  const content = valid.find((block) => block.kind !== "next_action_chip");
  const chip = valid.find((block) => block.kind === "next_action_chip");
  return [content, chip].filter((block): block is UiBlock => block !== undefined);
}

/**
 * Who produced an outcome, from the path that ran: the model turn and a cited synthesis are model
 * calls; the fast path says itself; deflection and plain excerpts are the app's.
 */
export function outcomeProvenance(outcome: TurnOutcome): Provenance {
  switch (outcome.kind) {
    case "model":
      return byModel(isOpenRouterModelId(outcome.modelId) ? "coach-openrouter" : "coach");
    case "history_recall":
      return outcome.synthesisModel !== ""
        ? byModel(isOpenRouterModelId(outcome.synthesisModel) ? "coach-openrouter" : "coach") : BY_APP;
    case "fast_path":
      return outcome.provenance;
    case "deflected":
      return BY_APP;
  }
}

/** The stored tool_calls with the provenance stamped in, when they are an object to stamp. */
export function stampProvenance(toolCalls: unknown, provenance: Provenance): unknown {
  return toolCalls !== null && typeof toolCalls === "object" && !Array.isArray(toolCalls)
    ? { ...toolCalls, provenance } : toolCalls;
}
