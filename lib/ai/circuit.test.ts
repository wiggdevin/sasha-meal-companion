import { describe, expect, it, vi } from "vitest";

/**
 * Finding #71: the circuit breaker keeps its failure counter in a module-level Map, which a
 * Vercel serverless cold start clears. These tests stand in a fresh module instance for a cold
 * start (`vi.resetModules` + a fresh dynamic import) and a durable row store for `ai_calls` (the
 * same store `assertTurnBudget`/`assertUnderSpendCap` already read) for what should survive it.
 */

type Row = { provider: string; model_id?: string; status: string; created_at: string };

/** Minimal stand-in for the admin client's `ai_calls` query the circuit breaker should run. */
function fakeAdmin(rows: Row[]): { from: (table: string) => unknown } {
  return {
    from: () => ({
      select: () => {
        const filters: { provider?: string; model?: string; statusNeq?: string; statusIn?: string[]; createdAtGte?: string } = {};
        const chain = {
          eq: (col: string, val: string) => {
            if (col === "provider") filters.provider = val;
            if (col === "model_id") filters.model = val;
            return chain;
          },
          neq: (col: string, val: string) => {
            if (col === "status") filters.statusNeq = val;
            return chain;
          },
          in: (col: string, vals: string[]) => {
            if (col === "status") filters.statusIn = vals;
            return chain;
          },
          gte: async (col: string, val: string) => {
            if (col === "created_at") filters.createdAtGte = val;
            const data = rows.filter((r) =>
              (filters.provider === undefined || r.provider === filters.provider) &&
              (filters.model === undefined || r.model_id === filters.model) &&
              (filters.statusNeq === undefined || r.status !== filters.statusNeq) &&
              (filters.statusIn === undefined || filters.statusIn.includes(r.status)) &&
              (filters.createdAtGte === undefined || r.created_at >= filters.createdAtGte)
            );
            return { data, error: null };
          },
        };
        return chain;
      },
    }),
  };
}

