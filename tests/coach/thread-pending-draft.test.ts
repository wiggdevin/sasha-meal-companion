import { describe, expect, it } from "vitest";
import { threadHistory } from "@/lib/server/coach-threads";
import type { LogDraftBlockV1 } from "@/lib/coach/ui-blocks";

const THREAD = "3f1b1a2c-0000-4000-8000-000000000001";

/** Minimal client double: `coach_threads` resolves one row, `coach_messages` resolves a fixed list
 *  (threadHistory re-sorts by seq itself, so order here does not matter). */
function db(messages: Record<string, unknown>[]) {
  return {
    from: (table: string) => {
      if (table === "coach_threads") {
        const chain = {
          select: () => chain, eq: () => chain,
          maybeSingle: async () => ({ data: { summary: null }, error: null }),
        };
        return chain;
      }
      const chain = {
        select: () => chain, eq: () => chain, order: () => chain, limit: () => chain,
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: messages, error: null }).then(resolve),
      };
      return chain;
    },
  } as never;
}

/** Evidence 2026-09-20: the photo draft's four items (toast, eggs, sausage, mushrooms). */
const photoDraft = (): LogDraftBlockV1 => ({
  kind: "log_draft", v: 1, id: "draft-1", source: "capture", method: "photo",
  localDate: "2026-09-20", slot: "coffee",
  draft: {
    draftId: "draft-1", method: "photo",
    items: [
      { seq: 0, label: "Toast with butter and jam", foodRefId: null, catalogFoodRevisionId: null,
        grams: 60, qty: 60, unit: "g", portionId: null, confidence: 0.8,
        policy: { verdict: "unverified" }, alternatives: [], autoResolved: true },
      { seq: 1, label: "Scrambled eggs", foodRefId: null, catalogFoodRevisionId: null,
        grams: 120, qty: 120, unit: "g", portionId: null, confidence: 0.8,
        policy: { verdict: "unverified" }, alternatives: [], autoResolved: true },
      { seq: 2, label: "Sausage patty", foodRefId: null, catalogFoodRevisionId: null,
        grams: 85, qty: 85, unit: "g", portionId: null, confidence: 0.8,
        policy: { verdict: "unverified" }, alternatives: [], autoResolved: true },
      { seq: 3, label: "Sauteed mushrooms", foodRefId: null, catalogFoodRevisionId: null,
        grams: 50, qty: 50, unit: "g", portionId: null, confidence: 0.8,
        policy: { verdict: "unverified" }, alternatives: [], autoResolved: true },
    ],
    notes: [], spend: { usedToday: 0, softCap: 10 },
  },
  policy: { blocked: false }, status: "pending",
});

/**
 * "it was bison not sausage, log it" logs the WHOLE meal, not just the corrected item — three
 * items unchanged from the draft's own labels, one (the correction) sharing neither name nor ref
 * with anything in it. Item-identity matching (finding D) still resolves the draft on the three
 * overlapping names.
 */
const logMeal = () => ({
  actionId: "a1", kind: "log_meal", date: "2026-09-20", slot: "coffee", flagged: [],
  items: [
    { name: "Toast with butter and jam", grams: 60,
      foodRefId: "3f1b1a2c-0000-4000-8000-000000000011", catalogFoodRevisionId: null,
      kcalPer100g: 250, proteinPer100g: 6, carbsPer100g: 40, fatPer100g: 8, verdict: "allowed" },
    { name: "Scrambled eggs", grams: 120,
      foodRefId: "3f1b1a2c-0000-4000-8000-000000000012", catalogFoodRevisionId: null,
      kcalPer100g: 150, proteinPer100g: 12, carbsPer100g: 1, fatPer100g: 10, verdict: "allowed" },
    { name: "bison patty", grams: 85,
      foodRefId: "3f1b1a2c-0000-4000-8000-00000000002a", catalogFoodRevisionId: null,
      kcalPer100g: 200, proteinPer100g: 20, carbsPer100g: 0, fatPer100g: 12, verdict: "allowed" },
    { name: "Sauteed mushrooms", grams: 50,
      foodRefId: "3f1b1a2c-0000-4000-8000-000000000013", catalogFoodRevisionId: null,
      kcalPer100g: 30, proteinPer100g: 3, carbsPer100g: 4, fatPer100g: 1, verdict: "allowed" },
  ],
});

