/**
 * The policy pass a finished turn runs before anything is rendered — moved out of
 * lib/server/coach.ts by T6 §6 so it can be read, and tested, without a Supabase double.
 *
 * It runs AFTER the model and BEFORE render, on the server, so a client that ignores `verdict`
 * cannot show an allowed-looking card.
 *
 * Pure. No I/O, no Supabase import.
 */

import { shoppingItemNames, withoutShoppingConfirmations } from "@/lib/coach/shopping-confirmation";
import type { CoachAction } from "@/lib/coach/actions";
import { checkDraft, checkItem, type EvidenceByName, allergenFacts } from "@/lib/coach/policy";
import { LIST_MARK_KINDS } from "@/lib/coach/actions/food-lists";
import { reaskMessage, reaskReasonCode } from "@/lib/coach/reask";
import type { RawSuggestion } from "@/lib/coach/turn";
import type { CoachDraft, CoachSuggestion } from "@/lib/coach/types";
import type { ConstraintProfile } from "@/lib/policy/constraints";

export type ReplyCheckInput = {
  text: string;
  named: RawSuggestion[];
  draft: CoachDraft | null;
  actions: CoachAction[];
  evidence: EvidenceByName;
  profile: ConstraintProfile;
};

export type ReplyCheckResult = {
  /** What the user actually reads: the reply, or the abort when an unverified food reached it. */
  content: string;
  suggestions: CoachSuggestion[];
  draft: CoachDraft | null;
  actions: CoachAction[];
  draftChecks: CoachSuggestion[];
  textChecks: CoachSuggestion[];
  /**
   * Set when the check replaced the reply, for the turn's fallback log (W087): which check did it,
   * the policy code of each food it held back (never a name), and whether the live scan finished.
   */
  replaced?: { by: "text_check" | "reply_scan"; reasons: string[]; incomplete: boolean };
};

/** The food identities an exemption (finding #6) is keyed on: by name, or by grounded foodRefId. */
export type LoggedIdentities = { names: Set<string>; refs: Set<string> };

/**
 * 2026-10-02 DeepSeek audit (finding #6): the foods THIS turn's own log_meal actions already
 * logged — a food the user says they ate is their own record, not advice, and log_meal already
 * marks its items via log-policy notices ("Not verified: …", off-plan). Matched by name (what the
 * model called it) or by the grounded foodRefId, so a mention the prose scan resolves to the same
 * catalog row still counts even if its display name differs slightly.
 *
 * A shopping item is NOT exempt by name (audits 2026-10-02, BLOCK): only the reply's own
 * "added X to your list" sentence is set aside, by lib/coach/shopping-confirmation.ts.
 */
export function loggedFoodIdentities(
  actions: readonly CoachAction[],
): LoggedIdentities {
  const names = new Set<string>();
  const refs = new Set<string>();
  for (const action of actions) {
    if (action.kind === "log_meal") {
      for (const item of action.items) {
        names.add(item.name.toLowerCase());
        refs.add(item.foodRefId);
      }
    }
    // W087: an Eats or Avoid mark is the person's own instruction about that food, and its
    // grounding already says a blocked verdict is no reason to hold the mark back
    // (lib/coach/actions/food-lists.ts). The reply confirming it ("Adding Greek yogurt to your
    // Favored list") is not advice, so it no longer turns the turn into a re-ask that also drops
    // the mark — the fast path already answers the same sentence with the mark.
    if ((LIST_MARK_KINDS as readonly string[]).includes(action.kind)) {
      const mark = action as Extract<CoachAction, { kind: (typeof LIST_MARK_KINDS)[number] }>;
      const name = mark.name.toLowerCase();
      names.add(name);
      // The catalog's name is "Greek yogurt, plain"; the reply and its card say "greek yogurt".
      const base = name.split(",")[0].trim();
      if (base !== "") names.add(base);
      refs.add(mark.foodRefId);
      for (const id of mark.alsoFoodRefIds ?? []) refs.add(id);
    }
  }
  return { names, refs };
}

