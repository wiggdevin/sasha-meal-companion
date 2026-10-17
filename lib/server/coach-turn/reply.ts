/**
 * The model turn's answer: the reply text the loop earned (or the honest abort, refusal or
 * out-of-time line), the proposal card, the policy pass after the model and before render
 * (lib/server/reply-check.ts, §9 R7), and the next-best-action chip.
 */

import { withoutListMarkMirrors } from "@/lib/coach/list-mark-confirmation";
import { shoppingItemNames, withoutShoppingMirrors } from "@/lib/coach/shopping-confirmation";
import { hydrateNextActionChip } from "@/lib/coach/blocks/hydrate-next-action";
import { accountFoodNames, nextMemory } from "@/lib/coach/memory";
import { appendLookupSources } from "@/lib/coach/lookup-sources";
import { nextBestAction } from "@/lib/coach/next-action";
import {
  abortMessage, listMarkCapNotice, OUT_OF_TIME_GROUNDING, sanitiseReply, TURN_STOP_REASONS,
} from "@/lib/coach/turn";
import { isOpenRouterModelId } from "@/lib/ai/models";
import { mayPropose } from "@/lib/server/coach-proposals";
import { mayProposeTaste, tasteChipsCard } from "@/lib/server/coach-taste";
import type { TasteChipsProposal } from "@/lib/coach/taste-chips-card";
import { FOOD_PREFERENCE_PROFILE_ID } from "@/lib/policy/profiles/food-preference-rule";
import { hasUnloggedMeal } from "@/lib/server/coach-unlogged-meal";
import { INVALID_ARGS_PREFIX } from "@/lib/coach/dispatch";
import type { ReplyCheckResult } from "@/lib/coach/reply-check";
import { checkReplyLive } from "@/lib/server/reply-check";
import { beforeDeadline, LATE } from "@/lib/server/coach-turn/deadline";
import type { IntentRead } from "@/lib/server/coach-turn/intent";
import type { TurnKit } from "@/lib/server/coach-turn/kit";
import { scanReply, type ModelEnv, type ModelState } from "@/lib/server/coach-turn/model-state";
import { validatedBlocks, type TurnOutcome } from "@/lib/server/coach-turn/outcome";
import type { OpenTurn } from "@/lib/server/coach-turn/types";

