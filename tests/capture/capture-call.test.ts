import { withSpendRpc } from "@/tests/ai/spend-admin";
import { describe, expect, it, vi } from "vitest";
import { ProviderHttpError } from "@/lib/ai/adapter";
import { fallbackBudgetMs, PURPOSE_BY_METHOD, runCapture } from "@/lib/ai/capture";
import { capturePayload } from "@/lib/ai/gemini-payloads";

/**
 * The circuit breaker now reads its failure history from `ai_calls` (audit #71) instead of a
 * module-level Map, so this fake's `select` filters the rows `insert` has recorded — the same
 * way a real cold-started instance would read back what a prior instance wrote.
 */
function fakeAdmin() {
  const calls: Record<string, unknown>[] = [];
  const client = withSpendRpc({ from: () => ({
    insert: async (row: Record<string, unknown>) => { calls.push(row); return { error: null }; },
    select: () => {
      const filters: { provider?: string; statusNeq?: string } = {};
      const chain = {
        eq: (col: string, val: string) => { if (col === "provider") filters.provider = val; return chain; },
        neq: (col: string, val: string) => { if (col === "status") filters.statusNeq = val; return chain; },
        gte: async () => ({
          data: calls
            .filter((c) =>
              (filters.provider === undefined || c.provider === filters.provider) &&
              (filters.statusNeq === undefined || c.status !== filters.statusNeq))
            .map(() => ({ created_at: new Date().toISOString() })),
          error: null,
        }),
      };
      return chain;
    },
  }) });
  return { calls, client };
}

const INPUT = { text: "two eggs", slot: "meal-1", localDate: "2026-09-11" };

describe("runCapture", () => {
  it("maps each method to its adapter purpose", () => {
    expect(PURPOSE_BY_METHOD).toEqual({
      text: "textToItems", voice: "voiceToItems", label: "labelToNutrients", photo: "photoToItems",
    });
  });

  it("sends the system prompt then the data envelope, and returns the parsed items", async () => {
    const { client } = fakeAdmin();
    let seen: { text?: string }[] = [];
    const out = await runCapture(capturePayload("textToItems", INPUT), { userId: "u1", admin: client as never }, {
      sleep: async () => {},
      callGemini: async (_m: string, parts: unknown) => {
        seen = parts as { text?: string }[];
        return { text: JSON.stringify({ items: [], notes: [] }), inputTokens: 1, outputTokens: 1 };
      },
    });
    expect(out).toEqual({ items: [], notes: [] });
    expect(seen[0].text).toContain("untrusted");
    expect(JSON.parse(seen[1].text as string)).toEqual({
      data: { text: "two eggs" }, slot: "meal-1", localDate: "2026-09-11",
    });
  });

  it("turns an open circuit into 503 provider_unavailable", async () => {
    const { client } = fakeAdmin();
    const boom = { sleep: async () => {},
      callGemini: async () => { throw new ProviderHttpError(503, "gemini 503"); } };
    const args = [{ userId: "u1", admin: client as never }, boom] as const;
    for (let i = 0; i < 5; i++) {
      await expect(runCapture(capturePayload("textToItems", INPUT), ...args)).rejects.toBeTruthy();
    }
    await expect(runCapture(capturePayload("textToItems", INPUT), ...args))
      .rejects.toMatchObject({ status: 503, code: "provider_unavailable" });
  });

  it("turns a schema rejection into 422 schema_invalid", async () => {
    const { client } = fakeAdmin();
    await expect(runCapture(capturePayload("textToItems", INPUT), { userId: "u1", admin: client as never }, {
      sleep: async () => {},
      callGemini: async () => ({ text: '{"items":[{"label":1}]}', inputTokens: 1, outputTokens: 1 }),
    })).rejects.toMatchObject({ status: 422, code: "schema_invalid" });
  });

  // The log names the model that failed last: the fallback, once the primary was out of capacity.
  it("logs a bounded diagnostic when the provider fails after retries, like the coach path does", async () => {
    const { client } = fakeAdmin();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = { sleep: async () => {},
      callGemini: async () => { throw new ProviderHttpError(503, "gemini 503"); } };
    await expect(runCapture(capturePayload("textToItems", INPUT), { userId: "u1", admin: client as never }, boom))
      .rejects.toMatchObject({ status: 503, code: "provider_unavailable" });
    expect(logged).toHaveBeenCalledWith("capture generation failed", {
      purpose: "textToItems",
      provider: "google",
      modelId: "gemini-3.6-flash",
      error: { name: "ProviderHttpError", message: expect.stringContaining("gemini 503") },
    });
    logged.mockRestore();
  });

  /** 2026-10-02 live smoke: gemini-3.8-flash answered 503 under demand for hours while 3.6 answered
   *  in a second, and capture had no other model, so every capture failed. */
  describe("the capture fallback model", () => {
    const answer = { text: JSON.stringify({ items: [], notes: [] }), inputTokens: 1, outputTokens: 1 };
    const run = (fail: () => never) => {
      const { client } = fakeAdmin();
      const models: string[] = [];
      const done = runCapture(capturePayload("textToItems", INPUT), { userId: "u1", admin: client as never }, {
        sleep: async () => {},
        callGemini: async (model: string) => {
          models.push(model);
          if (model === "gemini-3.8-flash") fail();
          return answer;
        },
      });
      return { done, models };
    };

    it("answers from the fallback when the primary is out of capacity, without retrying the primary", async () => {
      const { done, models } = run(() => { throw new ProviderHttpError(503, "gemini 503"); });
      await expect(done).resolves.toEqual({ items: [], notes: [] });
      expect(models).toEqual(["gemini-3.8-flash", "gemini-3.6-flash"]);
    });

    it("answers from the fallback when the primary never answers", async () => {
      const { done, models } = run(() => {
        const e = new Error("the provider did not answer within 6000ms"); e.name = "AbortError"; throw e;
      });
      await expect(done).resolves.toEqual({ items: [], notes: [] });
      expect(models.at(-1)).toBe("gemini-3.6-flash");
    });

    it("does not try the fallback on a key quota (429): the same key meets the same wall", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { done, models } = run(() => { throw new ProviderHttpError(429, "gemini 429"); });
      await expect(done).rejects.toMatchObject({ status: 503, code: "provider_unavailable" });
      expect(models.every((m) => m === "gemini-3.8-flash")).toBe(true);
      vi.restoreAllMocks();
    });
  });
});

/** Grok audit round 6 (MED): media is prepared again for the fallback, outside either model's own
 *  clock, so the fallback gets what is left of ONE capture budget, and none when too little is. */
describe("the capture fallback's budget", () => {
  it("gives the fallback what is left of the one capture budget, less its own preparation", () => {
    expect(fallbackBudgetMs(9_000)).toBe(9_500);
    expect(fallbackBudgetMs(2_000)).toBe(11_000);
  });

  it("does not start the fallback when too little is left for it to answer", () => {
    expect(fallbackBudgetMs(15_500)).toBeNull();
  });
});
