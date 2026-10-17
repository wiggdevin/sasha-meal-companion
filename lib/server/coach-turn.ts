/**
 * The coach turn — spec "API changes", "Security"; contracts §4.
 *
 * Order, and it is not negotiable: flag, messageId idempotency, budget (W035: after the replay,
 * so a retry of a saved turn never spends a slot), deflection (zero model calls), the
 * health-context / R4 gate, then the loop. The policy runs after the model and before
 * render, on the server, so a client that ignores `verdict` cannot show an allowed-looking card.
 *
 * This file is the public entry and reads top to bottom: each stage lives in
 * lib/server/coach-turn/ and returns either a TurnOutcome (lib/server/coach-turn/outcome.ts) or
 * what the next stage needs, and every text turn ends in finish() (lib/server/coach-turn/finish.ts).
 * Storage lives in lib/server/coach-threads.ts and the injected context block in
 * lib/server/coach-context.ts (T6 §6). No "server-only" marker: tests load this module under
 * vitest, and lib/server/ is the boundary.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { generateStructured } from "@/lib/ai/adapter";
import { coachTurnPayload } from "@/lib/ai/gemini-payloads";
import { COACH_MODEL_ID, isOpenRouterModelId } from "@/lib/ai/models";
import { generateOpenRouter } from "@/lib/ai/openrouter";
import { coachOpenRouterPayload } from "@/lib/ai/openrouter-payloads";
import { coachEnabled } from "@/lib/capabilities";
import { COACH_ATTEMPT_TIMEOUT_MS, COACH_TEMPERATURE, PER_CALL_TIMEOUT_MS, TURN_LIMITS,
  turnStepProviderSchema, turnStepWireSchemaFor } from "@/lib/coach/turn";
import type { CoachTurnRequest, CoachTurnResponse } from "@/lib/coach/types";
import { HttpError } from "@/lib/server/auth";
import { historySynthesisPrompt, historySynthesisSchema } from "@/lib/server/coach-history-recall";
import { runAttachment } from "@/lib/server/coach-turn/attachment";
import { deflect } from "@/lib/server/coach-turn/deflect";
import { runFastPath } from "@/lib/server/coach-turn/fast-path";
import { finish } from "@/lib/server/coach-turn/finish";
import { recallHistory } from "@/lib/server/coach-turn/history-recall";
import { readIntent } from "@/lib/server/coach-turn/intent";
import { armTurn } from "@/lib/server/coach-turn/kit";
import { prepareModelTurn } from "@/lib/server/coach-turn/model-context";
import { runModelLoop } from "@/lib/server/coach-turn/model-loop";
import { newModelState } from "@/lib/server/coach-turn/model-state";
import { modelReply } from "@/lib/server/coach-turn/reply";
import { openTurn, passHealthGate, startTurn } from "@/lib/server/coach-turn/setup";
import type { CoachModel, StageDeps, Turn } from "@/lib/server/coach-turn/types";

export type TurnDeps = StageDeps & {
  generate?: typeof generateStructured;
  /** Owner request 2026-10-02: test double for the OpenRouter lane, same role as `generate`
   *  above for the Gemini one. */
  generateOpenRouter?: typeof generateOpenRouter;
};

/**
 * The coach's model calls. They stay in this file: lib/ai/call-registry.ts registers it as the
 * `coach` purpose's call site and counts the `generate(` and `coachTurnPayload(` calls in it.
 * `isOpenRouterModelId` (lib/ai/models.ts) is the one place that decides, per model id, whether a
 * call goes to the Gemini adapter or lib/ai/openrouter.ts — COACH_PROVIDER=openrouter routes the
 * PRIMARY id there, and model-loop.ts's capacity fallback routes the pinned OpenRouter model
 * there the same way, so every caller of `step`/`synthesizeHistory` stays provider-agnostic.
 */
