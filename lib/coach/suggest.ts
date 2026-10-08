/** Code builds and sizes suggestion candidates; Jev only ranks the policy-clean set. */

import { suggestPayload } from "@/lib/ai/payloads";
import { systemOne as callSystemOne } from "@/lib/ai/typesafe";
import { NOTHING_LEFT, type ComposePorts, type ComposedMeal } from "@/lib/coach/compose";
import type { MealMacros } from "@/lib/coach/compose-size";
import type { MealClockPorts } from "@/lib/coach/meal-type";
import { buildCandidates, fitScore, NO_SAVED_FOODS, NO_TARGET, type SuggestionCandidate }
  from "@/lib/coach/suggest-candidates";
import {
  asksForNoCook, filterSuggestionCandidates, loadSuggestionEvidence,
  type SuggestionEvidencePort,
} from "@/lib/coach/suggest-policy";
import {
  rankCandidates, rankingState, suggestionRank, type JevAnswers, type JevPort,
}
  from "@/lib/coach/suggest-rank";
import {
  LABELS_HIDDEN_MESSAGE, NOTHING_LEFT_MESSAGE, NO_MEAL_FIT_MESSAGE, NO_SAVED_FOODS_MESSAGE,
  NO_SNACK_FIT_MESSAGE, NO_TARGET_SUGGEST_MESSAGE, REQUIRES_PREPARATION_MESSAGE,
  RULE_REVIEW_SUGGEST_MESSAGE, SUGGEST_TIMEOUT_MESSAGE,
} from "@/lib/coach/suggest-messages";
import type { FoodHit, SuggestInput } from "@/lib/coach/executors";
import type { ConstraintProfile } from "@/lib/policy/constraints";
import { profileRuleFacets } from "@/lib/policy/profiles/account-rules";
import { BY_APP, byJev } from "@/lib/provenance";

export type { SuggestInput } from "@/lib/coach/executors";
export { fitScore, suggestionRank };

/**
 * `slotClock` / `timeOfDay` (MealClockPorts) say which meal a card is for; lib/server/coach-ports.ts
 * supplies both.
 */
export type SuggestPorts = ComposePorts & MealClockPorts & {
  userId: string;
  profile: ConstraintProfile;
  /**
   * The account's own food with exactly this name, or null (2026-10-02). An Eats name is theirs:
   * the build takes it here and searches the catalog only on a miss — a search cost ~27 database
   * requests, and ~100 of them per build missed the 5 s budget whenever the database was busy.
   */
  ownFood?: (userId: string, name: string, signal?: AbortSignal) => Promise<FoodHit | null>;
  /**
   * What one option is sized to. `null` means this day has no target — no revision yet, or one not
   * effective on the turn's own date (lib/server/coach-ports.ts). A missing target is a fact to say
   * out loud, never a reason to throw and never a number to invent: before this, that throw became
   * "I couldn't build those suggestions right now" on a brand-new account.
   */
  target: (input: SuggestInput) => Promise<MealMacros | null>;
  systemOne?: JevPort;
  suggestionEvidence?: SuggestionEvidencePort;
  pendingSlots?: () => Promise<{ slot: string; label: string }[]>;
  /**
   * The names a card may anchor on, in the order to try them: the account's protein marks first,
   * then foods with no role. Absent, the Eats list is walked as it comes (2026-10-02: it ran out of
   * budget searching non-proteins alphabetically before ever reaching "Chicken breast").
   */
  eatsAnchors?: (userId: string) => Promise<string[]>;
  /**
   * True while the account's inherited food rules await their one-time review (spec phase 15 R14).
   * Generated suggestions wait for that review, as Today's generated meals and swaps already do.
   * Takes `userId` explicitly, like every other port here (`ownFood`, `eatsNames`), rather than
   * closing over one, and the same signal the rest of this build respects — a profile re-read sol
   * found running unbounded ahead of `SUGGEST_BUDGET_MS` (2026-10-03 audit, finding #4).
   */
  ruleReviewRequired?: (userId: string, signal?: AbortSignal) => Promise<boolean>;
};

