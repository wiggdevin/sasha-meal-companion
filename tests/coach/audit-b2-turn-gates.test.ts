/**
 * 2026-10-03 audit (b1/b2): the server, not only the prompt, holds two lines.
 * - A recipe-widget turn applies no coach action, on the model path as well as the fast path.
 * - skip_slot clears a meal only as the explicit yes to a skip offered on an earlier turn; never on
 *   the offer turn (the one that ran preview_skip), and never without an offer.
 * The model is a mock: no provider is called.
 */
import type { CoachScope } from "@/lib/coach/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runTurn } from "@/tests/coach/fixtures/run-turn";
import { claimsSkip, confirmsSkip, gateSkips, isExplicitYes, offeredSkip, SKIP_NOT_CONFIRMED }
  from "@/lib/server/coach-turn/skip-gate";
import { RECIPE_WIDGET_NO_WRITE } from "@/lib/server/coach-turn/final-step";
import { fastPathAction } from "@/lib/server/coach-turn/fast-path-copy";
import type { CoachAction } from "@/lib/coach/actions";

/** A filtering client double, as in tests/recipes-hub/recipe-surface.test.ts. */
function db(tables: Record<string, Record<string, unknown>[]>) {
  const from = (table: string) => {
    const filters: Record<string, unknown> = {};
    let limit = 1000;
    const result = () => ({ data: (tables[table] ?? []).filter((row) => Object.entries(filters)
      .every(([field, value]) => row[field] === value
        || (field === "deleted_at" && value === null && row[field] === undefined))).slice(0, limit),
    error: null });
    const chain = {
      select: () => chain,
      eq: (field: string, value: unknown) => { filters[field] = value; return chain; },
      is: (field: string, value: unknown) => { filters[field] = value; return chain; },
      gte: () => chain, lte: () => chain, order: () => chain, in: () => chain, neq: () => chain,
      limit: (n: number) => { limit = n; return chain; },
      maybeSingle: async () => ({ data: result().data[0] ?? null, error: null }),
      single: async () => ({ data: result().data[0] ?? null, error: null }),
      insert: (row: Record<string, unknown>) => { (tables[table] ??= []).push(row); return chain; },
      update: () => chain,
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve),
    };
    return chain;
  };
  return { from, rpc: async () => ({ data: [], error: null }) } as never;
}

const ports = {
  dayTotals: async () => ({ local_date: "2026-09-20", nutrients: [] }),
  weekTotals: async () => [],
  activeTargets: async () => ({ kcal_train: 2200, protein_g: 135 }),
  latestEstimate: async () => ({ status: "burn_in", tdeeKcal: null }),
  searchFoods: async () => [],
  getConstraints: async () => ({ avoid_allergens: [] }),
  recentGut: async () => [],
  newDraftId: () => "draft-1",
  skipPreview: async () => ({ ok: true, freedKcal: 520 }),
};

const skip = (slot = "meal-5") => ({ kind: "skip_slot", date: "2026-09-19", slot });
const THREAD = "3f1b1a2c-0000-4000-8000-0000000002a0";
const OFFER = "Want me to skip Meal 5? Its ~520 kcal would move into Meal 4.";

describe("the skip gate", () => {
  const action = (slot: string) => ({ ...skip(slot), actionId: "a1", flagged: [] }) as unknown as CoachAction;

  it("reads an explicit yes, and a yes that is really a no", () => {
    for (const text of ["yes", "Yes please", "ok", "sure, do it", "Skip and rebalance", "skip it"]) {
      expect(isExplicitYes(text)).toBe(true);
    }
    for (const text of ["no", "Leave my plan", "maybe later", "yes, leave my plan", "what would it do?",
      "I'll skip dinner tonight probably"]) {
      expect(isExplicitYes(text)).toBe(false);
    }
  });

  it("finds the offer only for the slot it named", () => {
    expect(offeredSkip(OFFER, "meal-5")).toBe(true);
    expect(offeredSkip(OFFER, "meal-4")).toBe(false);
    expect(offeredSkip("Meal 5 looks good.", "meal-5")).toBe(false);
    expect(offeredSkip(null, "meal-5")).toBe(false);
  });

  it("keeps a confirmed skip, drops one on the offer turn, without an offer, or without a yes", () => {
    const base = { actions: [action("meal-5")], userText: "yes", lastCoachMessage: OFFER, previewedThisTurn: false };
    expect(gateSkips(base)).toEqual({ actions: base.actions, dropped: false });
    expect(gateSkips({ ...base, previewedThisTurn: true }).dropped).toBe(true);
    expect(gateSkips({ ...base, lastCoachMessage: null }).dropped).toBe(true);
    expect(gateSkips({ ...base, userText: "hmm, not sure" }).dropped).toBe(true);
    expect(gateSkips({ ...base, actions: [action("meal-2")] }).dropped).toBe(true);
  });
});

