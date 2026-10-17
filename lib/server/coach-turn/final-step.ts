/**
 * The model's final step: the reply check starts, the actions are grounded and policy-checked,
 * and a reply that claims an action it did not carry gets one correction round. Grounding and the
 * verify call run after the model loop, so they have their own deadline: the reply must be ready
 * while the phone is still waiting (review r1, BLOCK 1).
 */

import { actionsInScope, scopeDropNotice } from "@/lib/coach/scope";
import { withoutListMarkMirrors } from "@/lib/coach/list-mark-confirmation";
import { withoutShoppingMirrors } from "@/lib/coach/shopping-confirmation";
import { claimsAction, groundAndExpandActions } from "@/lib/coach/actions";
import { hydrateComparison } from "@/lib/coach/blocks/hydrate-comparison";
import { INVALID_ARGS_PREFIX } from "@/lib/coach/dispatch";
import { isGenericRefusal, needsRefusalCorrection, REFUSAL_CORRECTION } from "@/lib/coach/refusal-guard";
import { loggedFoodIdentities, type LoggedIdentities } from "@/lib/coach/reply-check";
import { OUT_OF_TIME_GROUNDING, sanitiseReply, TURN_LIMITS, type TurnStep } from "@/lib/coach/turn";
import { claimsChart, heuristic, verifyReply } from "@/lib/coach/verify";
import { applyGroundedActionPolicies } from "@/lib/server/coach-role-advice";
import { beforeDeadline, LATE } from "@/lib/server/coach-turn/deadline";
import type { TurnKit } from "@/lib/server/coach-turn/kit";
import { scanReply, type ModelEnv, type ModelState } from "@/lib/server/coach-turn/model-state";
import { validatedBlocks } from "@/lib/server/coach-turn/outcome";
import type { OpenTurn } from "@/lib/server/coach-turn/types";
import { claimsSkip, gateSkips, SKIP_NOT_CONFIRMED } from "@/lib/server/coach-turn/skip-gate";

/** The recipe widget's answer to a reply that says it logged or changed something. */
export const RECIPE_WIDGET_NO_WRITE =
  "Nothing was logged or changed from here. Tap Log it on a recipe to log it.";

/** "retry" when the model is asked once more for the action its reply claimed. */
/** The food names a final step logs, read before grounding so the reply scan can
 *  exempt them even if `groundedLogged` below never settles. */
function loggedNamesOf(actions: readonly unknown[]): string[] {
  return actions.flatMap((action) => {
    const a = action as { kind?: string; items?: { name?: unknown }[]; names?: unknown[] };
    if (a.kind === "log_meal") {
      return (a.items ?? []).flatMap((i) => typeof i.name === "string" ? [i.name] : []);
    }
    return [];
  });
}