export const SUGGEST_BUDGET_MS = 8_000;
/**
 * D9 item 4 / W10 acceptance 2: the formulas pick the top 5 to 8 admitted plates before the one
 * optional Jev call — never the whole candidate list. A candidate past this cap keeps its formula
 * order (acceptance 5) but is never sent to, or reordered by, Jev.
 */
export const SUGGEST_SHORTLIST_MAX = 8;
/**
 * Candidate building stops here and keeps what it has, leaving the rest of the budget for the
 * evidence check and the Jev ranking. Before this, a long Eats list spent all 8 s searching and
 * the cards it had already built were dropped with the retry line (production, 2026-09-29/30).
 */
export const SUGGEST_BUILD_BUDGET_MS = 5_000;
export type SuggestionResult = ComposedMeal[] & { partial?: true; message?: string };

/** Generate up to twelve safe candidates, then rank all of them in one System One request. */
export async function suggestOptions<T extends SuggestPorts>(
  input: SuggestInput,
  ports: T,
): Promise<SuggestionResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const buildController = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, SUGGEST_BUDGET_MS);
  const buildTimer = setTimeout(() => buildController.abort(), SUGGEST_BUILD_BUDGET_MS);
  const signal = controller.signal;
  try {
    // Raced through `abortable`, like every other signal-bounded read below: a port that
    // ignores `signal` (or whose transport just doesn't honor an abort promptly) must not be
    // able to hang this call past the suggest budget (round-4 audit, Codex MAJOR).
    const ruleReview = ports.ruleReviewRequired
      ? abortable(ports.ruleReviewRequired(ports.userId, signal), signal)
      : Promise.resolve(false);
    if (await ruleReview) {
      return messageResult(RULE_REVIEW_SUGGEST_MESSAGE);
    }
    const built = await buildCandidates(input, ports, buildController.signal, abortable, isAbort);
    if (built === NOTHING_LEFT) return nothingLeftResult();
    if (built === NO_SAVED_FOODS) return messageResult(NO_SAVED_FOODS_MESSAGE);
    if (built === NO_TARGET) return messageResult(NO_TARGET_SUGGEST_MESSAGE);
    const { requested, pendingSlots } = built;
    const needsNoCook = asksForNoCook(input.wish);
    // Phase 18 W10: a pool-sourced candidate already passed a fresh admission read (D11) —
    // `lib/coach/suggest-pool.ts`'s own doc comment. The Eats-era allergen/evidence recheck below
    // reads `food_refs` by id, which a universe pool id is not one of, so it is skipped here
    // rather than misjudging every such item "unverified". The pool carries no per-item prep-state
    // evidence at all, though, so an explicit no-cook wish cannot be honestly cleared for it
    // either — it fails closed (every pool candidate "requires preparation") rather than silently
    // risking a meal that needs cooking.
    const filtered = built.openWorld
      ? { candidates: needsNoCook ? [] : built.candidates, blocked: 0, unverified: 0,
        requiresPreparation: needsNoCook ? built.candidates.length : 0 }
      : filterSuggestionCandidates(
        built.candidates,
        await abortable((ports.suggestionEvidence ?? loadSuggestionEvidence)(ports.userId,
          built.candidates.flatMap((candidate) => candidate.meal.items),
          { needsNoCook, facets: profileRuleFacets(ports.profile.profileRules) }), signal),
        ports.profile, needsNoCook,
      );
    const candidates = filtered.candidates;
    const withSlots = (meal: ComposedMeal): ComposedMeal => ({
      ...meal,
      ...(pendingSlots ? { pendingSlots } : {}),
    });
    const fitOrdered = fallbackCards(candidates, requested, withSlots);
    // Unchecked labels that hid every food are the reason there are no cards, even when the build
    // also ran out of time: telling the person "I ran out of time" sent them to retry a request that
    // could never succeed (production Plan sheet, 2026-10-01).
    if (candidates.length === 0 && filtered.unverified + built.hiddenUnverified > 0
      && !(needsNoCook && filtered.requiresPreparation > 0)) {
      return messageResult(LABELS_HIDDEN_MESSAGE);
    }
    if (timedOut || (built.interrupted && candidates.length === 0)) return partialResult(fitOrdered);
    if (candidates.length === 0) {
      if (needsNoCook && filtered.requiresPreparation > 0) {
        return messageResult(REQUIRES_PREPARATION_MESSAGE);
      }
      if (filtered.unverified + built.hiddenUnverified > 0) {
        return messageResult(LABELS_HIDDEN_MESSAGE);
      }
      // 2026-10-02 DeepSeek audit (MED, finding #3): every remaining branch above already says why
      // there are no cards (preparation, hidden labels); a food blocked outright by the account's
      // own rules is the one case that fell through to a bare, message-less empty array.
      return messageResult(input.kind === "snack" ? NO_SNACK_FIT_MESSAGE : NO_MEAL_FIT_MESSAGE);
    }

    // D9 item 4 / acceptance 2: the top 5-8 admitted plates only, formula order first
    // (acceptance 5's fit-first order). A candidate past the cap is never sent to, or reordered
    // by, Jev — but acceptance 5 still applies to it relative to EVERY other candidate, so it
    // must not simply be appended after the (reordered) shortlist: a high-formula-rank candidate
    // the builder withheld from Jev (acceptance 3's `jevEligible === false`) could then land
    // behind every Jev-visible one, even a non-fitting one, which is exactly what acceptance 5
    // forbids. Instead, only the SET of shortlisted slots is permuted by Jev; every other slot
    // (overflow past the cap, or never Jev-eligible) keeps its original formula position.
    const ordered = formulaOrder(candidates);
    const shortlistIndices = ordered
      .flatMap((candidate, position) => (candidate.jevEligible !== false ? [position] : []))
      .slice(0, SUGGEST_SHORTLIST_MAX);
    const shortlistSlots = new Set(shortlistIndices);
    const shortlist = shortlistIndices.map((position) => ordered[position]);
    const ask: JevPort = ports.systemOne ?? ((payload, options) => callSystemOne(payload, options));
    const remainingMs = Math.max(1, SUGGEST_BUDGET_MS - (Date.now() - startedAt));
    let answers: JevAnswers | null = null;
    // "At most one Jev call" (D9 item 4) is the hard constraint; an account with fewer admitted
    // plates than the 5-8 shortlist's typical size (acceptance 1 guarantees as few as 3 total)
    // still gets its one call on whatever it has, never zero.
    if (shortlist.length > 0) {
      const state = rankingState(input, shortlist, pendingSlots);
      try {
        answers = await abortable(ask(suggestPayload(state, input.kind), {
          userId: ports.userId, deadlineMs: remainingMs, signal, noRetry: true,
        }), signal);
      } catch (error) {
        if (!isAbort(error)) throw error;
      }
    }
    if (timedOut) return partialResult(fitOrdered);
    const rankedShortlist = rankCandidates(shortlist, answers, input.kind);
    // Walk `ordered` position by position: a shortlisted slot is filled, in turn, by Jev's own
    // new order for that same set (a live-vetoed removal simply leaves fewer to draw from, so
    // that many shortlisted slots contribute nothing — never backfilled from elsewhere). Every
    // other slot keeps its original candidate, unreordered and unvetoed.
    let nextRanked = 0;
    const merged: { candidate: SuggestionCandidate; reason: string; jevRanked: boolean }[] = [];
    for (let position = 0; position < ordered.length; position += 1) {
      if (shortlistSlots.has(position)) {
        if (nextRanked < rankedShortlist.length) merged.push(rankedShortlist[nextRanked]);
        nextRanked += 1;
      } else {
        const candidate = ordered[position];
        merged.push({ candidate, reason: `fits ${Math.round(candidate.fit * 100)} %`, jevRanked: false });
      }
    }
    const selected = merged
      .slice(0, requested).map(({ candidate, reason, jevRanked }) => ({
        ...withSlots(candidate.meal),
        rankNote: reason,
        provenance: jevRanked ? byJev("suggest-options") : BY_APP,
      }));
    if (built.interrupted && selected.length < requested) return partialResult(selected);
    if (selected.length === 0) {
      // Jev rejected every built candidate. A note mapped over an empty list is lost, and the
      // caller then falls back to "no calories left", which is not why there are no cards.
      if (filtered.unverified + built.hiddenUnverified > 0) return messageResult(LABELS_HIDDEN_MESSAGE);
      return messageResult(input.kind === "snack" ? NO_SNACK_FIT_MESSAGE : NO_MEAL_FIT_MESSAGE);
    }
    if (selected.length < requested) {
      // §5: the verified alternatives it has, and one line when unchecked labels hid the rest.
      const note = filtered.unverified + built.hiddenUnverified > 0 ? LABELS_HIDDEN_MESSAGE
        : `${selected.length} of ${requested} fit your remaining macros`;
      return selected.map((meal, index) => index === 0
        ? { ...meal, shortfallNote: note }
        : meal);
    }
    return selected as SuggestionResult;
  } catch (error) {
    if (isAbort(error) || timedOut) return partialResult([]);
    throw error;
  } finally {
    clearTimeout(timer);
    clearTimeout(buildTimer);
  }
}

