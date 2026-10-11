/**
 * Before any answer: the turn's clocks, the one round of setup reads (idempotent replay, thread,
 * seq), the turn budget, chat capacity, and the health-context gate that every model-or-Jev path
 * passes.
 */

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ATTESTATION_REFUSED_CODE, healthContextRefused } from "@/lib/ai/attestation";
import { COACH_MODEL_ID } from "@/lib/ai/models";
import { ASSISTANT_NAME } from "@/lib/brand";
import { TURN_REPLY_DEADLINE_MS, TURN_SAVE_DEADLINE_MS } from "@/lib/coach/turn";
import { threadKindFor, type CoachTurnRequest, type CoachTurnResponse } from "@/lib/coach/types";
import { HttpError } from "@/lib/server/auth";
import { reserveTurn } from "@/lib/server/coach";
import { assertChatCapacity, nextSeq, persist, resolveThread, storedTurn, threadHistory,
  type MessageRow } from "@/lib/server/coach-threads";
import { accountClock } from "@/lib/server/day-context";
import { readPolicyProfile } from "@/lib/server/policy-profile";
import { beforeDeadline, LATE, settle, TIMEOUT_MESSAGE, unwrap, type Settled }
  from "@/lib/server/coach-turn/deadline";
import type { OpenTurn, StageDeps, Turn } from "@/lib/server/coach-turn/types";

export type ThreadHistory = Awaited<ReturnType<typeof threadHistory>>;
export type PolicyProfileRead = Awaited<ReturnType<typeof readPolicyProfile>>;

/** Reads started with the setup round that only the later stages wait for. */
export type Started = {
  profile: Promise<Settled<PolicyProfileRead>>;
  history: Promise<ThreadHistory>;
};

/** The request's clocks and the bounded save. Nothing is read yet. */
export function startTurn(
  client: SupabaseClient, admin: SupabaseClient, userId: string,
  req: CoachTurnRequest, deps: StageDeps,
): Turn {
  // The phone's 40 s deadline starts when it sends, so the turn's budget starts here too — not
  // after the database reads and the intent call, which took ~9 s on 2026-09-23.
  const realStartedAt = deps.startedAt ?? Date.now();
  const replyDeadlineAt = realStartedAt + (deps.replyDeadlineMs ?? TURN_REPLY_DEADLINE_MS);
  const saveDeadlineAt = replyDeadlineAt + (TURN_SAVE_DEADLINE_MS - TURN_REPLY_DEADLINE_MS);
  /** Saving the turn, bounded: late, the phone gets the retryable 503 while it still waits. */
  const save = async (...args: Parameters<typeof persist>): Promise<MessageRow[]> => {
    const saved = await beforeDeadline(() => persist(args[0], args[1], args[2], args[3],
      args[4], threadKindFor(req.surface, req.scope), admin), saveDeadlineAt);
    if (saved === LATE) throw new HttpError(503, "timeout", TIMEOUT_MESSAGE);
    return saved;
  };
  const now = deps.now ?? (() => Date.now());
  const newId = deps.newId ?? (() => randomUUID());
  const clock = accountClock(req, now());
  const today = clock.date;
  return { client, admin, userId, req, deps, now, newId, clock, today,
    realStartedAt, replyDeadlineAt, saveDeadlineAt, save };
}

/** The setup reads: a stored reply to this messageId is the replay; otherwise the open turn. */
export async function openTurn(turn: Turn): Promise<
  { kind: "replay"; response: CoachTurnResponse }
  | { kind: "open"; turn: OpenTurn; started: Started }
> {
  const { client, userId, req, now, newId, replyDeadlineAt } = turn;
  // ---- one round of reads -------------------------------------------------------------
  // None of these needs another's answer, and one after another they were seven round trips
  // before the first model call (2026-09-23: ~9 s from request to model). Each result is still
  // APPLIED in the order the checks always ran — replay, thread, seq, then the profile
  // after deflection — so a failing read reports exactly the error it did when sequential.
  const newThreadId = req.threadId === null ? newId() : null;
  // The profile and the history start now too, but only the model path waits for them: a replay
  // or a deflection answers without (Sol r4).
  // Phase 13 slice 4: the constraint row and the confirmed profile rules, in the same one round.
  const profileStarted = settle(readPolicyProfile(client, userId, new Date(now())));
  const historyStarted = threadHistory(client, req.threadId).catch(() => (
    { summary: null, messages: [] as ThreadHistory["messages"], pendingDraft: null }));
  const setup = await beforeDeadline(() => Promise.all([
    settle(storedTurn(client, userId, req.messageId,
      { provider: "gemini", modelId: "" },
      { threadId: req.threadId, kind: threadKindFor(req.surface, req.scope) })),
    settle(resolveThread(client, userId, req.threadId, () => newThreadId as string,
      threadKindFor(req.surface, req.scope))),
    settle(nextSeq(client, req.threadId ?? newThreadId as string)),
  ]), replyDeadlineAt);
  // Reads that have not answered by the reply deadline leave nothing to save a reply into (no
  // thread, no seq), so the phone gets the retryable 503 while it is still waiting (review r3).
  if (setup === LATE) throw new HttpError(503, "timeout", TIMEOUT_MESSAGE);
  const [storedRead, threadRead, seqRead] = setup;
  const stored = unwrap(storedRead);
  if (stored) return { kind: "replay", response: stored };
  if (req.threadId === null && !req.surface) {
    const checked = await beforeDeadline(() => assertChatCapacity(client, userId), replyDeadlineAt);
    if (checked === LATE) throw new HttpError(503, "timeout", TIMEOUT_MESSAGE);
  }

  const threadId = unwrap(threadRead);
  const seq = unwrap(seqRead);
  // W035: a new turn reserves its budget slot only now, so neither a replay of a saved turn nor a
  // turn refused for chat capacity or an unknown thread spends one.
  const reserved = await beforeDeadline(() => reserveTurn(userId), replyDeadlineAt);
  if (reserved === LATE) throw new HttpError(503, "timeout", TIMEOUT_MESSAGE);
  const base = { thread_id: threadId, user_id: userId };
  const userRow: MessageRow = {
    ...base, id: req.messageId, role: "user", content: req.text, seq,
    tool_calls: [], policy_checks: [], deflected: false, model_id: null, ai_call_id: null,
  };
  return { kind: "open", turn: { ...turn, threadId, seq, base, userRow },
    started: { profile: profileStarted, history: historyStarted } };
}

/**
 * The retention / health-context gate: with a stored condition or note and no recorded retention
 * terms, the turn refuses before the Jev fast path too.
 */
export async function passHealthGate(turn: OpenTurn, started: Started): Promise<PolicyProfileRead> {
  const profileRead = await beforeDeadline(() => started.profile, turn.replyDeadlineAt);
  if (profileRead === LATE) throw new HttpError(503, "timeout", TIMEOUT_MESSAGE);
  // `instances`: the same read's full profile set, shared with the reply check and the proposal.
  const read = unwrap(profileRead);
  // 2026-10-02 DeepSeek audit: provider-aware — COACH_MODEL_ID says which provider this turn's
  // model call is actually headed to (lib/ai/models.ts isOpenRouterModelId), so the gate reads
  // that provider's own attestation instead of assuming Gemini.
  if (healthContextRefused(read.profile, COACH_MODEL_ID)) {
    throw new HttpError(503, ATTESTATION_REFUSED_CODE,
      `Your conditions and notes cannot reach ${ASSISTANT_NAME} until the provider's retention terms are recorded.`);
  }
  return read;
}