describe("the skip gate, re-audit r1 #2/#3", () => {
  const action = (slot: string) => ({ ...skip(slot), actionId: "a1", flagged: [] }) as unknown as CoachAction;

  it("does not read advice against a skip, or a statement about one, as an offer", () => {
    expect(offeredSkip("Don't skip Meal 2. It carries your protein.", "meal-2")).toBe(false);
    expect(offeredSkip("I would not skip Meal 2 today?", "meal-2")).toBe(false);
    expect(offeredSkip("Skipping Meal 2 will leave you short. Want a snack?", "meal-2")).toBe(false);
  });

  it("reads the prompt's offer forms", () => {
    expect(offeredSkip("Skip Meal 5 and move its ~520 kcal into Meal 4? Meal 4 becomes ~900 kcal.", "meal-5"))
      .toBe(true);
    expect(offeredSkip("I can skip Meal 5 and move its kcal into Meal 4. Want that?", "meal-5")).toBe(true);
    expect(offeredSkip("If you're not hungry, want me to skip Meal 5?", "meal-5")).toBe(true);
    expect(offeredSkip("I can skip Meal 5 and move its kcal into Meal 4.", "meal-5")).toBe(false);
  });

  it("takes no yes that is taken back, a bare please, or a yes that names another meal", () => {
    for (const text of ["yeah no", "yes but wait", "Please log a chicken salad", "ok, not now"]) {
      expect(isExplicitYes(text)).toBe(false);
    }
    expect(confirmsSkip("Yes please", "meal-5", OFFER)).toBe(true);
    expect(confirmsSkip("Skip and rebalance, and log 2 gummy worms", "meal-5", OFFER)).toBe(true);
    expect(confirmsSkip("yes, no problem", "meal-5", OFFER)).toBe(true);
    expect(confirmsSkip("yes skip meal 2", "meal-5", OFFER)).toBe(false);
    expect(confirmsSkip("skip lunch instead", "meal-5", OFFER)).toBe(false);
    const dinner = "Want me to skip dinner (Meal 5)? Its ~520 kcal would move into Meal 4.";
    expect(confirmsSkip("yes, skip dinner", "meal-5", dinner)).toBe(true);
    expect(confirmsSkip("yes, skip lunch", "meal-5", dinner)).toBe(false);
  });

  it("names a different meal even when the offer used no meal word (2026-10-05 audit, BLOCKER 2)", () => {
    // OFFER never says "lunch", "dinner", etc. — only "Meal 5" — so "skip lunch" is not a yes to it.
    expect(confirmsSkip("yes, skip lunch", "meal-5", OFFER)).toBe(false);
    expect(confirmsSkip("yeah, skip breakfast", "meal-5", OFFER)).toBe(false);
    // A bare yes, with no meal word at all, still confirms.
    expect(confirmsSkip("yes", "meal-5", OFFER)).toBe(true);
  });

  it("does not read a statement that merely mentions skipping as an offer (2026-10-05 audit, MAJOR 3)", () => {
    expect(offeredSkip("Skipping Meal 2 will leave you short?", "meal-2")).toBe(false);
    expect(offeredSkip("Skipping Meal 2 will leave you short? Want a snack?", "meal-2")).toBe(false);
    // An imperative offer at the sentence's own start is still read as an offer.
    expect(offeredSkip("Skip Meal 2 and move its kcal into Meal 3?", "meal-2")).toBe(true);
  });

  it("requires the imperative's own sentence to end in '?' (2026-10-06 re-audit, MAJOR 3 regression)", () => {
    // An imperative statement followed by an unrelated question is not an offer: the message
    // ending in "?" must not launder a "Skip Meal 2." that itself ends in a period.
    expect(offeredSkip("Skip Meal 2. Want a snack?", "meal-2")).toBe(false);
    // Both previously-required cases still hold.
    expect(offeredSkip("Skip Meal 2 and move its kcal into Meal 3?", "meal-2")).toBe(true);
    expect(offeredSkip("Skipping Meal 2 will leave you short?", "meal-2")).toBe(false);
  });

  it("drops the skip a yes answers when the coach advised against it", () => {
    const base = { actions: [action("meal-2")], userText: "Yes.", lastCoachMessage: "Don't skip Meal 2.",
      previewedThisTurn: false };
    expect(gateSkips(base).dropped).toBe(true);
  });

  it("reads a skip claim", () => {
    expect(claimsSkip("Skipped Meal 5 and logged 2 gummy worms.")).toBe(true);
    expect(claimsSkip("Meal 5 has been skipped.")).toBe(true);
    expect(claimsSkip("Want me to skip Meal 5?")).toBe(false);
  });

  it("never takes a skip on the fast path", () => {
    const result = { intent: "skip_slot", confidence: 1, args: { date: "2026-09-19", slot: "meal-5" },
      argConfidence: {}, raw: {} };
    expect(fastPathAction(result as never, "2026-09-19")).toBeNull();
  });
});