export async function settleFinalStep(
  turn: OpenTurn, kit: TurnKit, env: ModelEnv, state: ModelState,
  finalStep: Extract<TurnStep, { kind: "final" }>, round: number,
): Promise<"retry" | "done"> {
  const { client, admin, userId, req, deps, newId, replyDeadlineAt } = turn;
  const { profile, turnAbort, turnPorts } = kit;
  const { context } = env;
  const verify = deps.verifyReply ?? verifyReply;
  // The recipe widget applies no coach action (it logs only through its own "Log it" tap), so the
  // model's actions there are dropped here, before grounding, whatever the model emitted (2026-10-03
  // audit): the fast path already refused them, and this is the model path's half.
  const recipeWidget = req.surface === "recipes";
  if (recipeWidget && (finalStep.actions ?? []).length > 0) finalStep.actions = [];
  // Scoped AI input: a meal card or a page may only run its own actions, aimed at its own slot and
  // date (lib/coach/scope.ts). Dropped before grounding, like the recipe widget's.
  // A dropped action is said, not silent (audit 2026-10-10 P18): its clarification below also
  // ends the claim-correction round, which the same filter could never satisfy.
  let scopeDropped: string | null = null;
  if (req.scope && finalStep.actions) {
    const kept = actionsInScope(finalStep.actions, req.scope);
    const dropped = finalStep.actions.filter((action) => !kept.includes(action));
    if (dropped.length > 0) scopeDropped = scopeDropNotice(req.scope, dropped.map((a) => a.kind));
    finalStep.actions = kept;
  }
  // Live 2026-10-03: "Find me an easy chicken dinner recipe" got "I'm sorry, I cannot fulfill that
  // request." with no tool call, copied from earlier apologies in the thread. One corrective round.
  if (round < TURN_LIMITS.maxToolCalls && needsRefusalCorrection({
    text: finalStep.text,
    actionCount: (finalStep.actions ?? []).length,
    answeredToolCalls: state.toolCalls.filter((call) =>
      call.ok || !(call.error ?? "").startsWith(INVALID_ARGS_PREFIX)).length,
    ask: env.intent,
    alreadyCorrected: state.refusalCorrectionRequested,
  })) {
    state.refusalCorrectionRequested = true;
    state.transcript.push(REFUSAL_CORRECTION);
    return "retry";
  }
  // Live 2026-10-02: suggest_options answered "I couldn't find a snack option that fits your food
  // rules yet…" and the model replied "I'm sorry, I cannot fulfill that request." With no card and
  // no action, the tool's own explanation is the honest answer, so it replaces the model's text —
  // but only when suggest_options was the turn's only tool or the reply is a bare refusal: a prose
  // answer built from get_entries or lookup in the same turn is kept (Grok review 2026-10-03).
  const onlySuggest = state.toolCalls.every((call) => call.name === "suggest_options");
  if (state.suggestMessage && state.composed.length === 0 && (finalStep.actions ?? []).length === 0
      && (onlySuggest || isGenericRefusal(finalStep.text))) {
    finalStep.text = state.suggestMessage;
  }
  const groundStarted = Date.now();
  // 2026-10-02 DeepSeek audit (finding #3): the reply scan needs the turn's actually-GROUNDED
  // log_meal identities to exempt them from the prose check (lib/server/reply-check.ts
  // resolveLoggedIdentities) — not the raw, pre-grounding names below, which stay only as that
  // resolver's fallback for a `groundedLogged` that never settles. This deferred resolves once
  // `groundAll` below settles, whichever way; the scan only awaits it where it needs the exemption,
  // well into its own catalog work, so it costs no latency.
  let resolveGroundedLogged!: (value: LoggedIdentities) => void;
  const groundedLogged = new Promise<LoggedIdentities>((resolve) => {
    resolveGroundedLogged = resolve;
  });
  // Runs beside grounding and coach-verify, never after them (§6 row 5).
  state.replyScan = scanReply(turn, kit, state, sanitiseReply(finalStep.text),
    withoutListMarkMirrors(withoutShoppingMirrors(finalStep.suggestions ?? [], finalStep.actions ?? []),
      finalStep.actions ?? []),
    loggedNamesOf(finalStep.actions ?? []), groundedLogged, finalStep.actions ?? []);
  const groundAll = async () => {
    const grounded = await groundAndExpandActions(userId, finalStep.actions ?? [], profile, {
      searchFoods: turnPorts.searchFoods,
      newActionId: newId,
      // An Eats/Avoid mark is about the food, so it reaches every catalog row that IS that food
      // by base name — one watermelon row marked left the other five free to come back unflagged
      // (readiness pass 2026-09-18).
      sameNameRefIds: async (uid, catalogName) => {
        const { sameNameRefIds } = await import("@/lib/server/catalog-names");
        return sameNameRefIds(client, admin, uid, catalogName);
      },
      // T6 §3: delete_entry and move_entry need no grounding, but they must name an entry the user
      // really has. The context block already read today's; anything else drops the action.
      // Everything this turn could legitimately name: today's entries from the context block,
      // anything `get_entries` returned during the turn, and the ids the client says it logged
      // this session but the outbox has not landed yet. Only when ALL THREE are missing is
      // there no list to check against — a failed context read with entries from the phone in
      // hand is still a list (Grok pass 2, MEDIUM 3).
      knownEntries: context === null && state.seenEntries.size === 0
          && (req.recentEntries?.length ?? 0) === 0
        ? undefined
        : async () => new Map([
          ...(context?.day.entries ?? []).map((entry) =>
            [entry.entryId, `${entry.name} at ${entry.at}`] as const),
          ...state.seenEntries,
          ...(req.recentEntries ?? []).map((entry) =>
            [entry.entryId, entry.what] as const),
        ]),
    });
    const policy = await applyGroundedActionPolicies(admin, userId, grounded.actions, profile);
    return { grounded, policy };
  };
  const groundedFinal = await beforeDeadline(groundAll, replyDeadlineAt);
  state.groundMs += Date.now() - groundStarted;
  if (groundedFinal === LATE) {
    // Grounding never returned in time: nothing was actually logged, so the scan's exemption must
    // exempt nothing either (fail closed) — never the raw pre-grounding names.
    resolveGroundedLogged({ names: new Set(), refs: new Set() });
    turnAbort.abort();
    // Nothing was written: actions are only offered to the phone, never applied here.
    state.actions = [];
    state.logPolicyNotices = [];
    state.recipeRefusals = [];
    state.actionClarifications = [OUT_OF_TIME_GROUNDING];
    state.groundingLate = true;
    return "done";
  }
  // Two or more composed options and no other block: the code-built comparison card.
  if (state.blocks.length === 0 && state.composed.length >= 2) {
    state.blocks = validatedBlocks(hydrateComparison(newId(), state.composed));
  }
  const { grounded, policy } = groundedFinal;
  // A skip clears a meal: only as the yes to a skip offered with preview_skip on an earlier turn.
  const skips = gateSkips({
    actions: policy.actions, userText: req.text, lastCoachMessage: env.lastCoachMessage ?? null,
    previewedThisTurn: state.toolCalls.some((call) => call.name === "preview_skip"),
  });
  state.actions = skips.actions;
  // The real, grounded log_meal identities — an action log-meal.ts turned into a clarification
  // (no catalog row grounded it) contributes nothing here, by design (finding #3 above).
  resolveGroundedLogged(loggedFoodIdentities(policy.actions));
  state.logPolicyNotices = policy.logNotices;
  state.recipeRefusals = policy.recipeRefusals;
  state.actionClarifications = [...grounded.clarifications, ...policy.recipeRefusals,
    ...(skips.dropped ? [SKIP_NOT_CONFIRMED] : []), ...(scopeDropped ? [scopeDropped] : [])];
  const reply = sanitiseReply(finalStep.text);
  if (scopeDropped && (claimsSkip(reply) || claimsAction(reply))) state.replyClaimDropped = true;
  const actions = state.actions;
  // Re-audit r1 #2 and #4: a write the server dropped must not stay claimed in the bubble. A
  // dropped skip whose prose says it happened, and recipe-widget prose that says anything was
  // logged or changed (nothing there is ever an action), are replaced by the plain sentence even
  // when the reply ends in a question. The local claim check is enough: no correction round can
  // put the write back.
  if (skips.dropped && (claimsSkip(reply) || claimsAction(reply))) state.replyClaimDropped = true;
  if (recipeWidget && (claimsSkip(reply) || claimsAction(reply))) {
    state.actionClarifications = [...state.actionClarifications, RECIPE_WIDGET_NO_WRITE];
    state.replyClaimDropped = true;
  }
  const verdict = actions.length === 0 && !recipeWidget
    ? await beforeDeadline(() => verify({ reply, actions, toolResults: state.toolCalls }, { userId }),
      replyDeadlineAt)
    : null;
  // Out of time, the verify call falls back to the same heuristic it uses without Jev.
  const claimFlagged = verdict === null ? false
    : verdict === LATE ? heuristic(reply, actions) : verdict.flagged;
  if (state.claimCorrectionRequested) {
    state.claimWithoutAction = state.actionClarifications.length === 0 && claimFlagged;
    return "done";
  }
  if (state.actionClarifications.length === 0 && claimFlagged) {
    if (round < TURN_LIMITS.maxToolCalls) {
      state.claimCorrectionRequested = true;
      state.transcript.push(
        "SYSTEM: Your reply claimed an action but `actions` was empty; reply again with the same final and the action in `actions`.",
      );
      return "retry";
    }
    state.claimWithoutAction = true;
  }
  // A reply that points at a chart or breakdown with no block gets one correction round, no more.
  if (!state.claimCorrectionRequested && !recipeWidget && actions.length === 0 && state.composed.length === 0
    && (finalStep.suggestions ?? []).length === 0 && claimsChart(reply, state.blocks.length)
    && round < TURN_LIMITS.maxToolCalls) {
    state.claimCorrectionRequested = true;
    state.transcript.push(
      "SYSTEM: Your reply refers to a chart or breakdown but no block came with it; reply again with the block, or without that reference.",
    );
    return "retry";
  }
  return "done";
}
