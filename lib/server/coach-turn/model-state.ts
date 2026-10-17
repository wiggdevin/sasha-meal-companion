/**
 * The Gemini turn's working state: what the model loop has gathered so far (tool results, cards,
 * evidence, the grounded actions) and what the reply stage turns into the saved answer.
 */

import type { CoachAction } from "@/lib/coach/actions";
import type { ArgIssue } from "@/lib/coach/dispatch";
import type { BlockHydrationContext } from "@/lib/coach/blocks";
import type { ComposedMeal } from "@/lib/coach/compose";
import type { LookupSource } from "@/lib/coach/lookup-types";
import type { EvidenceByName } from "@/lib/coach/policy";
import type { ClassifiedAsk } from "@/lib/coach/refusal-guard";
import type { RawSuggestion, TurnStep } from "@/lib/coach/turn";
import type { CoachDraft } from "@/lib/coach/types";
import type { UiBlock } from "@/lib/coach/ui-blocks";
import { COACH_MODEL_ID } from "@/lib/ai/models";
import type { buildCoachContext } from "@/lib/server/coach-context";
import { REPLY_CHECK_BUDGET_MS, startReplyScan, type ReplyScan } from "@/lib/server/reply-check";
import type { LoggedIdentities } from "@/lib/coach/reply-check";
import type { TurnKit } from "@/lib/server/coach-turn/kit";
import type { OpenTurn } from "@/lib/server/coach-turn/types";

/** Read once before the loop: the day context and the block hydration it feeds. */
export type ModelEnv = {
  context: Awaited<ReturnType<typeof buildCoachContext>> | null;
  blockContext: BlockHydrationContext;
  /** The Jev intent and its confidence, or null when the pre-pass did not answer. */
  intent: ClassifiedAsk;
  /** The coach's last message in this thread, so a skip_slot can be checked against its offer. */
  lastCoachMessage?: string | null;
};

/** A failed tool call, described without any of the person's words. */
export type ToolFailure =
  | { kind: "invalid_args"; args: ArgIssue[] }
  | { kind: "refused" } // per-turn cap or bad-args limit reached
  | { kind: "unknown_tool" }
  | { kind: "threw"; errorName: string; status?: number };

export type ModelState = {
  transcript: string[];
  /** Which model actually answered. It starts as the coach pin, and T6 §5 may move it once. */
  modelId: string;
  /** Why the turn left the pinned model, when it did — reported beside the model it answered on. */
  fallbackReason: "capacity" | "failed" | null;
  toolCalls: { name: string; ok: boolean; error?: string; result?: unknown;
    /** Why a failed call failed, as codes only (no values, no error text); logged by logFallback. */
    failure?: ToolFailure }[];
  toolsUsed: string[];
  /** Per tool, the calls that ran and the calls refused for bad arguments, against its cap. */
  toolRuns: Record<string, { ran: number; invalid: number }>;
  draft: CoachDraft | null;
  composed: ComposedMeal[];
  blocks: UiBlock[];
  /** Entries `get_entries` returned during this turn, so a later action may name one of them. */
  seenEntries: Map<string, string>;
  step: TurnStep;
  actions: CoachAction[];
  actionClarifications: string[];
  recipeRefusals: string[];
  logPolicyNotices: string[];
  claimCorrectionRequested: boolean;
  /** A generic refusal to a food ask was sent back once (lib/coach/refusal-guard.ts). */
  refusalCorrectionRequested: boolean;
  /** The model's own `abort` step was sent back once (lib/coach/turn.ts ABORT_CORRECTION). */
  abortCorrectionRequested: boolean;
  claimWithoutAction: boolean;
  /** The reply claims a write the server dropped (an unconfirmed skip, any write on the recipe
   *  widget): the clarification replaces it even when it ends in a question (re-audit r1 #2, #4). */
  replyClaimDropped: boolean;
  /** Grounding the final reply ran out of time: the reply says so, whatever the model wrote. */
  groundingLate: boolean;
  /** Phase 13 §3.3: every `lookup` source this turn found, shown with the reply (review r1). */
  lookupSources: LookupSource[];
  /** suggest_options' own explanation when it built no cards (no fit, no foods, no target), or
   *  the refusal it raised for the person (rules to review, recipes not enabled). */
  suggestMessage: string | null;
  used: number;
  // T0 §1: the two hops only the server can time. `model` is every generate call this turn spent,
  // `ground` is what grounding the actions cost — the client files both with its own marks.
  modelMs: number;
  groundMs: number;
  /**
   * The evidence behind each food name the turn actually searched, keyed by name (last search
   * wins). Without it the policy pass has no allergen tags and can only answer "unverified"; a
   * name the model never searched has no entry and stays unverified by design.
   */
  evidence: EvidenceByName;
  replyScan: { text: string; scan: Promise<ReplyScan> } | null;
};

export function newModelState(transcript: string[], preGroundMs: number): ModelState {
  return {
    transcript,
    modelId: COACH_MODEL_ID,
    fallbackReason: null,
    toolCalls: [],
    toolsUsed: [],
    toolRuns: {},
    draft: null,
    composed: [],
    blocks: [],
    seenEntries: new Map<string, string>(),
    step: { kind: "abort", reason: "empty_tool_step" },
    actions: [],
    actionClarifications: [],
    recipeRefusals: [],
    logPolicyNotices: [],
    claimCorrectionRequested: false,
    refusalCorrectionRequested: false,
    abortCorrectionRequested: false,
    claimWithoutAction: false,
    replyClaimDropped: false,
    groundingLate: false,
    lookupSources: [],
    suggestMessage: null,
    used: 0,
    modelMs: 0,
    groundMs: preGroundMs,
    evidence: {},
    replyScan: null,
  };
}

/** §6 row 5: the reply check, started the moment a final reply exists, on its own deadline. */
export function scanReply(
  turn: OpenTurn, kit: TurnKit, state: ModelState, text: string, named: RawSuggestion[],
  loggedNames: readonly string[] = [],
  // 2026-10-02 DeepSeek audit (finding #3): the turn's GROUNDED log_meal identities, resolved by
  // lib/server/coach-turn/final-step.ts once groundAll() settles — `state.actions`/`loggedNames`
  // above are both pre-grounding at the point this runs, and must only ever be the fallback for
  // this deferred never settling in time (lib/server/reply-check.ts resolveLoggedIdentities).
  groundedLogged?: Promise<LoggedIdentities>,
  pendingActions?: readonly { kind: string; names?: unknown }[],
): { text: string; scan: Promise<ReplyScan> } {
  const { userId, replyDeadlineAt } = turn;
  const { profile, replyPorts } = kit;
  return {
    text, scan: startReplyScan({ userId, text, named, evidence: { ...state.evidence }, profile,
      blockFoods: state.draft?.items.map(({ name, foodRefId }) => ({ name, foodRefId })) ?? [],
      // finding #6: this turn's own log_meal items are the user's record of what they ate, not
      // advice — the scan exempts them from the hard-rule prose check.
      actions: state.actions, loggedNames, groundedLogged, pendingActions },
      replyPorts, Math.min(replyDeadlineAt, Date.now() + REPLY_CHECK_BUDGET_MS)),
  };
}