describe("a model turn's actions at the gates", () => {
  beforeEach(() => { vi.stubEnv("COACH_ENABLED", "1"); vi.stubEnv("TYPESAFE_API_KEY", ""); });
  afterEach(() => vi.unstubAllEnvs());

  async function turn(text: string, final: Record<string, unknown>,
    options: { surface?: "recipes"; history?: boolean; preview?: boolean; id: string; intent?: unknown;
      scope?: CoachScope }) {
    const tables: Record<string, Record<string, unknown>[]> = options.history ? {
      coach_threads: [{ id: THREAD, user_id: "u1", kind: "chat", summary: null }],
      coach_messages: [
        { thread_id: THREAD, role: "user", content: "Office tonight, I'll just crash.", seq: 1, tool_calls: null },
        { thread_id: THREAD, role: "assistant", content: OFFER, seq: 2, tool_calls: null },
      ],
    } : {};
    const generate = vi.fn();
    if (options.preview) {
      generate.mockResolvedValueOnce({ kind: "tool",
        calls: [{ name: "preview_skip", args: { date: "2026-09-19", slot: "meal-5" } }] });
    }
    generate.mockResolvedValue(final);
    return runTurn(db(tables), db(tables), "u1", {
      threadId: options.history ? THREAD : null,
      messageId: `3f1b1a2c-0000-4000-8000-0000000002${options.id}`, text,
      now: "2026-09-19T10:00:00-06:00", tz: "America/Denver",
      ...(options.surface ? { surface: options.surface } : {}),
      ...(options.scope ? { scope: options.scope } : {}),
    }, { classifyIntent: vi.fn().mockResolvedValue(options.intent ?? null) as never, generate: generate as never,
      ports, now: () => 0, newId: () => `3f1b1a2c-0000-4000-8000-0000000003${options.id}` });
  }

  it("drops every model action on the recipe widget", async () => {
    const result = await turn("log 2 cups of water", { kind: "final", text: "About 1 slice fits.",
      actions: [{ kind: "log_water", numericArgs: [480] }] }, { surface: "recipes", id: "11" });
    expect(result.actions).toEqual([]);
  });

  it("still applies the same action in Coach chat", async () => {
    const result = await turn("log 2 cups of water", { kind: "final", text: "Logged 2 cups (16 oz) of water.",
      actions: [{ kind: "log_water", numericArgs: [480] }] }, { id: "12" });
    expect(result.actions).toMatchObject([{ kind: "log_water", ml: 480 }]);
  });

  it("refuses a skip_slot emitted on the turn that ran preview_skip", async () => {
    const result = await turn("I'll be at the office tonight, skip dinner", { kind: "final",
      text: "Skipped Meal 5.", actions: [skip()] }, { preview: true, id: "13" });
    expect(result.actions).toEqual([]);
    expect(result.messages.at(-1)?.content).toContain(SKIP_NOT_CONFIRMED);
  });

  it("refuses a skip_slot with no offer before it", async () => {
    const result = await turn("yes", { kind: "final", text: "Skipped Meal 5.", actions: [skip()] }, { id: "14" });
    expect(result.actions).toEqual([]);
  });

  it("replaces a recipe-widget reply that claims a write, even one ending in a question", async () => {
    const result = await turn("log this dinner", { kind: "final", text: "I've logged that dinner. Want another?",
      actions: [{ kind: "log_water", numericArgs: [480] }] }, { surface: "recipes", id: "16" });
    expect(result.actions).toEqual([]);
    expect(result.messages.at(-1)?.content).toBe(RECIPE_WIDGET_NO_WRITE);
  });

  it("keeps a recipe-widget reply that claims nothing", async () => {
    const result = await turn("how much fits?", { kind: "final", text: "About 1 slice fits.", actions: [] },
      { surface: "recipes", id: "17" });
    expect(result.messages.at(-1)?.content).toContain("About 1 slice fits.");
  });

  // Scoped AI input (lib/coach/scope.ts): the same gates, per scope.
  it("drops an action the page does not own (Foods page, log_water)", async () => {
    const result = await turn("log 2 cups of water", { kind: "final", text: "That belongs on Today.",
      actions: [{ kind: "log_water", numericArgs: [480] }] },
    { id: "31", scope: { kind: "page", page: "foods" } });
    expect(result.actions).toEqual([]);
  });

  it("says where a dropped action belongs instead of asking for it again (audit P18)", async () => {
    const result = await turn("log 2 cups of water", { kind: "final", text: "Logged 2 cups of water.",
      actions: [{ kind: "log_water", numericArgs: [480] }] },
    { id: "35", scope: { kind: "page", page: "foods" } });
    expect(result.actions).toEqual([]);
    const content = result.messages.at(-1)?.content ?? "";
    expect(content).toBe("I did not do that: it cannot be done from the Foods page. "
      + "Ask on Today or Body or the main coach.");
    expect(content).not.toMatch(/amounts once more/);
  });

  it("applies an action the page owns (Body page, log_water)", async () => {
    const result = await turn("log 2 cups of water", { kind: "final", text: "Logged 2 cups (16 oz) of water.",
      actions: [{ kind: "log_water", numericArgs: [480] }] },
    { id: "32", scope: { kind: "page", page: "body", date: "2026-09-19" } });
    expect(result.actions).toMatchObject([{ kind: "log_water", ml: 480 }]);
  });

  it("a meal card drops actions outside its slot kinds", async () => {
    const result = await turn("log 2 cups of water", { kind: "final", text: "Ask the main coach.",
      actions: [{ kind: "log_water", numericArgs: [480] }] },
    { id: "33", scope: { kind: "component", slotId: "meal-2", date: "2026-09-19" } });
    expect(result.actions).toEqual([]);
  });

  it("takes no out-of-scope mutating fast path (Foods page, shift_schedule)", async () => {
    const intent = { intent: "shift_schedule", confidence: 0.97,
      args: { minutes: 30, direction: "later", scope: "remaining" }, argConfidence: {}, raw: {} };
    const result = await turn("move my meals 30 minutes later", { kind: "final",
      text: "That is a Today change.", actions: [] },
    { id: "34", intent, scope: { kind: "page", page: "foods" } });
    expect(result.fastPath).toBeUndefined();
    expect(result.actions).toEqual([]);
  });

  it("takes no mutating fast path on the recipe widget", async () => {
    const intent = { intent: "shift_schedule", confidence: 0.97,
      args: { minutes: 30, direction: "later", scope: "remaining" }, argConfidence: {}, raw: {} };
    const result = await turn("move my meals 30 minutes later", { kind: "final", text: "Here is a recipe.",
      actions: [] }, { surface: "recipes", id: "18", intent });
    expect(result.actions).toEqual([]);
    expect(result.fastPath).toBeFalsy();
  });

  it("does not leave a dropped skip claimed in a reply that ends in a question", async () => {
    const result = await turn("yeah no", { kind: "final", text: "Skipped Meal 5 and logged 2 cups. Anything else?",
      actions: [skip(), { kind: "log_water", numericArgs: [480] }] }, { history: true, id: "19" });
    expect(result.actions).toMatchObject([{ kind: "log_water" }]);
    const content = result.messages.at(-1)?.content ?? "";
    expect(content).toContain(SKIP_NOT_CONFIRMED);
    expect(content).not.toContain("Skipped Meal 5");
  });

  it("applies a skip_slot that answers the earlier offer with a yes", async () => {
    const result = await turn("Skip and rebalance", { kind: "final", text: "Skipped Meal 5.",
      actions: [skip()] }, { history: true, id: "15" });
    expect(result.actions).toMatchObject([{ kind: "skip_slot", slot: "meal-5", date: "2026-09-19" }]);
  });
});