/** What a suggestion card is judged on: the model's id, else the searched one, with its facts. */
export function cardEvidence(s: RawSuggestion, evidence: EvidenceByName): EvidenceByName[string] {
  const found = evidence[s.name];
  return {
    foodRefId: s.foodRefId ?? found?.foodRefId ?? null,
    allergenTags: found?.allergenTags ?? null, ...allergenFacts(found), category: found?.category ?? null,
    onEatsList: found?.onEatsList ?? false, onAvoidList: found?.onAvoidList ?? false,
  };
}

export function checkReply(input: ReplyCheckInput): ReplyCheckResult {
  const { named, evidence, profile, text } = input;
  const suggestions: CoachSuggestion[] = named.map((s) => {
    const card = cardEvidence(s, evidence);
    const foodRefId = card.foodRefId;
    const verdict = checkItem({ ...card, name: s.name, grams: s.grams ?? null }, profile, true);
    return {
      foodRefId, name: s.name, grams: s.grams ?? null,
      reason: verdict.verdict === "blocked" ? verdict.reason : null, verdict: verdict.verdict,
    };
  });

  let draft = input.draft;
  const draftChecks = draft ? checkDraft(draft, profile, evidence, true) : [];
  // A blocked item carries no draft (acceptance criterion 6).
  if (draftChecks.some((c) => c.verdict === "blocked")) {
    draft = null;
  } else if (draft) {
    // Carry the real per-item verdict through to the client instead of letting it get
    // discarded here — draftToProposeResponse reads draft.items[].verdict.
    draft = { ...draft, items: draft.items.map((row, i) => ({ ...row, verdict: draftChecks[i].verdict })) };
  }

  /**
   * The free-text reply is the model's own prose, not a suggestion card: prompt.ts asks it to
   * mirror every named food into `suggestions`, but nothing in the schema enforces that, so a
   * `final` step can name a food in `text` while `suggestions` stays empty or omits it. Anything
   * this turn actually searched for is real evidence regardless — if its name surfaces in the
   * reply and it was never declared as a suggestion, its own verdict still has to be checked
   * before the text can be trusted.
   */
  const namedNames = new Set(named.map((s) => s.name.toLowerCase()));
  // The confirmation sentence leaves the scan, but each item it put on the list is still judged
  // (DeepSeek audit round 9, HIGH): a blocked food never goes on the list unremarked.
  const lowerText = [withoutShoppingConfirmations(text, input.actions ?? []),
    ...shoppingItemNames(input.actions ?? [])].join(" ").toLowerCase();
  // finding #6: a food this turn's own log_meal already logged is exempt from this blocking scan —
  // it is the user's record of what they ate, not advice the reply is offering them.
  const logged = loggedFoodIdentities(input.actions);
  const textChecks: CoachSuggestion[] = Object.entries(evidence)
    .filter(([name, found]) => !namedNames.has(name.toLowerCase())
      && !logged.names.has(name.toLowerCase()) && !(found.foodRefId !== null && logged.refs.has(found.foodRefId))
      && lowerText.includes(name.toLowerCase()))
    .map(([name, found]) => ({
      name, foodRefId: found.foodRefId,
      verdict: checkItem({
        foodRefId: found.foodRefId, name, grams: null,
        allergenTags: found.allergenTags, ...allergenFacts(found), category: found.category,
        onEatsList: found.onEatsList, onAvoidList: found.onAvoidList,
      }, profile, true),
    }))
    .filter((c) => c.verdict.verdict === "blocked")
    .map((c) => ({
      foodRefId: c.foodRefId, name: c.name, grams: null,
      reason: c.verdict.verdict === "blocked" ? c.verdict.reason : null, verdict: "blocked" as const,
    }));

  if (textChecks.length > 0) {
    return { content: reaskMessage(textChecks.map((c) => ({ name: c.name, reason: c.reason ?? null }))),
      suggestions: [], draft: null, actions: [], draftChecks, textChecks,
      replaced: { by: "text_check", reasons: textChecks.map((c) => reaskReasonCode(c.reason ?? null)),
        incomplete: false } };
  }
  return { content: text, suggestions, draft, actions: input.actions, draftChecks, textChecks };
}
