/**
 * Spec phase 15 R14 / c12: an older account whose inherited food rules still await review gets no
 * generated suggestions (the Plan sheet's coach options included), only the line that sends it to
 * the review. Nothing is built, searched or ranked first.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { suggestOptions, SUGGEST_BUDGET_MS, type SuggestPorts } from "@/lib/coach/suggest";
import { RULE_REVIEW_SUGGEST_MESSAGE, SUGGEST_TIMEOUT_MESSAGE } from "@/lib/coach/suggest-messages";

function ports(
  ruleReviewRequired: (userId: string, signal?: AbortSignal) => Promise<boolean>,
): SuggestPorts {
  return {
    userId: "historical-account",
    profile: { avoid_allergens: ["gluten"], avoid_food_ref_ids: [], banned_categories: [] },
    target: vi.fn(async () => ({ kcal: 600, protein: 40, carbs: 60, fat: 20 })),
    eatsNames: vi.fn(async () => ["Chicken breast"]),
    searchFoods: vi.fn(async () => []),
    suggestionEvidence: async () => ({ status: "ready", preferenceFlags: [], byIdentity: {} }),
    ruleReviewRequired,
  };
}

describe("suggestions while a rule review is pending", () => {
  it("answers with the review line and builds nothing", async () => {
    const p = ports(async () => true);
    const cards = await suggestOptions({ kind: "meal", count: 3 }, p);
    expect(cards).toHaveLength(0);
    expect(cards.message).toBe(RULE_REVIEW_SUGGEST_MESSAGE);
    expect(JSON.parse(JSON.stringify(cards))).toEqual({ cards: [], message: RULE_REVIEW_SUGGEST_MESSAGE });
    expect(p.eatsNames).not.toHaveBeenCalled();
    expect(p.searchFoods).not.toHaveBeenCalled();
  });

  it("builds as usual once the review is done", async () => {
    const p = ports(async () => false);
    const cards = await suggestOptions({ kind: "meal", count: 3 }, p);
    expect(cards.message).not.toBe(RULE_REVIEW_SUGGEST_MESSAGE);
    expect(p.eatsNames).toHaveBeenCalled();
  });

  it("builds as usual for an account whose review flag is set but already reviewed", async () => {
    // reviewStatus() reads required: false once reviewedAt is set, even with the flag still on
    // (lib/rule-review.ts); this proves the port's own answer, not a different code path, decides.
    const p = ports(async () => false);
    const cards = await suggestOptions({ kind: "meal", count: 3 }, p);
    expect(cards.message).not.toBe(RULE_REVIEW_SUGGEST_MESSAGE);
  });

  it("passes this account's id and the build's own abort signal to the port", async () => {
    const seen: { userId?: string; signal?: AbortSignal } = {};
    const p = ports(async (userId, signal) => {
      seen.userId = userId;
      seen.signal = signal;
      return false;
    });
    await suggestOptions({ kind: "meal", count: 3 }, p);
    expect(seen.userId).toBe(p.userId);
    expect(seen.signal).toBeInstanceOf(AbortSignal);
  });

  it("never builds candidates while the port's read is still in flight", async () => {
    let resolvePending!: (value: boolean) => void;
    const p = ports(() => new Promise((resolve) => { resolvePending = resolve; }));
    const pending = suggestOptions({ kind: "meal", count: 3 }, p);
    await Promise.resolve();
    expect(p.eatsNames).not.toHaveBeenCalled();
    resolvePending(false);
    await pending;
    expect(p.eatsNames).toHaveBeenCalled();
  });

  describe("a port that ignores the abort signal entirely", () => {
    afterEach(() => vi.useRealTimers());

    // 2026-10-03 round-4 audit (Codex MAJOR): every other signal-bounded read in suggestOptions
    // is raced through `abortable()`; this one was a bare `await`. A port that never settles —
    // whether it ignores `signal` outright or the underlying transport just doesn't honor an
    // abort promptly — must not be able to hang the whole call past the suggest budget.
    it("still answers the timeout line instead of hanging past the suggest budget", async () => {
      vi.useFakeTimers();
      const p = ports(() => new Promise<boolean>(() => {}));
      const pending = suggestOptions({ kind: "meal", count: 3 }, p);
      await vi.advanceTimersByTimeAsync(SUGGEST_BUDGET_MS);
      const cards = await pending;
      expect(cards).toHaveLength(0);
      expect(cards.message).toBe(SUGGEST_TIMEOUT_MESSAGE);
      expect(p.eatsNames).not.toHaveBeenCalled();
    });
  });

  // 2026-10-03 round-4 audit (DeepSeek MAJOR): a port that DOES honor the signal — the real
  // constraints.ts shape, rejecting with a real AbortError once `signal.aborted` — must still
  // surface the ordinary timeout line through suggestOptions' own catch, not a thrown AbortError.
  describe("a port that rejects with AbortError once the budget fires", () => {
    afterEach(() => vi.useRealTimers());

    it("answers the timeout line, not a thrown AbortError, from the suggest call itself", async () => {
      vi.useFakeTimers();
      const p = ports((_userId, signal) => new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          const abort = new Error("constraint profile read aborted");
          abort.name = "AbortError";
          reject(abort);
        }, { once: true });
      }));
      const pending = suggestOptions({ kind: "meal", count: 3 }, p);
      await vi.advanceTimersByTimeAsync(SUGGEST_BUDGET_MS);
      const cards = await pending;
      expect(cards).toHaveLength(0);
      expect(cards.message).toBe(SUGGEST_TIMEOUT_MESSAGE);
    });
  });
});
