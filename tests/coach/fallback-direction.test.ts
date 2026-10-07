/**
 * 2026-10-02 Grok audit: lib/server/coach-turn/model-loop.ts's capacity fallback always treated
 * COACH_FALLBACK_MODEL_ID (a Gemini model) as the SAME-key option and OpenRouter as the
 * DIFFERENT-key one — correct when Gemini is primary (COACH_PROVIDER unset), inverted when
 * COACH_PROVIDER=openrouter. A key-quota 429 from the OpenRouter PRIMARY then retried on
 * COACH_OPENROUTER_FALLBACK_MODEL — the SAME OpenRouter key/account, which meets the identical
 * quota wall — and never reached Gemini, a genuinely different provider.
 *
 * COACH_PROVIDER/COACH_MODEL_ID are module-load constants, so these cases reset the module
 * registry and re-import, the same pattern tests/coach/provider-selection.test.ts uses.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/lanes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/lanes")>();
  return { ...actual, OPENROUTER_PINS: { ...actual.OPENROUTER_PINS,
    coach: "openai/gpt-5-mini", coachFallback: "anthropic/claude-haiku" } };
});

// Each case resets the module registry and re-imports the coach graph (~1.2 s alone); under the
// full suite's load that passed 5 s. A slow import is not a failure (2026-10-02).
vi.setConfig({ testTimeout: 20_000 });

const OPENROUTER_MODEL = "openai/gpt-5-mini";
const OPENROUTER_FALLBACK_MODEL = "anthropic/claude-haiku";

function db(writes: { rows: { table: string; row: unknown }[] }) {
  const api = (table: string) => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain, eq: () => chain, in: () => chain, is: () => chain, gte: () => chain,
      order: () => chain, limit: () => chain,
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: null, error: null }),
      then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(resolve),
      insert: (row: unknown) => { writes.rows.push({ table, row }); return chain; },
      update: (row: unknown) => { writes.rows.push({ table, row }); return chain; },
    });
    return chain;
  };
  return { from: (t: string) => api(t), rpc: async () => ({ data: [], error: null }) } as never;
}

const ports = {
  dayTotals: async () => ({ local_date: "2026-09-16", nutrients: [] }),
  weekTotals: async () => [],
  activeTargets: async () => ({ kcal_train: 2200 }),
  latestEstimate: async () => ({ status: "burn_in" }),
  searchFoods: async () => [],
  getConstraints: async () => ({ avoid_allergens: [] }),
  recentGut: async () => [],
  dayPlan: async () => ({ slots: [] }),
  dayEntries: async () => [],
  compose: async () => ({ wish: "", slot: null, items: [],
    totals: { kcal: 0, protein: 0, carbs: 0, fat: 0 },
    target: { kcal: 0, protein: 0, carbs: 0, fat: 0 }, flagged: [], fitsTarget: false }),
  newDraftId: () => "draft-1",
};

const noClassify = () => vi.fn().mockResolvedValue(null) as never;
const REQ = { threadId: null, messageId: "3f1b1a2c-0000-4000-8000-000000000090",
  text: "what should I eat", now: "2026-09-16T15:00:00.000Z", tz: "America/Denver" };

/** A quota 429 — not worth another model on the SAME key, whichever provider that key belongs
 *  to (lib/ai/failures.ts worthAnotherModel). */
const quota429 = () => new Error("429 RESOURCE_EXHAUSTED: You exceeded your current quota");
/** A plain capacity 503 — worth trying another model on the same key first. */
const overloaded503 = () => new Error("503 model overloaded");

function readyEnv(): void {
  vi.stubEnv("COACH_ENABLED", "1");
  vi.stubEnv("HEALTH_CONTEXT_PROVIDER", "gemini");
  vi.stubEnv("GEMINI_BILLING_ATTESTED", "1");
  vi.stubEnv("COACH_PROVIDER", "openrouter");
  vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
  vi.stubEnv("OPENROUTER_ATTESTED", "1");
}