function coachModel(turn: Turn, deps: TurnDeps): CoachModel {
  const { userId, admin, req } = turn;
  const generate = deps.generate ?? generateStructured;
  const generateOR = deps.generateOpenRouter ?? generateOpenRouter;
  const responseSchema = turnStepWireSchemaFor(turn.today);
  return {
    responseSchema,
    synthesizeHistory: (sources) => isOpenRouterModelId(COACH_MODEL_ID)
      ? generateOR({
        userId, admin, modelId: COACH_MODEL_ID, schema: historySynthesisSchema,
        payload: coachOpenRouterPayload(historySynthesisPrompt(req.text, sources)),
        timeoutMs: 10_000, attemptTimeoutMs: COACH_ATTEMPT_TIMEOUT_MS, temperature: 0,
        maxOutputTokens: 700,
      })
      : generate({
        userId, admin, schema: historySynthesisSchema,
        route: { provider: "google", modelId: COACH_MODEL_ID },
        payload: coachTurnPayload(historySynthesisPrompt(req.text, sources)),
        timeoutMs: 10_000, attemptTimeoutMs: COACH_ATTEMPT_TIMEOUT_MS,
        maxOutputTokens: 700, temperature: 0,
      }),
    step: (modelId, transcript, remainingMs, onText) => isOpenRouterModelId(modelId)
      ? generateOR({
        userId, admin, modelId, schema: responseSchema, providerSchema: turnStepProviderSchema,
        payload: coachOpenRouterPayload(transcript),
        timeoutMs: Math.max(1, Math.min(PER_CALL_TIMEOUT_MS, remainingMs)),
        attemptTimeoutMs: COACH_ATTEMPT_TIMEOUT_MS, temperature: COACH_TEMPERATURE,
        maxOutputTokens: TURN_LIMITS.maxOutputTokens,
        // 2026-10-02 Grok audit: the same T6 §5 reasoning as the Gemini branch below — the PRIMARY
        // OpenRouter model has a fallback waiting (another OpenRouter model, or Gemini), so its
        // first capacity failure is abandoned at once rather than spending RETRIES's own retry on
        // a model already known to be out of capacity.
        abandonOnCapacity: modelId === COACH_MODEL_ID,
        onText,
      })
      : generate({
        userId, schema: responseSchema, providerSchema: turnStepProviderSchema, admin,
        route: { provider: "google", modelId },
        payload: coachTurnPayload(transcript),
        // Never let one attempt eat the whole turn: cap it at PER_CALL_TIMEOUT_MS, or at
        // whatever is left of the turn when that is smaller.
        timeoutMs: Math.max(1, Math.min(PER_CALL_TIMEOUT_MS, remainingMs)),
        attemptTimeoutMs: COACH_ATTEMPT_TIMEOUT_MS,
        temperature: COACH_TEMPERATURE,
        maxOutputTokens: TURN_LIMITS.maxOutputTokens,
        // T6 §5: a model with no capacity is abandoned on its FIRST answer, not after its whole
        // retry budget, because there is a second model to spend the rest of the turn on.
        abandonOnCapacity: modelId === COACH_MODEL_ID,
        onText,
      }),
  };
}

function assertEnabled(): void {
  if (!coachEnabled()) throw new HttpError(404, "not_found", "No such route.");
}

export async function runTurn(
  client: SupabaseClient, admin: SupabaseClient, userId: string,
  req: CoachTurnRequest, deps: TurnDeps = {}
): Promise<CoachTurnResponse> {
  assertEnabled();
  const turn = startTurn(client, admin, userId, req, deps);
  const model = coachModel(turn, deps);
  if (req.attachment) return runAttachment(turn, req.attachment);

  // ---- setup reads, then the answers that need no model ------------------------------
  const opened = await openTurn(turn);
  if (opened.kind === "replay") return opened.response;  // no ai_calls row, no second model call
  const { turn: open, started } = opened;
  const deflected = deflect(open);
  if (deflected) return finish(open, deflected);
  const recalled = await recallHistory(open, started, model);
  if (recalled) return finish(open, recalled);

  // ---- the retention / health-context gate, then the Jev fast path -------------------
  const kit = armTurn(open, await passHealthGate(open, started));
  const intent = await readIntent(open, started);
  const fast = await runFastPath(open, kit, intent);
  if (fast.kind !== "miss") return finish(open, fast);

  // ---- the loop ------------------------------------------------------------------------
  const { env, transcript } = await prepareModelTurn(open, kit, intent, fast.intentReason);
  const state = newModelState(transcript, fast.preGroundMs);
  await runModelLoop(open, kit, env, state, model);
  return finish(open, await modelReply(open, kit, env, state, intent));
}
