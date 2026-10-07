/**
 * COACH_PROVIDER selects between the pinned Gemini and OpenRouter coach models at module load.
 * Tests stub the OpenRouter pin so routing proves it reads the pin table.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/lanes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/lanes")>();
  return { ...actual, OPENROUTER_PINS: { ...actual.OPENROUTER_PINS,
    coach: "openai/gpt-5-mini" } };
});

// Each case resets the module registry and re-imports the coach graph (~1.2 s alone); under the
// full suite's load that passed 5 s. A slow import is not a failure (2026-10-02).
vi.setConfig({ testTimeout: 20_000 });

// 2026-10-02 Grok audit (finding #4): the commented example named "gemini" — a value this file's
// own type (`"google" | "openrouter"`) does not accept; any non-"openrouter" value falls through
// to "google" today, so the stale doc did not break anything, but it told an operator the wrong
// value to actually set.
describe(".env.example documents a real COACH_PROVIDER value (finding #4)", () => {
  it("names \"google\", not \"gemini\"", () => {
    const envExample = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");
    expect(envExample).toMatch(/^# COACH_PROVIDER=google$/m);
    expect(envExample).not.toMatch(/^# COACH_PROVIDER=gemini$/m);
  });
});

describe("COACH_PROVIDER and the pinned coach model", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it("defaults to google at the pinned literal with no env set", async () => {
    vi.resetModules();
    const { COACH_PROVIDER, COACH_MODEL_ID, GEMINI_COACH, isOpenRouterModelId } =
      await import("@/lib/ai/models");
    expect(COACH_PROVIDER).toBe("google");
    expect(COACH_MODEL_ID).toBe(GEMINI_COACH);
    expect(isOpenRouterModelId(COACH_MODEL_ID)).toBe(false);
  });

  it("COACH_PROVIDER=openrouter takes the OpenRouter pin", async () => {
    vi.stubEnv("COACH_PROVIDER", "openrouter");
    // Routing to OpenRouter also needs the key configured and
    // the attestation recorded — see the two new fail-closed cases below.
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    vi.stubEnv("OPENROUTER_ATTESTED", "1");
    vi.resetModules();
    const { COACH_PROVIDER, COACH_MODEL_ID, isOpenRouterModelId } = await import("@/lib/ai/models");
    expect(COACH_PROVIDER).toBe("openrouter");
    expect(COACH_MODEL_ID).toBe("openai/gpt-5-mini");
    expect(isOpenRouterModelId(COACH_MODEL_ID)).toBe(true);
  });

  it("COACH_PROVIDER=openrouter with no key or attestation fails closed to google", async () => {
    vi.stubEnv("COACH_PROVIDER", "openrouter");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("OPENROUTER_ATTESTED", "");
    vi.resetModules();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { COACH_PROVIDER, COACH_MODEL_ID, GEMINI_COACH, isOpenRouterModelId } =
      await import("@/lib/ai/models");
    expect(COACH_PROVIDER).toBe("google");
    expect(COACH_MODEL_ID).toBe(GEMINI_COACH);
    expect(isOpenRouterModelId(COACH_MODEL_ID)).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("COACH_PROVIDER=openrouter with no OPENROUTER_API_KEY fails closed to google, with a warning", async () => {
    vi.stubEnv("COACH_PROVIDER", "openrouter");
    // This machine's own shell carries a real key (zs-api-keys.env) — stub it away explicitly so
    // this case actually proves "unset", not whatever happens to be in the ambient environment.
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("OPENROUTER_ATTESTED", "1");
    vi.resetModules();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { COACH_PROVIDER, COACH_MODEL_ID, GEMINI_COACH, isOpenRouterModelId } =
      await import("@/lib/ai/models");
    expect(COACH_PROVIDER).toBe("google");
    expect(COACH_MODEL_ID).toBe(GEMINI_COACH);
    expect(isOpenRouterModelId(COACH_MODEL_ID)).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("COACH_PROVIDER=openrouter with no OPENROUTER_ATTESTED fails closed to google, with a warning", async () => {
    vi.stubEnv("COACH_PROVIDER", "openrouter");
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    vi.stubEnv("OPENROUTER_ATTESTED", "");
    vi.resetModules();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { COACH_PROVIDER, COACH_MODEL_ID, GEMINI_COACH } = await import("@/lib/ai/models");
    expect(COACH_PROVIDER).toBe("google");
    expect(COACH_MODEL_ID).toBe(GEMINI_COACH);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("any value but \"openrouter\" keeps the default provider", async () => {
    vi.stubEnv("COACH_PROVIDER", "anthropic");
    vi.resetModules();
    const { COACH_PROVIDER, COACH_MODEL_ID, GEMINI_COACH } = await import("@/lib/ai/models");
    expect(COACH_PROVIDER).toBe("google");
    expect(COACH_MODEL_ID).toBe(GEMINI_COACH);
  });
});

describe("the coach turn routes its PRIMARY call by COACH_PROVIDER (owner request 2026-10-02)", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it("COACH_PROVIDER=openrouter sends the turn through generateOpenRouter, not generate", async () => {
    vi.stubEnv("COACH_ENABLED", "1");
    vi.stubEnv("HEALTH_CONTEXT_PROVIDER", "gemini");
    vi.stubEnv("GEMINI_BILLING_ATTESTED", "1");
    vi.stubEnv("COACH_PROVIDER", "openrouter");
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    vi.stubEnv("OPENROUTER_ATTESTED", "1");
    vi.resetModules();
    const { runTurn } = await import("@/lib/server/coach-turn");
    const { COACH_MODEL_ID } = await import("@/lib/ai/models");
    expect(COACH_MODEL_ID).toBe("openai/gpt-5-mini");

    const writes: { table: string; row: unknown }[] = [];
    const api = (table: string) => {
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain, eq: () => chain, in: () => chain, is: () => chain, gte: () => chain,
        order: () => chain, limit: () => chain,
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => ({ data: null, error: null }),
        then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
          Promise.resolve({ data: [], error: null }).then(resolve),
        insert: (row: unknown) => { writes.push({ table, row }); return chain; },
        update: (row: unknown) => { writes.push({ table, row }); return chain; },
      });
      return chain;
    };
    const db = () => ({ from: (t: string) => api(t), rpc: async () => ({ data: [], error: null }) }) as never;
    const ports = {
      dayTotals: async () => ({ local_date: "2026-09-16", nutrients: [] }),
      weekTotals: async () => [], activeTargets: async () => ({ kcal_train: 2200 }),
      latestEstimate: async () => ({ status: "burn_in" }), searchFoods: async () => [],
      getConstraints: async () => ({ avoid_allergens: [] }), recentGut: async () => [],
      dayPlan: async () => ({ slots: [] }), dayEntries: async () => [],
      compose: async () => ({ wish: "", slot: null, items: [],
        totals: { kcal: 0, protein: 0, carbs: 0, fat: 0 },
        target: { kcal: 0, protein: 0, carbs: 0, fat: 0 }, flagged: [], fitsTarget: false }),
      newDraftId: () => "draft-1",
    };
    const generate = vi.fn();
    const generateOpenRouter = vi.fn(async (args: { modelId: string }) => {
      expect(args.modelId).toBe("openai/gpt-5-mini");
      return { kind: "final", text: "OpenRouter answered." };
    });

    const res = await runTurn(db(), db(), "u1",
      { threadId: null, messageId: "3f1b1a2c-0000-4000-8000-000000000070",
        text: "what should I eat", now: "2026-09-16T15:00:00.000Z", tz: "America/Denver" },
      { generate: generate as never, generateOpenRouter: generateOpenRouter as never, ports,
        classifyIntent: vi.fn().mockResolvedValue(null) as never });

    expect(generate).not.toHaveBeenCalled();
    expect(generateOpenRouter).toHaveBeenCalledTimes(1);
    expect(res.model).toMatchObject({ provider: "openrouter", modelId: "openai/gpt-5-mini" });
  });
});