export async function modelReply(
  turn: OpenTurn, kit: TurnKit, env: ModelEnv, state: ModelState, intent: IntentRead,
): Promise<TurnOutcome> {
  const { req, newId } = turn;
  const { profile, profileInstances } = kit;
  const { step, claimWithoutAction, claimCorrectionRequested, groundingLate, actionClarifications,
    recipeRefusals, logPolicyNotices, lookupSources, evidence, replyScan, replyClaimDropped } = state;
  let { draft, composed, blocks, actions } = state;
  let text = claimWithoutAction
    ? "I have not logged that yet. Tell me the amounts once more and I will."
    : step.kind === "final" ? sanitiseReply(step.text) : abortMessage(
      step.kind === "abort" ? step.reason : "max_tool_calls");
  // §9 R7 (lib/server/reply-check.ts): the live scan reads the model's own prose. A branch below
  // that REPLACES `text` with copy the turn built and checked itself (a recipe refusal, the
  // out-of-time notice) leaves no prose to scan; one that APPENDS a note keeps the prose scanned.
  let scanText: string | null = !claimWithoutAction && step.kind === "final" ? text : null;
  const clarifying = !claimWithoutAction && actionClarifications.length > 0
    && (recipeRefusals.length > 0 || claimCorrectionRequested || replyClaimDropped
      || !/\?\s*$/.test(text));

  // The cards beside the reply; a card that only mirrors a shopping add or a list mark is not advice.
  let named = step.kind === "final" && !groundingLate
    ? withoutListMarkMirrors(withoutShoppingMirrors(step.suggestions ?? [], step.actions ?? []),
      [...(step.actions ?? []), ...actions]) : [];

  // The prose scan judges this turn's shopping items and cards too; with no prose left to scan,
  // they are judged on their own (DeepSeek audit round 10), before any copy counts the actions.
  // An item that may break a hard rule is not added and the reply names it; the rest still go on
  // the list (round 11). A card that may break one is not shown (Grok round 11: profile rules,
  // religious ones included, never reached these cards). A scan that could not finish proves
  // nothing, so then no item is added and no card is shown.
  let shoppingNotice: string | null = null;
  if (scanText === null || clarifying || groundingLate) {
    const items = shoppingItemNames(actions);
    const verdict = items.length === 0 && named.length === 0 ? null
      : await scanReply(turn, kit, state, "", named).scan;
    if (verdict?.hardRulesActive && (!verdict.complete || verdict.failing.length > 0)) {
      const key = (name: string) => name.trim().toLowerCase().replace(/\s+/g, " ");
      const failed = new Set(verdict.failing.map((failure) => key(failure.name)));
      const blocked = (name: string) => !verdict.complete || failed.has(key(name));
      named = named.filter((card) => !blocked(card.name));
      actions = actions.flatMap((action): typeof actions => {
        if (action.kind !== "add_to_shopping_list") return [action];
        const names = action.names.filter((name) => !blocked(name));
        return names.length === 0 ? [] : [{ ...action, names }];
      });
      const dropped = items.filter(blocked);
      if (dropped.length > 0) {
        shoppingNotice = `I did not add ${dropped.join(", ")} to your shopping list: I could not `
          + `confirm ${dropped.length === 1 ? "it fits" : "they fit"} your food rules.`;
      }
    }
  }

  if (clarifying) {
    text = actions.length === 0
      ? actionClarifications.join(" ")
      : [`I have ${actions.length === 1 ? "the other item" : `${actions.length} other items`} ready.`,
          ...actionClarifications].join(" ");
    scanText = null;
  }
  if (groundingLate) {
    // Nothing from this turn is offered when its answer could not be checked in time: no cards,
    // no draft, no suggestions beside a reply that says nothing is set up (review r2, FIX 4).
    text = OUT_OF_TIME_GROUNDING;
    draft = null;
    composed = [];
    blocks = [];
    scanText = null;
  }
  if (shoppingNotice) text = [text, shoppingNotice].join(" ");
  if (!claimWithoutAction && logPolicyNotices.length > 0) {
    text = [text, ...logPolicyNotices].join(" ");
  }
  // 2026-10-01: said once, plainly, when the final step filled its 3-action cap with nothing but
  // a repeatable list mark — the one case the server can tell apart from "three was everything"
  // (evidence 2026-09-20, lib/coach/turn.ts listMarkCapNotice).
  if (!claimWithoutAction && !groundingLate && actionClarifications.length === 0) {
    const capNotice = listMarkCapNotice(step.kind === "final" ? step.actions : undefined);
    if (capNotice) text = [text, capNotice].join(" ");
  }
  if (!claimWithoutAction && !groundingLate) text = appendLookupSources(text, lookupSources);

  // Phase 13 slices 4 and 7 (§4, §9 R5): a stated dietary need, or a stated like or dislike,
  // proposes a confirm card and never applies — only when no tool already filled the turn's one
  // content-block slot. mayPropose is plain string matching, safe on every turn; the catalog is loaded
  // (lib/server/coach-proposals.ts) only when it matched, over the profile rows already read.
  if (blocks.length === 0 && !groundingLate && mayPropose(req.text)) {
    try {
      const { proposalBlock } = await import("@/lib/server/coach-proposals");
      const proposal = await proposalBlock(profileInstances, req.text, newId);
      if (proposal) blocks = validatedBlocks(proposal);
    } catch (error) {
      console.error("dietary profile proposal failed", {
        error: error instanceof Error ? error.message.slice(0, 200) : "unknown error",
      });
    }
  }

  // ---- the policy pass: after the model, before render (lib/server/reply-check.ts, §9 R7) ----
  const scan = scanText === null ? null
    : replyScan?.text === scanText ? replyScan.scan : scanReply(turn, kit, state, scanText, named).scan;
  const checked = await checkReplyLive({ text, named, draft, actions, evidence, profile }, scan);
  const { content, suggestions, draftChecks, textChecks } = checked;
  logFallback(state, claimWithoutAction, checked.replaced);
  draft = checked.draft;
  actions = checked.actions;
  if (content !== text) {
    // A re-ask carries no food: no composed meal, no food card beside it (§9 R7).
    composed = [];
    blocks = blocks.filter((b) => b.kind === "dietary_profile_proposal");
  }

  // Phase 18 W5b-2 (D9 item 3): a stated taste — a texture or flavour the user cannot stand, a
  // cuisine they grew up on — proposes confirmable chips beside a delivered reply. Dark until
  // TASTE_CHIPS_ENABLED; text the local safety check keeps never reaches Jev (mayProposeTaste), and
  // a catalog rule proposal takes the turn instead. Stored on the message (`tool_calls.tasteChips`),
  // not as a block, so a phone without the card ignores it. Nothing is written here: only the user's
  // own picks, through POST /api/profile/taste/confirm, write, and that confirm records this card's
  // Undo. When the card proposes dislikes it replaces the soft "less of X" food-preference card for
  // the same sentence; a like card stays, and so does every card when Jev is down (no taste card).
  let tasteChips: TasteChipsProposal | null = null;
  const ruleProposal = blocks.some((b) => b.kind === "dietary_profile_proposal"
    && b.profileId !== FOOD_PREFERENCE_PROFILE_ID);
  if (step.kind === "final" && content === text && !claimWithoutAction && !groundingLate
    && !ruleProposal && mayProposeTaste(req.text)) {
    const card = await beforeDeadline(
      () => tasteChipsCard(req.text, turn.userId, newId, kit.turnAbort.signal).catch((error: unknown) => {
        // The name only: a provider message could echo the user's text.
        console.error("taste chips proposal failed", { error: error instanceof Error ? error.name : "unknown" });
        return null;
      }),
      turn.replyDeadlineAt);
    tasteChips = card === LATE ? null : card;
    if (tasteChips && tasteChips.dislikes.length > 0) {
      blocks = blocks.filter((b) => !(b.kind === "dietary_profile_proposal"
        && b.profileId === FOOD_PREFERENCE_PROFILE_ID && b.items.every((item) => item.strength === "avoid")));
    }
  }

  // Phase 13 slice 7 (§6 "next best action", rev 2 retained): a deterministic chip under a reply
  // the turn is actually delivering — never on a re-ask (`content !== text`), a claim-without-
  // action refusal, an abort (including a non-final last tool step), or a late-grounding notice,
  // all of which already ask the user for something more specific than a generic next step.
  if (step.kind === "final" && content === text && !claimWithoutAction && !groundingLate) {
    const readAbort = new AbortController();
    const onTurnAbort = () => readAbort.abort();
    if (kit.turnAbort.signal.aborted) onTurnAbort();
    else kit.turnAbort.signal.addEventListener("abort", onTurnAbort, { once: true });
    let unlogged: boolean | typeof LATE;
    try {
      unlogged = await beforeDeadline(
        () => hasUnloggedMeal(turn.client, turn.userId, turn.clock,
          kit.logEntryExists, readAbort.signal),
        turn.replyDeadlineAt);
      if (unlogged === LATE) readAbort.abort();
    } finally {
      kit.turnAbort.signal.removeEventListener("abort", onTurnAbort);
    }
    const candidate = await nextBestAction({
      hasUnloggedMealToday: unlogged !== LATE && unlogged,
      hasPendingProfileConfirmation: blocks.some((b) => b.kind === "dietary_profile_proposal"),
      hasUncheckedLabelFood: draftChecks.some((c) => c.verdict === "unverified")
        || suggestions.some((c) => c.verdict === "unverified"),
      hasSuggestionsAvailable: suggestions.length > 0 || blocks.some((b) => b.kind === "food_ideas"),
    });
    if (candidate) blocks = [...blocks, hydrateNextActionChip(newId(), candidate)];
  }

  // A late answer's memory may describe changes that were never made (review r3), so only a
  // timely final adds items. The stored row is re-grounded and merged here on every model turn,
  // abort and late answer included, so a partial re-emit keeps earlier items and a poisoned item
  // is written out of the row as soon as the food list is known in full (review t3r4 WARN 4).
  const foods = accountFoodNames(env.context?.lists);
  const memory = nextMemory({ stored: intent.history.summary,
    emitted: step.kind === "final" && !groundingLate ? step.memory : undefined,
    accountFoodNames: foods.names, complete: foods.complete });
  const { modelId, fallbackReason, toolCalls, toolsUsed } = state;
  const { intentMs } = intent;
  return {
    kind: "model", content, modelId, memory,
    // The cards ride with the actions so an idempotent replay returns the same turn (HIGH 7).
    toolCalls: { calls: toolCalls, actions, suggestions, composed,
      blocks: validatedBlocks(...blocks),
      ...(recipeRefusals.length > 0 ? { recipeRefusals } : {}),
      ...(tasteChips ? { tasteChips } : {}) },
    policyChecks: [...suggestions, ...draftChecks, ...textChecks,
      ...(claimWithoutAction ? [{ verdict: "blocked", reason: "claim_without_action" }] : [])],
    body: {
      suggestions, actions, draft, composed, deflected: false, toolsUsed,
      // Owner request 2026-10-02: reports which provider actually answered, not always "gemini".
      model: { provider: isOpenRouterModelId(modelId) ? "openrouter" : "gemini", modelId,
        ...(fallbackReason ? { fellBackBecause: fallbackReason } : {}) },
      // Read when finish() builds the response, after the save, as it always was: a tool the
      // loop stopped waiting for still adds its hydrate time if it lands before then.
      get timings() {
        return { intent: intentMs, model: state.modelMs, ground: state.groundMs };
      },
    },
  };
}