/**
 * The formula's own order: acceptance 5 — a plate that misses the slot's fit never ranks ahead of
 * one that fits — then the SAME no-Jev rank `rankCandidates` (lib/coach/suggest-rank.ts) falls
 * back to (fit weighted by pairing, `suggestionRank(fit, undefined, pairing)`), then a stable
 * tie-break. Every fallback (a timeout, Jev down, too many vetoes) and the Jev shortlist cap all
 * read this same order — a fit-only sort here would disagree with `rankCandidates`' own fallback
 * whenever two candidates' pairing scores differ.
 */
function formulaOrder(candidates: readonly SuggestionCandidate[]): SuggestionCandidate[] {
  const rankOf = (candidate: SuggestionCandidate) =>
    suggestionRank(candidate.fit, undefined, candidate.pairing ?? candidate.meal.pairing);
  return [...candidates].sort((a, b) => Number(b.meal.fitsTarget) - Number(a.meal.fitsTarget)
    || rankOf(b) - rankOf(a) || b.fit - a.fit || a.index - b.index);
}

function fallbackCards(
  candidates: readonly SuggestionCandidate[],
  requested: number,
  withSlots: (meal: ComposedMeal) => ComposedMeal,
): ComposedMeal[] {
  return formulaOrder(candidates)
    .slice(0, requested)
    .map(({ meal, fit }) => ({ ...withSlots(meal), rankNote: `fits ${Math.round(fit * 100)} %`,
      provenance: BY_APP }));
}

function nothingLeftResult(): ComposedMeal[] {
  return messageResult(NOTHING_LEFT_MESSAGE);
}

function messageResult(message: string): ComposedMeal[] {
  const cards = [] as ComposedMeal[] & { message?: string };
  Object.defineProperty(cards, "message", { value: message });
  Object.defineProperty(cards, "toJSON", {
    value: () => ({ cards: [], message }),
  });
  return cards;
}

function partialResult(cards: ComposedMeal[]): SuggestionResult {
  const message = cards.length === 0
    ? SUGGEST_TIMEOUT_MESSAGE
    : `Here are the ${cards.length} I could build in time — ask again for more.`;
  const result = cards.map((meal, index) => index === 0
    ? { ...meal, shortfallNote: message }
    : meal) as SuggestionResult;
  result.partial = true;
  result.message = message;
  Object.defineProperty(result, "toJSON", {
    value: () => ({ cards: [...result], partial: true, message }),
  });
  return result;
}

function abortError(): Error {
  const error = new Error("suggestion budget expired");
  error.name = "AbortError";
  return error;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((value) => {
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    }, (error: unknown) => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
  });
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
