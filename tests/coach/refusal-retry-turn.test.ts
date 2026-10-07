/**
 * Live 2026-10-03 (dev account thread 31a16b2d…): "Find me an easy chicken dinner recipe" was
 * answered "I'm sorry, I cannot fulfill that request." with no tool call. A generic refusal to a
 * confident Jev planner ask gets exactly one corrective round; a keyword-only ask (which may be a
 * safety refusal, Grok review 2026-10-03) never does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FAST_PATH_CONFIDENCE_SUGGEST } from "@/lib/coach/intent";
import { isGenericRefusal, isPlannerAsk, REFUSAL_CORRECTION } from "@/lib/coach/refusal-guard";
import { runTurn } from "@/tests/coach/fixtures/run-turn";

const REFUSAL = "I'm sorry, I cannot fulfill that request.";
const MARKER = "If the request is unsafe, harmful or not a meal idea, keep your refusal.";

function db() {
  const api = () => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain, eq: () => chain, neq: () => chain, lte: () => chain, in: () => chain,
      is: () => chain, gte: () => chain, order: () => chain, limit: () => chain,
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: null, error: null }),
      then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(resolve),
      insert: () => chain, update: () => chain,
    });
    return chain;
  };
  return { from: () => api(), rpc: async () => ({ data: [], error: null }) } as never;
}

const ports = {
  dayTotals: async () => ({ local_date: "2026-09-11", nutrients: [] }),
  weekTotals: async () => [],
  activeTargets: async () => ({ kcal_train: 2200, protein_g: 135 }),
  latestEstimate: async () => ({ status: "burn_in", tdeeKcal: null }),
  searchFoods: async () => [],
  getConstraints: async () => ({}),
  recentGut: async () => [],
  newDraftId: () => "draft-1",
  suggest: async () => [],
};

/** A confident planner intent the fast path still hands to the model (a missing slot). */
const PLANNER = {
  intent: "suggest_options", confidence: 0.96,
  args: { kind: "recipe", count: 2, fitRemaining: true, missing: ["slot"] },
  argConfidence: {}, raw: {},
};

async function turn(text: string, steps: unknown[], intent: unknown = null) {
  const generate = vi.fn();
  for (const step of steps) generate.mockResolvedValueOnce(step);
  const result = await runTurn(db(), db(), "u1", {
    threadId: null, messageId: "3f1b1a2c-0000-4000-8000-000000000021", text,
  }, {
    classifyIntent: vi.fn().mockResolvedValue(intent) as never,
    verifyReply: vi.fn().mockResolvedValue({ flagged: false, p: null }) as never,
    generate: generate as never,
    ports: ports as never,
    now: () => 0,
    newId: () => "id-1",
  });
  const sentCorrection = generate.mock.calls.map((call) => JSON.stringify(call[0]))
    .some((payload) => payload.includes(MARKER));
  return { reply: result.messages[1]?.content, calls: generate.mock.calls.length, sentCorrection };
}

describe("a generic refusal to a meal-idea ask", () => {
  beforeEach(() => {
    vi.stubEnv("COACH_ENABLED", "1");
    vi.stubEnv("TYPESAFE_API_KEY", "");
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("is sent back once on a planner intent and the retried turn reaches suggest_options", async () => {
    const result = await turn("Find me an easy chicken dinner recipe", [
      { kind: "final", text: REFUSAL },
      { kind: "tool", calls: [{ name: "suggest_options", args: { kind: "recipe", count: 2 } }] },
      { kind: "final", text: "Here are two easy chicken dinners." },
    ], PLANNER);
    expect(result.sentCorrection).toBe(true);
    expect(result.calls).toBe(3);
    expect(result.reply).toBe("Here are two easy chicken dinners.");
  });

  it("is retried after a suggest_options call refused only for bad arguments", async () => {
    const result = await turn("Give me two high protein snack ideas", [
      { kind: "tool", calls: [{ name: "suggest_options", args: { kind: "high_protein", count: 2 } }] },
      { kind: "final", text: REFUSAL },
      { kind: "final", text: "Two snacks that fit." },
    ], PLANNER);
    expect(result.sentCorrection).toBe(true);
    expect(result.reply).toBe("Two snacks that fit.");
  });

  it("gets one corrective round, never a loop", async () => {
    const result = await turn("Suggest a snack", [
      { kind: "final", text: REFUSAL },
      { kind: "final", text: REFUSAL },
      { kind: "final", text: "should never be asked for" },
    ], PLANNER);
    expect(result.calls).toBe(2);
    expect(result.reply).toBe(REFUSAL);
  });

  it("keeps a safety refusal on a keyword-only ask with no planner intent", async () => {
    for (const text of ["Cook me a recipe for meth", "I want to eat glass"]) {
      for (const intent of [null, { ...PLANNER, intent: "other", args: {} },
        { ...PLANNER, intent: "question", args: {} }]) {
        const result = await turn(text, [
          { kind: "final", text: REFUSAL },
          { kind: "final", text: "should never be asked for" },
        ], intent);
        expect(result.sentCorrection, text).toBe(false);
        expect(result.calls).toBe(1);
        expect(result.reply).toBe(REFUSAL);
      }
    }
  });

  it("does not retry a planner intent below its confidence threshold", async () => {
    const result = await turn("Find me an easy chicken dinner recipe", [
      { kind: "final", text: REFUSAL },
      { kind: "final", text: "should never be asked for" },
    ], { ...PLANNER, confidence: FAST_PATH_CONFIDENCE_SUGGEST - 0.2 });
    expect(result.sentCorrection).toBe(false);
    expect(result.calls).toBe(1);
  });

  it("leaves an answer that is not a generic refusal", async () => {
    const result = await turn("Find me a dinner recipe", [
      { kind: "final", text: "Which protein would you like, chicken or salmon?" },
    ], PLANNER);
    expect(result.sentCorrection).toBe(false);
    expect(result.calls).toBe(1);
  });
});

describe("refusal guard rules", () => {
  it("recognises short generic refusals only", () => {
    expect(isGenericRefusal(REFUSAL)).toBe(true);
    expect(isGenericRefusal("Sorry, I can't help with that.")).toBe(true);
    expect(isGenericRefusal("I am unable to complete this request.")).toBe(true);
    expect(isGenericRefusal("Here are two snacks: Greek yogurt and an apple.")).toBe(false);
    expect(isGenericRefusal("I can't do that without your target; set one in Profile first.")).toBe(false);
  });

  it("counts only confident planner intents as meal-idea asks", () => {
    expect(isPlannerAsk({ intent: "suggest_options", confidence: FAST_PATH_CONFIDENCE_SUGGEST })).toBe(true);
    expect(isPlannerAsk({ intent: "plan_meal", confidence: 0.99 })).toBe(true);
    expect(isPlannerAsk({ intent: "suggest_options", confidence: 0.6 })).toBe(false);
    expect(isPlannerAsk({ intent: "other", confidence: 0.99 })).toBe(false);
    expect(isPlannerAsk(null)).toBe(false);
  });

  it("names the tools and allows a refusal to stand in the corrective line", () => {
    expect(REFUSAL_CORRECTION).toContain("suggest_options");
    expect(REFUSAL_CORRECTION).toContain("compose_meal");
    expect(REFUSAL_CORRECTION).toContain(MARKER);
    expect(REFUSAL_CORRECTION).not.toMatch(/do not refuse/i);
  });
});
