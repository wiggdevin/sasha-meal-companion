/**
 * 2026-10-02 DeepSeek audit: prepareModelTurn (lib/server/coach-turn/model-context.ts) called the
 * unconditional assertGeminiAttested() for every model-loop turn, and the health-context gate
 * (passHealthGate/healthContextRefused, lib/server/coach-turn/setup.ts, lib/ai/attestation.ts) read
 * only the Gemini pair — both Gemini-only, although COACH_PROVIDER=openrouter already routes the
 * turn's actual model call to OpenRouter (lib/server/coach-turn.ts coachModel,
 * lib/ai/models.ts isOpenRouterModelId). With COACH_PROVIDER=openrouter and OPENROUTER_ATTESTED=1
 * but no Gemini pair, every turn threw AttestationRefused before ever reaching the configured,
 * attested provider. The gates must ask which provider the turn is actually attested for.
 *
 * COACH_PROVIDER/COACH_MODEL_ID are module-load constants (lib/ai/models.ts), so a case that needs
 * a non-default value resets the module registry and re-imports — the same pattern
 * tests/coach/provider-selection.test.ts already uses.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/lanes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/lanes")>();
  return { ...actual, OPENROUTER_PINS: { ...actual.OPENROUTER_PINS,
    coach: "openai/gpt-5-mini" } };
});

// Each case resets the module registry and re-imports the coach graph (~1.2 s alone); under the
// full suite's load that passed 5 s. A slow import is not a failure (2026-10-02).
vi.setConfig({ testTimeout: 20_000 });
import { healthContextRefused } from "@/lib/ai/attestation";

const OPENROUTER_MODEL = "openai/gpt-5-mini";

describe("healthContextRefused is provider-aware (2026-10-02 DeepSeek audit)", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
  const health = { conditions: ["ulcerative colitis"], notes: null };

  it("with no modelId argument, stays Gemini-only — existing callers are unaffected", () => {
    vi.stubEnv("HEALTH_CONTEXT_PROVIDER", "");
    vi.stubEnv("GEMINI_BILLING_ATTESTED", "");
    vi.stubEnv("OPENROUTER_ATTESTED", "1");
    expect(healthContextRefused(health)).toBe(true);
  });

  it("lets health context through for the OpenRouter-destined model once OpenRouter is attested, with no Gemini pair", async () => {
    vi.stubEnv("HEALTH_CONTEXT_PROVIDER", "");
    vi.stubEnv("GEMINI_BILLING_ATTESTED", "");
    vi.stubEnv("OPENROUTER_ATTESTED", "1");
    // CI has no key in its environment; without one COACH_PROVIDER=openrouter falls back to Gemini.
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    vi.stubEnv("COACH_PROVIDER", "openrouter");
    vi.resetModules();
    const { healthContextRefused: refused } = await import("@/lib/ai/attestation");
    const { COACH_MODEL_ID } = await import("@/lib/ai/models");
    expect(refused(health, COACH_MODEL_ID)).toBe(false);
    // The SAME call with no modelId stays Gemini-only, so a caller that never passes one (the
    // capture pipeline's health gate) keeps today's behavior byte-identical.
    expect(refused(health)).toBe(true);
  });

  it("still refuses a Gemini-destined model when only OpenRouter is attested", async () => {
    vi.stubEnv("HEALTH_CONTEXT_PROVIDER", "");
    vi.stubEnv("GEMINI_BILLING_ATTESTED", "");
    vi.stubEnv("OPENROUTER_ATTESTED", "1");
    vi.resetModules();
    const { healthContextRefused: refused } = await import("@/lib/ai/attestation");
    const { GEMINI_COACH } = await import("@/lib/ai/models");
    expect(refused(health, GEMINI_COACH)).toBe(true);
  });
});

describe("the coach turn's model-loop attestation gate follows COACH_PROVIDER, not just Gemini (2026-10-02 DeepSeek audit)", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it("reaches OpenRouter with no Gemini attestation at all, once OpenRouter is configured and attested", async () => {
    vi.stubEnv("COACH_ENABLED", "1");
    // The Gemini pair is deliberately left unset: this is the bug scenario the audit names.
    vi.stubEnv("HEALTH_CONTEXT_PROVIDER", "");
    vi.stubEnv("GEMINI_BILLING_ATTESTED", "");
    vi.stubEnv("COACH_PROVIDER", "openrouter");
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    vi.stubEnv("OPENROUTER_ATTESTED", "1");
    vi.resetModules();
    const { runTurn } = await import("@/lib/server/coach-turn");

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
      expect(args.modelId).toBe(OPENROUTER_MODEL);
      return { kind: "final", text: "OpenRouter answered." };
    });

    const res = await runTurn(db(), db(), "u1",
      { threadId: null, messageId: "3f1b1a2c-0000-4000-8000-000000000080",
        text: "what should I eat", now: "2026-09-16T15:00:00.000Z", tz: "America/Denver" },
      { generate: generate as never, generateOpenRouter: generateOpenRouter as never, ports,
        classifyIntent: vi.fn().mockResolvedValue(null) as never });

    expect(generate).not.toHaveBeenCalled();
    expect(generateOpenRouter).toHaveBeenCalledTimes(1);
    expect(res.model).toMatchObject({ provider: "openrouter", modelId: OPENROUTER_MODEL });
  });
});
