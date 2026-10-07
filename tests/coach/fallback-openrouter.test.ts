/**
 * Owner request 2026-10-02 (T8): the coach's OpenRouter capacity fallback
 * (lib/server/coach-turn/model-loop.ts tryOpenRouterFallback) — a quota 429 that today skips the
 * same-key Gemini fallback entirely goes to OpenRouter when its key and attestation are ready;
 * a 503 that exhausts BOTH Gemini options retries once on OpenRouter too. Without the key or
 * attestation, the turn ends as tests/coach/fallback-model.test.ts proves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/lanes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/lanes")>();
  return { ...actual, OPENROUTER_PINS: { ...actual.OPENROUTER_PINS,
    coachFallback: "openai/gpt-5-mini" } };
});
import { runTurn } from "@/tests/coach/fixtures/run-turn";
import { COACH_FALLBACK_MODEL_ID, COACH_MODEL_ID } from "@/lib/ai/models";

const REQ = { threadId: null, messageId: "3f1b1a2c-0000-4000-8000-000000000060",
  text: "what should I eat", now: "2026-09-16T15:00:00.000Z", tz: "America/Denver" };
const OPENROUTER_MODEL = "openai/gpt-5-mini";

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

/** A quota 429 — worth no second GEMINI model (lib/ai/failures.ts worthAnotherModel), but still a
 *  capacity failure OpenRouter's different key is worth trying. */
const quota429 = () => new Error("429 RESOURCE_EXHAUSTED: You exceeded your current quota");
/** A plain capacity 503, worth the same-key Gemini fallback first. */
const overloaded503 = () => new Error("503 model overloaded");

function readyEnv(): void {
  vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
  vi.stubEnv("OPENROUTER_ATTESTED", "1");
}