/**
 * W087: one line for every turn that answers with a fallback instead of the model's reply, so the
 * cause can be counted: the model's abort, a loop stop, a claim with no action, or the food-rule
 * check. It carries codes and counts only: never the person's words, the reply, a food name, a
 * tool's error text or the model's own abort reason (its length is enough to tell it was there).
 */
function logFallback(
  state: ModelState, claimWithoutAction: boolean, replaced: ReplyCheckResult["replaced"],
): void {
  const { step } = state;
  const cause = claimWithoutAction ? "claim_without_action"
    : step.kind === "abort" ? (TURN_STOP_REASONS.has(step.reason) ? step.reason : "model_abort")
    : step.kind === "tool" ? "max_tool_calls"
    : replaced?.by ?? null;
  if (cause === null) return;
  console.warn("coach turn fallback", {
    cause,
    modelId: state.modelId,
    toolCalls: state.toolCalls.length,
    failedToolCalls: state.toolCalls.filter((call) => !call.ok).length,
    // Refused before running: the model's arguments did not fit the tool's input schema.
    invalidToolArgs: state.toolCalls.filter((call) => !call.ok
      && (call.error ?? "").startsWith(INVALID_ARGS_PREFIX)).length,
    tools: [...new Set(state.toolsUsed)],
    abortCorrected: state.abortCorrectionRequested,
    ...(cause === "model_abort" && step.kind === "abort" ? { modelReasonChars: step.reason.length } : {}),
    ...(replaced ? { replacedBy: replaced.by, held: replaced.reasons.slice(0, 8),
      incomplete: replaced.incomplete } : {}),
  });
}