describe("threadHistory surfaces a still-open draft (lib/server/coach-threads.ts)", () => {
  it("renders the most recent pending log_draft's items for a follow-up to refer to", async () => {
    const { pendingDraft } = await threadHistory(db([
      { role: "assistant", content: "Here's what I found — check the portion and log it.",
        seq: 2, tool_calls: { blocks: [photoDraft()] } },
    ]), THREAD);
    expect(pendingDraft).not.toBeNull();
    expect(pendingDraft).toContain("Sausage patty, 85 g");
    expect(pendingDraft).toContain("Scrambled eggs, 120 g");
    expect(pendingDraft).toContain("coffee");
  });

  it("says nothing once a later turn logged a meal, resolving the draft", async () => {
    const { pendingDraft } = await threadHistory(db([
      { role: "assistant", content: "Here's what I found — check the portion and log it.",
        seq: 2, tool_calls: { blocks: [photoDraft()] } },
      { role: "user", content: "it was bison not sausage, log it", seq: 3, tool_calls: [] },
      { role: "assistant", content: "Logged all four items.", seq: 4,
        tool_calls: { actions: [logMeal()] } },
    ]), THREAD);
    expect(pendingDraft).toBeNull();
  });

  /**
   * 2026-10-02 Grok audit: this used to hide the draft on ANY later action, not only one that
   * actually logs it — a weigh-in or an avoid-list mark between the photo and "log it" made the
   * draft invisible to the model, which then had no idea what "it" referred to. No action schema
   * carries the draft's own id yet, so the available signal is a log_meal specifically; any other
   * action kind must leave an unresolved draft exactly as visible as it was.
   */
  /**
   * 2026-10-02 Grok audit (finding D): a log_meal for a food that has nothing to do with the draft
   * ("I also had a banana") used to hide it just the same as the log_meal that actually logged it —
   * log_meal is the only action-kind signal today, with no draft id of its own to match against, so
   * a food entirely unrelated to the draft's own items must not be read as resolving it.
   */
  it("keeps surfacing the draft when a later log_meal logs something unrelated to it (finding D)", async () => {
    const { pendingDraft } = await threadHistory(db([
      { role: "assistant", content: "Here's what I found — check the portion and log it.",
        seq: 2, tool_calls: { blocks: [photoDraft()] } },
      { role: "user", content: "I also had a banana", seq: 3, tool_calls: [] },
      { role: "assistant", content: "Logged one medium banana as a snack.", seq: 4,
        tool_calls: { actions: [{ actionId: "a2", kind: "log_meal", date: "2026-09-20", slot: "snack",
          flagged: [], items: [{ name: "Banana, raw", grams: 118,
            foodRefId: "3f1b1a2c-0000-4000-8000-00000000003b", catalogFoodRevisionId: 12,
            kcalPer100g: 89, proteinPer100g: 1.1, carbsPer100g: 22.8, fatPer100g: 0.3,
            verdict: "allowed" }] }] } },
    ]), THREAD);
    expect(pendingDraft).not.toBeNull();
    expect(pendingDraft).toContain("Sausage patty, 85 g");
  });

  it("keeps surfacing the draft through an unrelated action (a weigh-in, say) that never touched it", async () => {
    const { pendingDraft } = await threadHistory(db([
      { role: "assistant", content: "Here's what I found — check the portion and log it.",
        seq: 2, tool_calls: { blocks: [photoDraft()] } },
      { role: "user", content: "I weighed in at 180", seq: 3, tool_calls: [] },
      { role: "assistant", content: "Logged your weigh-in.", seq: 4,
        tool_calls: { actions: [{ kind: "log_weight", actionId: "a2", kg: 81.6, flagged: [] }] } },
    ]), THREAD);
    expect(pendingDraft).not.toBeNull();
    expect(pendingDraft).toContain("Sausage patty, 85 g");
  });

  it("ignores a draft already marked committed or dismissed", async () => {
    const dismissed = { ...photoDraft(), status: "dismissed" as const };
    const { pendingDraft } = await threadHistory(db([
      { role: "assistant", content: "Here's what I found.", seq: 2,
        tool_calls: { blocks: [dismissed] } },
    ]), THREAD);
    expect(pendingDraft).toBeNull();
  });

  it("returns no pending draft for a brand-new thread", async () => {
    const { pendingDraft, messages } = await threadHistory(db([]), null);
    expect(pendingDraft).toBeNull();
    expect(messages).toEqual([]);
  });
});
