/**
 * What every stage of the coach turn shares (lib/server/coach-turn.ts is the orchestrator): the
 * request, its clocks and the bounded save, then — once the setup reads have answered — the
 * thread the reply is saved into.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ZodType } from "zod";
import type { HistorySource } from "@/lib/coach/history-recall";
import type { classifyIntent } from "@/lib/coach/intent";
import type { verifyReply } from "@/lib/coach/verify";
import type { ExecutorPorts } from "@/lib/coach/executors";
import type { TurnStep } from "@/lib/coach/turn";
import type { CoachTurnRequest } from "@/lib/coach/types";
import type { ReplyCheckPorts } from "@/lib/server/reply-check";
import type { AttachmentTurnDeps } from "@/lib/server/coach-attachments";
import type { startPersistedCoachSanity } from "@/lib/server/coach-sanity";
import type { accountClock } from "@/lib/server/day-context";
import type { LogEntryExistsPort } from "@/lib/server/coach-unlogged-meal";
import type { MessageRow, persist } from "@/lib/server/coach-threads";

/** Every injected dependency but the model entry point, which stays with the orchestrator. */
export type StageDeps = {
  ports?: Partial<ExecutorPorts>;
  now?: () => number;
  newId?: () => string;
  classifyIntent?: typeof classifyIntent;
  verifyReply?: typeof verifyReply;
  sanity?: (...args: Parameters<typeof startPersistedCoachSanity> extends [...infer Head, unknown]
    ? Head : never) => ReturnType<typeof startPersistedCoachSanity>;
  attachment?: Pick<AttachmentTurnDeps, "propose">;
  blocks?: { weightUnit?: "lb" | "kg" };
  /** Test doubles for the reply check's reads (lib/server/reply-check-ports.ts). */
  replyCheck?: Partial<ReplyCheckPorts>;
  /** Test double for the next-action chip's account-scoped log existence read. */
  logEntryExists?: LogEntryExistsPort;
  /**
   * Test-only override of the real-time budget `withWallClock` races each model call against.
   * Production always runs the full TURN_LIMITS.wallClockMs; a test shortens it instead of
   * waiting out the real 30s cap.
   */
  wallClockMs?: number;
  /** Test-only override of TURN_REPLY_DEADLINE_MS, like `wallClockMs` above. */
  replyDeadlineMs?: number;
  /**
   * When the request arrived at the route (epoch ms). Every deadline counts from it, so sign-in
   * and body parsing are on the same clock as the phone's. Defaults to the start of runTurn.
   */
  startedAt?: number;
};

/** The request and its clocks, fixed before the first read. */
export type Turn = {
  client: SupabaseClient;
  admin: SupabaseClient;
  userId: string;
  req: CoachTurnRequest;
  deps: StageDeps;
  now: () => number;
  newId: () => string;
  clock: ReturnType<typeof accountClock>;
  today: string;
  /** When the request arrived (epoch ms); every deadline counts from it. */
  realStartedAt: number;
  replyDeadlineAt: number;
  saveDeadlineAt: number;
  /** Saving the turn, bounded: late, the phone gets the retryable 503 while it still waits. */
  save: (...args: Parameters<typeof persist>) => Promise<void>;
};

/** A turn whose setup reads answered: the thread, the next seq and the user's own row. */
export type OpenTurn = Turn & {
  threadId: string;
  seq: number;
  base: { thread_id: string; user_id: string };
  userRow: MessageRow;
};

/**
 * The coach's two Gemini calls. lib/server/coach-turn.ts builds them: lib/ai/call-registry.ts
 * registers that file as the `coach` purpose's call site and counts the calls in it.
 */
export type CoachModel = {
  /** The turn step's wire schema for the account's today. */
  responseSchema: ZodType<TurnStep>;
  /** One cited synthesis of saved-message excerpts (lib/server/coach-history-recall.ts). */
  synthesizeHistory: (sources: HistorySource[]) => Promise<unknown>;
  /** One model step over the transcript, on `modelId`, within `remainingMs`. */
  step: (modelId: string, transcript: string[], remainingMs: number) => Promise<TurnStep>;
};
