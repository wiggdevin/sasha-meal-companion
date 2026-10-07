/**
 * The Gemini tool loop: one model step per round, on the coach pin or — out of capacity — its
 * fallback, until a final reply, an abort, or the tool-call cap. Every call is raced against the
 * turn's wall clock.
 */

import { isCapacityFailure, worthAnotherModel } from "@/lib/ai/adapter";
import { openRouterAttested } from "@/lib/ai/attestation";
import {
  coachOpenRouterFallbackModel, COACH_FALLBACK_MODEL_ID, COACH_MODEL_ID, GEMINI_COACH,
  isOpenRouterModelId,
} from "@/lib/ai/models";
import { openRouterConfigured } from "@/lib/ai/provider-env";
import { ASSISTANT_NAME } from "@/lib/brand";
import { planTurn, TURN_LIMITS, type TurnStep } from "@/lib/coach/turn";
import { HttpError } from "@/lib/server/auth";
import { withWallClock } from "@/lib/server/coach-turn/deadline";
import { settleFinalStep } from "@/lib/server/coach-turn/final-step";
import type { TurnKit } from "@/lib/server/coach-turn/kit";
import type { ModelEnv, ModelState } from "@/lib/server/coach-turn/model-state";
import { runToolBatch } from "@/lib/server/coach-turn/tool-batch";
import type { CoachModel, OpenTurn } from "@/lib/server/coach-turn/types";

export async function runModelLoop(
  turn: OpenTurn, kit: TurnKit, env: ModelEnv, state: ModelState, model: CoachModel,
): Promise<void> {
  const { now } = turn;
  const { startedAt } = kit;
  for (let round = 0; round <= TURN_LIMITS.maxToolCalls; round += 1) {
    const output = await nextStep(turn, kit, state, model);
    const step = planTurn({ toolCallsUsed: state.used, startedAt, now: now(), limits: TURN_LIMITS },
      output);
    state.step = step;
    if (step.kind === "final") {
      if (await settleFinalStep(turn, kit, env, state, step, round) === "retry") continue;
      break;
    }
    if (step.kind !== "tool") break;
    if (await runToolBatch(turn, kit, env, state, step.calls) === "late") break;
  }
}

/**
 * Owner request 2026-10-02 (T8): whether the OpenRouter capacity fallback may be tried at all —
 * `model` (coachOpenRouterFallbackModel()) is pinned, the key is present and the owner's separate
 * OpenRouter attestation (lib/ai/attestation.ts) is recorded. Without the key or attestation,
 * the coach's capacity handling stays on Gemini.
 */
function openRouterFallbackReady(): boolean {
  return openRouterConfigured() && openRouterAttested();
}

function fellBack(state: ModelState, to: string, generateStarted: number): void {
  state.fallbackReason = "capacity";
  console.warn("coach model fell back", {
    from: state.modelId, to, reason: state.fallbackReason,
    after: `${Date.now() - generateStarted} ms`,
  });
  state.modelId = to;
}

/**
 * The genuinely DIFFERENT-key option once the primary (and, when worth it, its same-key fallback)
 * are both spent: OpenRouter's configured fallback when Gemini is primary, Gemini's own pin when
 * OpenRouter is primary (2026-10-02 Grok audit) — COACH_PROVIDER decides which provider's key the
 * primary shares with `COACH_FALLBACK_MODEL_ID`, so it also decides which direction is "different".
 * Reaching Gemini still needs its own attestation, enforced the normal way by callModel on that
 * call (lib/ai/call.ts) — not ready (OpenRouter: no key or not attested)
 * rethrows `lastFailure` unchanged, so a default install ends the turn exactly as it did before
 * the OpenRouter lane existed.
 */
async function tryDifferentKeyFallback(
  openRouterIsPrimary: boolean,
  call: (modelId: string, remainingMs?: number) => Promise<unknown>,
  state: ModelState, generateStarted: number, lastFailure: unknown,
): Promise<unknown> {
  if (openRouterIsPrimary) {
    fellBack(state, GEMINI_COACH, generateStarted);
    return call(GEMINI_COACH);
  }
  const to = coachOpenRouterFallbackModel();
  if (!openRouterFallbackReady()) throw lastFailure;
  fellBack(state, to, generateStarted);
  return call(to);
}

/**
 * A stall is worth another model only while the turn has time for one (live 2026-10-02: the pin
 * "did not answer within 4972ms" with most of the turn left; a stall that spent the whole budget
 * still ends the turn, Grok pass 1, MEDIUM 17).
 */
const STALL_FALLBACK_MS = 5_000;
// Only the provider's own "did not answer within" (Grok audit round 10): any other AbortError is a
// cancel, and a turn that was itself aborted starts no second model.
const stalledWithTime = (e: unknown, remainingMs: number, turnAborted: boolean) => !turnAborted
  && remainingMs >= STALL_FALLBACK_MS && e instanceof Error && /did not answer within/i.test(e.message);

/** One model step, with the T6 §5 capacity fallback (and, past it, T8's cross-provider retry);
 *  any other failure is 503 coach_unavailable. */