describe("the coach's OpenRouter capacity fallback (owner request 2026-10-02)", () => {
  beforeEach(() => {
    vi.stubEnv("COACH_ENABLED", "1");
    vi.stubEnv("HEALTH_CONTEXT_PROVIDER", "gemini");
    vi.stubEnv("GEMINI_BILLING_ATTESTED", "1");
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("a key-quota 429 skips the same-key Gemini fallback and retries once on OpenRouter", async () => {
    readyEnv();
    const writes = { rows: [] as { table: string; row: unknown }[] };
    const geminiCalls: string[] = [];
    const generate = vi.fn(async (args: { route?: { modelId: string } }) => {
      geminiCalls.push(args.route?.modelId ?? "");
      throw quota429();
    }) as never;
    const generateOpenRouter = vi.fn(async (args: { modelId: string }) => {
      expect(args.modelId).toBe(OPENROUTER_MODEL);
      return { kind: "final", text: "OpenRouter answered." };
    }) as never;

    const res = await runTurn(db(writes), db(writes), "u1", REQ,
      { generate, generateOpenRouter, ports, classifyIntent: noClassify(),
        newId: () => "3f1b1a2c-0000-4000-8000-0000000000b1" });

    // No second Gemini model: 429 is the key's own quota, so only the pin was ever tried.
    expect(geminiCalls).toEqual([COACH_MODEL_ID]);
    expect(generateOpenRouter).toHaveBeenCalledTimes(1);
    expect(res.model).toMatchObject({ provider: "openrouter", modelId: OPENROUTER_MODEL,
      fellBackBecause: "capacity" });
    const assistant = writes.rows.filter((w) => w.table === "coach_messages")
      .map((w) => w.row as { role: string; model_id: string })
      .find((row) => row.role === "assistant");
    expect(assistant?.model_id).toBe(OPENROUTER_MODEL);
  });

  // 2026-10-02: with a different provider configured, a Gemini capacity failure goes straight
  // there — the second Gemini model failed right after the first on 2026-09-24 and 2026-10-02.
  it("a Gemini 503 goes straight to the configured OpenRouter fallback, skipping the same-key model", async () => {
    readyEnv();
    const writes = { rows: [] as { table: string; row: unknown }[] };
    const geminiCalls: string[] = [];
    const generate = vi.fn(async (args: { route?: { modelId: string } }) => {
      geminiCalls.push(args.route?.modelId ?? "");
      throw overloaded503();
    }) as never;
    const generateOpenRouter = vi.fn(async () => ({ kind: "final", text: "OpenRouter answered." })) as never;

    const res = await runTurn(db(writes), db(writes), "u1", REQ,
      { generate, generateOpenRouter, ports, classifyIntent: noClassify() });

    expect(geminiCalls).toEqual([COACH_MODEL_ID]);
    expect(generateOpenRouter).toHaveBeenCalledTimes(1);
    expect(res.model.modelId).toBe(OPENROUTER_MODEL);
  });

  // Grok audit round 5 (MED): an OpenRouter failure (a 400, a 401, its own 503) must not end a turn
  // that the same-key Gemini fallback can still answer.
  it("a Gemini 503 whose OpenRouter fallback then fails still tries the same-key Gemini model", async () => {
    readyEnv();
    const writes = { rows: [] as { table: string; row: unknown }[] };
    const geminiCalls: string[] = [];
    const generate = vi.fn(async (args: { route?: { modelId: string } }) => {
      geminiCalls.push(args.route?.modelId ?? "");
      if (args.route?.modelId === COACH_MODEL_ID) throw overloaded503();
      return { kind: "final", text: "The other Gemini model answered." };
    }) as never;
    const generateOpenRouter = vi.fn(async () => { throw new Error("openrouter 400 bad request"); }) as never;

    const res = await runTurn(db(writes), db(writes), "u1", REQ,
      { generate, generateOpenRouter, ports, classifyIntent: noClassify() });

    expect(generateOpenRouter).toHaveBeenCalledTimes(1);
    expect(geminiCalls).toEqual([COACH_MODEL_ID, COACH_FALLBACK_MODEL_ID]);
    expect(res.model.modelId).toBe(COACH_FALLBACK_MODEL_ID);
  });

  // Live 2026-10-02: gemini-3.6-flash "did not answer within 4972ms" and the turn ended with
  // "Sasha is unavailable" although OpenRouter was configured: a timeout was not a capacity failure.
  it("a Gemini timeout goes to the configured OpenRouter fallback instead of ending the turn", async () => {
    readyEnv();
    const writes = { rows: [] as { table: string; row: unknown }[] };
    const generate = vi.fn(async () => {
      const e = new Error("the provider did not answer within 4972ms"); e.name = "AbortError"; throw e;
    }) as never;
    const generateOpenRouter = vi.fn(async () => ({ kind: "final", text: "OpenRouter answered." })) as never;
    const res = await runTurn(db(writes), db(writes), "u1", REQ,
      { generate, generateOpenRouter, ports, classifyIntent: noClassify() });
    expect(generateOpenRouter).toHaveBeenCalledTimes(1);
    expect(res.model.modelId).toBe(OPENROUTER_MODEL);
  });

  it("without OpenRouter key and attestation a failing Gemini fallback is still a 503", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("OPENROUTER_ATTESTED", "");
    const writes = { rows: [] as { table: string; row: unknown }[] };
    const generate = vi.fn(async () => { throw overloaded503(); }) as never;
    // A provided double that must never be reached when OpenRouter is not ready.
    const generateOpenRouter = vi.fn(async () => ({ kind: "final", text: "should not run" })) as never;

    await expect(runTurn(db(writes), db(writes), "u1", REQ,
      { generate, generateOpenRouter, ports, classifyIntent: noClassify() }))
      .rejects.toMatchObject({ status: 503, code: "coach_unavailable" });
    expect(generateOpenRouter).not.toHaveBeenCalled();
  });

  it("keyed but not attested: the fallback is not attempted", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    vi.stubEnv("OPENROUTER_ATTESTED", "");
    const writes = { rows: [] as { table: string; row: unknown }[] };
    const generate = vi.fn(async () => { throw overloaded503(); }) as never;
    const generateOpenRouter = vi.fn(async () => ({ kind: "final", text: "should not run" })) as never;

    await expect(runTurn(db(writes), db(writes), "u1", REQ,
      { generate, generateOpenRouter, ports, classifyIntent: noClassify() }))
      .rejects.toMatchObject({ status: 503, code: "coach_unavailable" });
    expect(generateOpenRouter).not.toHaveBeenCalled();
  });

  it("attested but no key: the fallback is not attempted", async () => {
    vi.stubEnv("OPENROUTER_ATTESTED", "1");
    // The real key may be present in the ambient environment (it is auto-sourced on this
    // machine); blank it explicitly rather than relying on it being absent.
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const writes = { rows: [] as { table: string; row: unknown }[] };
    const generate = vi.fn(async () => { throw overloaded503(); }) as never;
    const generateOpenRouter = vi.fn(async () => ({ kind: "final", text: "should not run" })) as never;

    await expect(runTurn(db(writes), db(writes), "u1", REQ,
      { generate, generateOpenRouter, ports, classifyIntent: noClassify() }))
      .rejects.toMatchObject({ status: 503, code: "coach_unavailable" });
    expect(generateOpenRouter).not.toHaveBeenCalled();
  });
});