describe("the coach's capacity fallback direction flips with COACH_PROVIDER (2026-10-02 Grok audit)", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it("an OpenRouter-primary key-quota 429 falls back to Gemini, not another OpenRouter model", async () => {
    readyEnv();
    // No same-key OpenRouter fallback configured: the only place left to go is Gemini.
    vi.resetModules();
    const { runTurn } = await import("@/lib/server/coach-turn");
    const { GEMINI_COACH } = await import("@/lib/ai/models");

    const writes = { rows: [] as { table: string; row: unknown }[] };
    const openRouterCalls: string[] = [];
    const generateOpenRouter = vi.fn(async (args: { modelId: string }) => {
      openRouterCalls.push(args.modelId);
      throw quota429();
    });
    const generate = vi.fn(async () => ({ kind: "final", text: "Gemini answered." }));

    const res = await runTurn(db(writes), db(writes), "u1", REQ, {
      generate: generate as never, generateOpenRouter: generateOpenRouter as never, ports,
      classifyIntent: noClassify(), newId: () => "3f1b1a2c-0000-4000-8000-0000000000c1",
    });

    // Only the OpenRouter PIN was ever tried on that key — a 429 is its own account's quota.
    expect(openRouterCalls).toEqual([OPENROUTER_MODEL]);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(res.model).toMatchObject({ provider: "gemini", modelId: GEMINI_COACH,
      fellBackBecause: "capacity" });
  });

  it("an OpenRouter-primary 503 tries the configured same-key OpenRouter model before Gemini", async () => {
    readyEnv();
    vi.resetModules();
    const { runTurn } = await import("@/lib/server/coach-turn");

    const writes = { rows: [] as { table: string; row: unknown }[] };
    const openRouterCalls: string[] = [];
    const generateOpenRouter = vi.fn(async (args: { modelId: string }) => {
      openRouterCalls.push(args.modelId);
      if (args.modelId === OPENROUTER_MODEL) throw overloaded503();
      return { kind: "final", text: "the same-key OpenRouter fallback answered." };
    });
    const generate = vi.fn();

    const res = await runTurn(db(writes), db(writes), "u1", REQ, {
      generate: generate as never, generateOpenRouter: generateOpenRouter as never, ports,
      classifyIntent: noClassify(), newId: () => "3f1b1a2c-0000-4000-8000-0000000000c2",
    });

    expect(openRouterCalls).toEqual([OPENROUTER_MODEL, OPENROUTER_FALLBACK_MODEL]);
    expect(generate).not.toHaveBeenCalled();
    expect(res.model).toMatchObject({ provider: "openrouter", modelId: OPENROUTER_FALLBACK_MODEL,
      fellBackBecause: "capacity" });
  });

  it("an OpenRouter-primary 503 falls through to Gemini once its same-key option is also out", async () => {
    readyEnv();
    vi.resetModules();
    const { runTurn } = await import("@/lib/server/coach-turn");
    const { GEMINI_COACH } = await import("@/lib/ai/models");

    const writes = { rows: [] as { table: string; row: unknown }[] };
    const openRouterCalls: string[] = [];
    const generateOpenRouter = vi.fn(async (args: { modelId: string }) => {
      openRouterCalls.push(args.modelId);
      throw overloaded503();
    });
    const generate = vi.fn(async () => ({ kind: "final", text: "Gemini answered." }));

    const res = await runTurn(db(writes), db(writes), "u1", REQ, {
      generate: generate as never, generateOpenRouter: generateOpenRouter as never, ports,
      classifyIntent: noClassify(), newId: () => "3f1b1a2c-0000-4000-8000-0000000000c3",
    });

    expect(openRouterCalls).toEqual([OPENROUTER_MODEL, OPENROUTER_FALLBACK_MODEL]);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(res.model).toMatchObject({ provider: "gemini", modelId: GEMINI_COACH,
      fellBackBecause: "capacity" });
  });
});
