/**
 * The one way a coach turn ends: build the assistant row from the outcome, link its ai_calls row,
 * file the fast path's telemetry, save both rows before the save deadline, start the after-response
 * sanity pass, and build the response.
 */

import { after } from "next/server";
import { AFTER_RESPONSE_BUDGET_MS } from "@/lib/coach/turn";
import { toMessageView } from "@/lib/coach/message-view";
import type { CoachTurnResponse } from "@/lib/coach/types";
import { deterministicSanity } from "@/lib/log/sanity-deterministic";
import { attachDeterministicCoachSanity, hasCoachSanityTargets, startPersistedCoachSanity }
  from "@/lib/server/coach-sanity";
import { COACH_TURN_PURPOSES } from "@/lib/server/coach";
import { lastAiCallId, view, type MessageRow } from "@/lib/server/coach-threads";
import { AI_CALL_LOOKUP_GRACE_MS, beforeDeadline, LATE } from "@/lib/server/coach-turn/deadline";
import { outcomeProvenance, stampProvenance, type TurnOutcome } from "@/lib/server/coach-turn/outcome";
import type { OpenTurn } from "@/lib/server/coach-turn/types";

/** The ai_calls row behind the reply, when a model wrote it. */
async function aiCallLink(turn: OpenTurn, outcome: TurnOutcome): Promise<string | null> {
  const { admin, userId, replyDeadlineAt } = turn;
  if (outcome.kind === "model") {
    // A lookup, not the turn: late, the row is saved without its ai_calls link.
    return beforeDeadline(
      () => lastAiCallId(admin, userId, COACH_TURN_PURPOSES), replyDeadlineAt + AI_CALL_LOOKUP_GRACE_MS,
    ).then((id) => id === LATE ? null : id);
  }
  return lastAiCallId(admin, userId, COACH_TURN_PURPOSES);
}

export async function finish(turn: OpenTurn, outcome: TurnOutcome): Promise<CoachTurnResponse> {
  const { client, userId, req, deps, newId, save, threadId, seq, base, userRow } = turn;
  const id = newId();
  const provenance = outcomeProvenance(outcome);
  const linked = outcome.kind === "model"
    || (outcome.kind === "history_recall" && outcome.synthesisModel !== "");
  let assistantRow: MessageRow = {
    ...base, id, role: "assistant", content: outcome.content, seq: seq + 1,
    // The cards ride with the actions so an idempotent replay returns the same turn (HIGH 7), and
    // so does who produced them: the fast path's Jev-or-app answer is in no other column.
    tool_calls: stampProvenance(outcome.toolCalls, provenance),
    policy_checks: outcome.kind === "model" ? outcome.policyChecks : [],
    deflected: outcome.kind === "deflected",
    model_id: outcome.kind === "model" ? outcome.modelId
      : outcome.kind === "history_recall" ? outcome.synthesisModel || null : null,
    ai_call_id: linked ? await aiCallLink(turn, outcome) : null,
  };
  if (outcome.kind === "fast_path") await outcome.telemetry();
  const hasSanity = outcome.kind === "model" && hasCoachSanityTargets(assistantRow.tool_calls);
  if (hasSanity) {
    assistantRow = { ...assistantRow, tool_calls: attachDeterministicCoachSanity(
      assistantRow.tool_calls, { deterministic: deterministicSanity },
    ) };
  }
  // The rows as saved: a seq another turn took first moves both (W035, audit A151).
  const [savedUser, savedAssistant] = await save(client, threadId, [userRow, assistantRow],
    req.threadId === null ? req.text : null, outcome.kind === "model" ? outcome.memory : undefined);
  assistantRow = { ...assistantRow, seq: savedAssistant.seq };
  let body = outcome.body;
  if (hasSanity) {
    const sanitySignal = AbortSignal.timeout(
      Math.max(1, AFTER_RESPONSE_BUDGET_MS - (Date.now() - turn.realStartedAt)),
    );
    // The reply is saved by now; loading the sanity module must not turn it into a timeout. Late,
    // the card keeps its deterministic sanity state and the Jev pass is skipped (Sol review).
    const sanityDeps = deps.sanity ? null : await beforeDeadline(() => import("@/lib/log/sanity")
      .then((module) => ({
        check: module.checkSanity,
        schedule: (task: () => Promise<void>) => after(task),
      })).catch((error: unknown) => {
        console.error("coach sanity import failed", {
          error: error instanceof Error ? error.message.slice(0, 200) : "unknown error",
        });
        return null;
      }), turn.saveDeadlineAt).then((loaded) => loaded === LATE ? null : loaded);
    const sanity = deps.sanity
      ? deps.sanity(client, userId, assistantRow.id, assistantRow.tool_calls, sanitySignal)
      : sanityDeps ? startPersistedCoachSanity(
        client, userId, assistantRow.id, assistantRow.tool_calls, sanitySignal, sanityDeps,
      ) : null;
    if (sanity) {
      body = { ...body, actions: sanity.actions };
      void sanity.settled;
    }
  }
  const plain = outcome.kind === "deflected"
    || (outcome.kind === "fast_path" && outcome.messages === "plain");
  return {
    threadId, ...body, provenance,
    messages: plain ? [savedUser, assistantRow].map(view) : [savedUser, assistantRow].map(toMessageView),
  };
}