async function nextStep(
  turn: OpenTurn, kit: TurnKit, state: ModelState, model: CoachModel,
): Promise<TurnStep> {
  const { realStartedAt } = turn;
  const { wallClockBudgetMs } = kit;
  try {
    const generateStarted = Date.now();
    // Read at each call, so a fallback model gets what the first one left, not a fresh budget.
    const remaining = () => wallClockBudgetMs - (Date.now() - realStartedAt);
    const stalled = (e: unknown) => stalledWithTime(e, remaining(), kit.turnAbort.signal.aborted);
    const call = (modelId: string, remainingMs = remaining()) => withWallClock(
      () => model.step(modelId, state.transcript, remainingMs), remainingMs);
    let generated: unknown;
    try {
      generated = await call(state.modelId);
    } catch (primaryFailure) {
      // Only a model out of CAPACITY is worth trying anything else: a schema refusal is ours and
      // a second model refuses the same reply for the same reason (Grok pass 1, MEDIUM 17).
      if (primaryFailure instanceof HttpError || state.modelId !== COACH_MODEL_ID
          || !(isCapacityFailure(primaryFailure) || stalled(primaryFailure))) {
        throw primaryFailure;
      }
      const lastFailure: unknown = primaryFailure;
      // 2026-10-02 Grok audit: which model shares the PRIMARY's key flips with COACH_PROVIDER —
      // another Gemini model when Gemini is primary, another OpenRouter model (if configured)
      // when OpenRouter is primary. worthAnotherModel's own reasoning (a 429 is the key's own
      // quota, so a second model on it meets the same wall) stays exactly the same either way;
      // only WHICH model counts as "on it" changes.
      const openRouterIsPrimary = isOpenRouterModelId(state.modelId);
      const sameKeyModel = openRouterIsPrimary ? coachOpenRouterFallbackModel() : COACH_FALLBACK_MODEL_ID;
      if (!openRouterIsPrimary && openRouterFallbackReady()) {
        // Live 2026-09-24 and 2026-10-02: the second Gemini model failed right after the first
        // (503, then a timeout that is not a capacity answer and so tried nothing else). With a
        // different provider configured, a Gemini capacity failure goes straight there.
        try {
          generated = await tryDifferentKeyFallback(
            openRouterIsPrimary, call, state, generateStarted, lastFailure);
        } catch (crossFailure) {
          // Grok audit round 5 (MED): an OpenRouter 400, 401 or 503 must not end a turn that the
          // same-key Gemini model can still answer.
          if (crossFailure instanceof HttpError
            || !(worthAnotherModel(primaryFailure) || stalled(primaryFailure))) throw crossFailure;
          fellBack(state, sameKeyModel, generateStarted);
          generated = await call(state.modelId);
        }
      } else if (worthAnotherModel(primaryFailure) || stalled(primaryFailure)) {
        // T6 §5: the pinned coach model answered 503 through its whole retry budget. The fallback
        // is the same provider, the same key and the same schema, so the SAME turn is tried once
        // more on it. The adapter writes its own ai_calls row with that model_id, and the reply
        // and the stored message say which model actually answered.
        fellBack(state, sameKeyModel, generateStarted);
        try {
          generated = await call(state.modelId);
        } catch (fallbackFailure) {
          if (fallbackFailure instanceof HttpError
            || !(isCapacityFailure(fallbackFailure) || stalled(fallbackFailure))) {
            throw fallbackFailure;
          }
          generated = await tryDifferentKeyFallback(
            openRouterIsPrimary, call, state, generateStarted, fallbackFailure);
        }
      } else {
        generated = await tryDifferentKeyFallback(
          openRouterIsPrimary, call, state, generateStarted, lastFailure);
      }
    }
    state.modelMs += Date.now() - generateStarted;
    return model.responseSchema.parse(generated);
  } catch (e) {
    // Every option this turn had (the pin, its same-key fallback, and — when configured — the
    // OpenRouter retry) failed: a bare Error here means all of them did (spec "API changes": 503
    // coach_unavailable). An HttpError — the daily spend cap's 429 — keeps its own status and is
    // not swallowed.
    if (e instanceof HttpError) throw e;
    // Never log the prompt, response, user id, or health context. The bounded error metadata is
    // enough to diagnose failures that happen before the transport can write its ai_calls row.
    console.error("coach generation failed", {
      provider: isOpenRouterModelId(state.modelId) ? "openrouter" : "google",
      modelId: state.modelId,
      error: e instanceof Error
        ? { name: e.name, message: e.message.slice(0, 500) }
        : { name: "UnknownError", message: "non-Error rejection" },
    });
    // An open circuit (lib/ai/circuit.ts) reads a ten-minute window, so it cannot promise a minute.
    const circuitOpen = e instanceof Error && e.message.startsWith("circuit open");
    throw new HttpError(503, "coach_unavailable", circuitOpen
      ? `${ASSISTANT_NAME} is having trouble reaching the model. Try again in a few minutes.`
      : `${ASSISTANT_NAME} is unavailable right now. Try again in a minute.`);
  }
}
