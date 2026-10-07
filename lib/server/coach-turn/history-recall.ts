/**
 * A read of a saved conversation (lib/server/coach-history-recall.ts): owner-scoped excerpts, and a
 * cited synthesis of them when the model answers in time and every sentence is supported.
 */

import { healthContextRefused } from "@/lib/ai/attestation";
import { COACH_MODEL_ID, isOpenRouterModelId } from "@/lib/ai/models";
import { isPastThreadQuestion } from "@/lib/coach/history-recall";
import { HttpError } from "@/lib/server/auth";
import { citedHistoryAnswer, recallSavedMessages } from "@/lib/server/coach-history-recall";
import { beforeDeadline, LATE, TIMEOUT_MESSAGE, unwrap } from "@/lib/server/coach-turn/deadline";
import type { TurnOutcome } from "@/lib/server/coach-turn/outcome";
import type { Started } from "@/lib/server/coach-turn/setup";
import type { CoachModel, OpenTurn } from "@/lib/server/coach-turn/types";

export async function recallHistory(
  turn: OpenTurn, started: Started, model: CoachModel,
): Promise<TurnOutcome | null> {
  const { client, userId, req, replyDeadlineAt } = turn;
  // A single, past-only question about this active chat is an explicit read of its saved
  // conversation. Route it through the same owner-scoped evidence path before meal-advice
  // checking: quoting an earlier food idea is not a new food recommendation.
  const currentThreadRecall = !req.historySourceThreadId && req.threadId
    && !req.surface && isPastThreadQuestion(req.text);
  if (!(req.historySourceThreadId || currentThreadRecall)) return null;
  const lookup = await beforeDeadline(() => recallSavedMessages(
    client, userId, (req.historySourceThreadId ?? req.threadId) as string, req.text,
    { includeNeighbors: !!currentThreadRecall }), replyDeadlineAt);
  if (lookup === LATE) throw new HttpError(503, "timeout", TIMEOUT_MESSAGE);
  let content = lookup.answer;
  let synthesisModel = "";
  if (lookup.sources.length) {
    try {
      const profileRead = await beforeDeadline(() => started.profile,
        Math.min(replyDeadlineAt - 3_000, Date.now() + 12_000));
      if (profileRead !== LATE) {
        // 2026-10-02 DeepSeek audit: provider-aware, same as setup.ts's passHealthGate — the
        // synthesis call below may run on OpenRouter (coachModel.synthesizeHistory), so the gate
        // reads COACH_MODEL_ID's provider instead of assuming Gemini.
        if (!healthContextRefused(unwrap(profileRead).profile, COACH_MODEL_ID)) {
          const synthesis = await beforeDeadline(() => model.synthesizeHistory(lookup.sources),
            Math.min(replyDeadlineAt - 3_000, Date.now() + 12_000));
          const grounded = synthesis === LATE ? null
            : citedHistoryAnswer(synthesis, lookup.sources, lookup.matchTerms);
          if (grounded) {
            content = grounded;
            synthesisModel = COACH_MODEL_ID;
          }
        }
      }
    } catch {
      // An unavailable or uncited model answer never replaces the cited saved excerpts.
    }
  }
  return {
    kind: "history_recall", content, synthesisModel,
    toolCalls: { historySources: lookup.sources.map((source) => ({
      id: source.id, threadId: source.threadId, seq: source.seq,
      createdAt: source.createdAt, title: lookup.title, matchTerms: lookup.matchTerms,
    })) },
    body: {
      suggestions: [], actions: [], draft: null, composed: [], deflected: false,
      toolsUsed: [],
      // 2026-10-02 DeepSeek audit: synthesizeHistory (lib/server/coach-turn.ts coachModel) routes
      // to OpenRouter under the same rule reply.ts uses for the ordinary model loop — the stored
      // provider must say which one actually answered, not assume Gemini.
      model: { provider: isOpenRouterModelId(synthesisModel) ? "openrouter" : "gemini",
        modelId: synthesisModel },
      timings: { model: 0, ground: 0 },
    },
  };
}
