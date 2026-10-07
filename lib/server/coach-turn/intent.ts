/**
 * The Jev intent pre-pass (lib/coach/intent.ts) beside the thread history read, both bounded by
 * the reply deadline, and the privacy-safe intent telemetry row the turn files once.
 */

import { classifyIntent, intentFallbackReason, type IntentFallbackReason, type IntentResult }
  from "@/lib/coach/intent";
import { intentEvent, recordCoachIntentEvent } from "@/lib/server/coach-intent-telemetry";
import { afterResponse, beforeDeadline, LATE } from "@/lib/server/coach-turn/deadline";
import type { Started, ThreadHistory } from "@/lib/server/coach-turn/setup";
import type { OpenTurn } from "@/lib/server/coach-turn/types";

function foodMentions(message: string): string[] | undefined {
  const patterns = [
    /\b(?:add|put)\s+(.+?)\s+(?:to|on)\s+(?:my\s+|the\s+)?(?:eats|avoid)(?:\s+list)?\b/i,
    /\b(?:remove|take)\s+(.+?)\s+(?:from|off)\s+(?:my\s+|the\s+)?(?:eats|avoid)(?:\s+list)?\b/i,
  ];
  for (const pattern of patterns) {
    const name = pattern.exec(message)?.[1]?.replace(/\s+back$/i, "").trim();
    if (name) return [name];
  }
  return undefined;
}

function lastAssistantAskedQuestion(messages: ThreadHistory["messages"]): boolean {
  return /\?\s*$/.test(messages.findLast((message) => message.role === "assistant")?.content ?? "");
}

export type IntentRead = Awaited<ReturnType<typeof readIntent>>;

export async function readIntent(turn: OpenTurn, started: Started) {
  const { admin, userId, req, deps, clock, replyDeadlineAt } = turn;
  const classify = deps.classifyIntent ?? classifyIntent;
  const historyStarted = started.history;
  const intentStarted = Date.now();
  const mentionedFoods = foodMentions(req.text);
  // The Plan sheet is a structured, read-only request for one named meal. Its slot and kind
  // come from the validated wire contract; Jev must not turn "remaining macros" into a snack.
  const structuredPlan = req.planningSlot && req.surface === "plan" ? {
    kind: "meal" as const, count: 3, fitRemaining: true, slot: req.planningSlot,
  } : null;
  // The history read began with the setup reads; it and the intent call are both bounded by the
  // reply deadline (Sol r4). Late, the history is empty and the intent unknown: the model path.
  const [historyRead, classifiedRead] = await Promise.all([
    beforeDeadline(() => historyStarted, replyDeadlineAt),
    structuredPlan ? Promise.resolve(null) : beforeDeadline(() => classify(req.text, {
      now: clock.now,
      userId,
      ...(mentionedFoods ? { foodsMentioned: mentionedFoods } : {}),
    }).catch(() => null), replyDeadlineAt),
  ]);
  const history = historyRead === LATE
    ? { summary: null, messages: [] as ThreadHistory["messages"], pendingDraft: null }
    : historyRead;
  const intentResult = classifiedRead === LATE ? null : classifiedRead;
  const intentMs = Date.now() - intentStarted;
  let telemetryWritten = false;
  // Best-effort telemetry never holds the reply past its deadline (review r3); a slow insert is left
  // to finish unobserved and logs its own failure.
  // It is scheduled after the response, never awaited on the reply path (Sol r4).
  const recordIntent = async (fastPathTaken: boolean, reason: IntentFallbackReason) => {
    afterResponse(() => writeIntent(fastPathTaken, reason));
  };
  const writeIntent = async (fastPathTaken: boolean, reason: IntentFallbackReason) => {
    if (telemetryWritten) return;
    telemetryWritten = true;
    // The deployed telemetry constraint predates this read-only routing hint. Preserve the event
    // without sending a value that the current table rejects; the classifier result still reaches
    // Gemini as `show_chart` through hintLine below.
    const telemetryIntent = intentResult?.intent === "show_chart"
      ? { ...intentResult, intent: "question" as const } as IntentResult
      : intentResult;
    await recordCoachIntentEvent(admin, userId,
      structuredPlan ? {
        intent: "suggest_options", winningConfidence: null, minArgumentConfidence: null,
        fastPathTaken, fallbackReason: reason, latencyMs: 0,
      } : intentEvent(telemetryIntent, fastPathTaken, reason, intentMs))
      .catch((error: unknown) => {
      console.error("coach intent telemetry failed", {
        error: error instanceof Error ? error.message.slice(0, 200) : "unknown error",
      });
    });
  };
  let intentReason: IntentFallbackReason = structuredPlan ? "none" : intentResult === null
    ? "jev_down" : intentFallbackReason(intentResult, req.text);
  if (!structuredPlan && intentReason === "none" && lastAssistantAskedQuestion(history.messages)) {
    intentReason = "clarifying";
  }
  return { history, intentResult, intentMs, structuredPlan, intentReason, recordIntent };
}
