import { describe, expect, it, vi } from "vitest";
import { getProfile, getRuleReviewStatus } from "./constraints";

const ROW = {
  rev: 2, conditions: [], notes: null, avoid_allergens: ["gluten"], avoid_food_ref_ids: [],
  banned_categories: [], custom_rules: [], rule_review_required: true, rule_reviewed_at: null,
};

/** A minimal `constraint_profiles` query chain that records whether `.abortSignal` was applied. */
function client(row: Record<string, unknown> | null, calls: { signal?: AbortSignal } = {}) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.select = vi.fn(self);
  chain.eq = vi.fn(self);
  chain.abortSignal = vi.fn((signal: AbortSignal) => { calls.signal = signal; return chain; });
  chain.maybeSingle = vi.fn(async () => ({ data: row, error: null }));
  return { from: vi.fn(() => chain) } as never;
}

/** No `.abortSignal` method at all — an older postgrest-js build. The read must still run,
 *  unbounded, rather than throw. */
function clientWithoutAbortSignal(row: Record<string, unknown> | null) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.select = vi.fn(self);
  chain.eq = vi.fn(self);
  chain.maybeSingle = vi.fn(async () => ({ data: row, error: null }));
  return { from: vi.fn(() => chain) } as never;
}

/** A query that resolves the way postgrest-js resolves an aborted fetch: `{ data: null, error }`,
 *  never a thrown/rejected promise. */
function abortedClient() {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.select = vi.fn(self);
  chain.eq = vi.fn(self);
  chain.abortSignal = vi.fn(self);
  chain.maybeSingle = vi.fn(async () => (
    { data: null, error: { message: "AbortError", code: "20", details: "", hint: "" } }));
  return { from: vi.fn(() => chain) } as never;
}

describe("getProfile", () => {
  it("applies the caller's abort signal to the query when one is given", async () => {
    const calls: { signal?: AbortSignal } = {};
    const controller = new AbortController();
    await getProfile(client(ROW, calls), "u1", controller.signal);
    expect(calls.signal).toBe(controller.signal);
  });

  it("reads with no abort signal when none is given", async () => {
    const calls: { signal?: AbortSignal } = {};
    await getProfile(client(ROW, calls), "u1");
    expect(calls.signal).toBeUndefined();
  });

  it("still reads, unbounded, when the client has no abortSignal method", async () => {
    await expect(getProfile(clientWithoutAbortSignal(ROW), "u1")).resolves.toMatchObject({ rev: 2 });
  });

  // 2026-10-03 round-2 audit (Grok MAJOR): postgrest-js resolves an aborted fetch as
  // `{ data: null, error }`, not a rejected promise — wrapping every such `error` in a generic
  // 500 turned a budget cancel into "Could not read the constraint profile."
  it("throws an AbortError, not a generic 500, once the caller's signal has fired", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(getProfile(abortedClient(), "u1", controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
  });

  it("still throws the generic internal error for a real failure with no abort in play", async () => {
    await expect(getProfile(abortedClient(), "u1")).rejects.toMatchObject({ status: 500 });
  });
});

describe("getRuleReviewStatus", () => {
  it("is not required once the flagged account has already been reviewed", async () => {
    const reviewed = { ...ROW, rule_review_required: true, rule_reviewed_at: "2026-09-25T00:00:00Z" };
    const status = await getRuleReviewStatus(client(reviewed), "u1");
    expect(status.required).toBe(false);
  });

  it("is required for a flagged account that has never been reviewed", async () => {
    const status = await getRuleReviewStatus(client(ROW), "u1");
    expect(status.required).toBe(true);
  });

  it("passes its signal through to the read", async () => {
    const calls: { signal?: AbortSignal } = {};
    const controller = new AbortController();
    await getRuleReviewStatus(client(ROW, calls), "u1", controller.signal);
    expect(calls.signal).toBe(controller.signal);
  });
});
