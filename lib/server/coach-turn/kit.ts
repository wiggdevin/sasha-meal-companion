/**
 * What the fast path and the model loop share, built once the health gate has passed: the
 * executor and reply-check ports over the profile the gate read, the abort that stops late
 * lookups writing, and the loop's wall-clock budget.
 */

import { makeExecutors } from "@/lib/coach/executors";
import { TURN_LIMITS } from "@/lib/coach/turn";
import { defaultPorts } from "@/lib/server/coach-ports";
import { liveLogEntryExists } from "@/lib/server/coach-unlogged-meal";
import { pinPlanSlot, planSlotOf } from "@/lib/server/coach-turn/plan-slot";
import type { ReplyCheckPorts } from "@/lib/server/reply-check";
import { replyCheckPorts } from "@/lib/server/reply-check-ports";
import type { PolicyProfileRead } from "@/lib/server/coach-turn/setup";
import type { OpenTurn } from "@/lib/server/coach-turn/types";

export type TurnKit = ReturnType<typeof armTurn>;

export function armTurn(turn: OpenTurn, gate: PolicyProfileRead) {
  const { client, admin, deps, now, newId, clock } = turn;
  const { profile, instances: profileInstances } = gate;
  // Aborted once the turn stops waiting for its lookups, so they write nothing late (review r2).
  const turnAbort = new AbortController();
  const turnPorts = {
    ...defaultPorts(client, admin, newId, clock, { signal: turnAbort.signal, profile }),
    ...deps.ports,
  };
  // A Plan-sheet turn always plans one known meal slot, on the fast path and the model path alike.
  const executors = pinPlanSlot(makeExecutors(turnPorts), planSlotOf(turn.req));
  const replyPorts: ReplyCheckPorts = {
    ...replyCheckPorts(turnPorts.searchFoods, profileInstances), ...deps.replyCheck,
  };
  const startedAt = now();
  const wallClockBudgetMs = deps.wallClockMs ?? TURN_LIMITS.wallClockMs;
  return { profile, profileInstances, turnAbort, turnPorts, executors, replyPorts,
    logEntryExists: deps.logEntryExists ?? liveLogEntryExists, startedAt,
    wallClockBudgetMs };
}