describe("circuit breaker durability across a serverless cold start", () => {
  it("keeps a provider's circuit open after a fresh module instance (cold start)", async () => {
    // The durable store: a plain array outside any module's memory — standing in for the
    // ai_calls rows a real cold-started instance would still be able to read.
    const store: Row[] = Array.from({ length: 5 }, () => ({
      provider: "google", status: "error", created_at: new Date().toISOString(),
    }));
    const admin = fakeAdmin(store);

    const first = await import("./circuit");
    await expect(first.assertCircuitClosed(admin as never, "google")).rejects.toThrow(
      "circuit open for google: 5 failures in the last 10 minutes"
    );

    // Simulate a fresh serverless instance: a brand-new module registry, so any module-level
    // state from the first import is gone.
    vi.resetModules();
    const second = await import("./circuit");
    await expect(second.assertCircuitClosed(admin as never, "google")).rejects.toThrow(
      "circuit open for google: 5 failures in the last 10 minutes"
    );
  });

  it("stays closed once the failures are outside the ten-minute window", async () => {
    const old = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    const store: Row[] = Array.from({ length: 5 }, () => ({
      provider: "google", status: "error", created_at: old,
    }));
    const admin = fakeAdmin(store);
    const { assertCircuitClosed } = await import("./circuit");
    await expect(assertCircuitClosed(admin as never, "google")).resolves.toBeUndefined();
  });

  it("counts only provider failures: replies the schema rejected do not open it", async () => {
    // A provider that answers with the wrong shape is up. Before 2026-10-01 every non-ok row
    // counted, so five rejected replies from anyone switched AI off for every account.
    const now = new Date().toISOString();
    const rejected: Row[] = Array.from({ length: 6 }, () => ({ provider: "google", status: "schema_invalid", created_at: now }));
    const { assertCircuitClosed } = await import("./circuit");
    await expect(assertCircuitClosed(fakeAdmin(rejected) as never, "google")).resolves.toBeUndefined();
    const down: Row[] = ["provider_error", "timeout", "error", "provider_error", "timeout"]
      .map((status) => ({ provider: "google", status, created_at: now }));
    await expect(assertCircuitClosed(fakeAdmin(down) as never, "google")).rejects.toThrow(/circuit open/);
  });

  /** 2026-10-02 live capture smoke: gemini-3.8-flash answered 503 under demand while 3.6 answered
   *  in a second. A circuit per provider let one overloaded model shut every Gemini call. */
  it("opens per model: one model's failures leave the other model's circuit closed", async () => {
    const now = new Date().toISOString();
    const down: Row[] = Array.from({ length: 5 }, () => ({
      provider: "google", model_id: "gemini-3.8-flash", status: "timeout", created_at: now,
    }));
    const { assertCircuitClosed } = await import("./circuit");
    await expect(assertCircuitClosed(fakeAdmin(down) as never, "google", "gemini-3.8-flash"))
      .rejects.toThrow("circuit open for google gemini-3.8-flash");
    await expect(assertCircuitClosed(fakeAdmin(down) as never, "google", "gemini-3.6-flash"))
      .resolves.toBeUndefined();
  });

  /**
   * 2026-10-06 (Gemini project denial, #gemini-fallback): a 403 PERMISSION_DENIED
   * (lib/ai/call.ts classifyFailure -> "permission_denied") says the whole project is blocked,
   * not that this one call was unlucky, so ONE row of it opens the circuit — the usual
   * five-in-ten-minutes window would let four more callers burn a full retry budget on a key
   * already known to be dead.
   */
  it("opens on the FIRST permission_denied row, not the usual five-failure threshold", async () => {
    const now = new Date().toISOString();
    const denied: Row[] = [
      { provider: "google", model_id: "gemini-3.8-flash", status: "permission_denied", created_at: now },
    ];
    const { assertCircuitClosed } = await import("./circuit");
    await expect(assertCircuitClosed(fakeAdmin(denied) as never, "google", "gemini-3.8-flash"))
      .rejects.toThrow("circuit open for google gemini-3.8-flash: the provider denied this project's access");
  });

  /** 2026-10-06 Sol review: a 403 denies the whole GOOGLE project, every model on the key alike
   *  — unlike an ordinary failure (timeout, 503), which stays model-scoped because it says
   *  nothing about a model's neighbours on the same key. */
  it("opens every Google model's circuit on one model's permission_denied row", async () => {
    const now = new Date().toISOString();
    const denied: Row[] = [
      { provider: "google", model_id: "gemini-3.8-flash", status: "permission_denied", created_at: now },
    ];
    const { assertCircuitClosed } = await import("./circuit");
    await expect(assertCircuitClosed(fakeAdmin(denied) as never, "google", "gemini-3.6-flash"))
      .rejects.toThrow("circuit open for google gemini-3.6-flash: the provider denied this project's access");
  });

  it("keeps a non-Google provider's permission_denied trip scoped per model", async () => {
    const now = new Date().toISOString();
    const denied: Row[] = [
      { provider: "openrouter", model_id: "google/gemini-2.5-flash", status: "permission_denied", created_at: now },
    ];
    const { assertCircuitClosed } = await import("./circuit");
    await expect(assertCircuitClosed(fakeAdmin(denied) as never, "openrouter", "google/gemini-2.5-flash"))
      .rejects.toThrow("circuit open for openrouter google/gemini-2.5-flash");
    await expect(assertCircuitClosed(fakeAdmin(denied) as never, "openrouter", "google/gemini-3-flash-preview"))
      .resolves.toBeUndefined();
  });

  it("does not open on a permission_denied row outside the ten-minute window", async () => {
    const old = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    const denied: Row[] = [
      { provider: "google", model_id: "gemini-3.8-flash", status: "permission_denied", created_at: old },
    ];
    const { assertCircuitClosed } = await import("./circuit");
    await expect(assertCircuitClosed(fakeAdmin(denied) as never, "google", "gemini-3.8-flash"))
      .resolves.toBeUndefined();
  });
});
