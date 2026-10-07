/**
 * T0 §4 / AC4 — grounding runs its database work at the same time, not one round trip after
 * another, and still returns the items in the model's own order.
 *
 * A five-item plate used to cost roughly twenty serialised round trips after the model had
 * already answered. The stubs here record when each call starts and ends, so "concurrent" is
 * measured as real overlap rather than asserted from the shape of the code.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { proposeDraft } from "@/lib/server/capture";

const LABELS = ["eggs", "bacon", "avocado", "rice", "spinach"];

const REQ = { method: "text" as const, localDate: "2026-09-17", tz: "America/New_York",
  slot: "meal-1", text: "a plate" };

/** Records overlap: how many calls were in flight at the busiest moment. */
function overlapMeter() {
  let live = 0;
  let peak = 0;
  return {
    peak: () => peak,
    async run<T>(work: () => Promise<T>): Promise<T> {
      live += 1;
      peak = Math.max(peak, live);
      try { return await work(); } finally { live -= 1; }
    },
  };
}

/** A tick of real asynchrony, so a sequential caller cannot accidentally look concurrent. */
const tick = () => new Promise((r) => setTimeout(r, 1));

function fakeDb(meter: ReturnType<typeof overlapMeter>) {
  const rpc = vi.fn(async (name: string) => {
    if (name === "ai_calls_today") return { data: 0, error: null };
    if (name === "get_or_create_food_ref") {
      return meter.run(async () => { await tick(); return { data: "ref-70", error: null }; });
    }
    return { data: null, error: null };
  });
  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    for (const m of ["select", "gte", "order", "limit", "in", "range"]) chain[m] = vi.fn(self);
    const metered = vi.fn(() => meter.run(async () => { await tick(); return { data: [], error: null }; }));
    chain.eq = table === "catalog_portions" ? metered : vi.fn(self);
    // The ingredient read is paged (t18 r3): it resolves at `.range()`, not `.eq()`.
    if (table === "catalog_ingredients") chain.range = metered;
    chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    chain.insert = vi.fn(async () => ({ error: null }));
    return chain;
  });
  return { rpc, from } as never;
}

const runCapture = vi.fn(async () => ({
  items: LABELS.map((label, i) => ({ label, grams: 50 + i, qty: 1, unit: "whole", confidence: 0.8 })),
  notes: [],
}));

/** Every item's search takes a real tick, and the slowest one answers first. */
function searchFoods(meter: ReturnType<typeof overlapMeter>) {
  return vi.fn(async (_client: unknown, args: { q: string }) => meter.run(async () => {
    await tick();
    return {
      hits: [{ catalogFoodId: 7, revisionId: 70, description: args.q, brand: null,
        source: "fdc_sr_legacy", qualityClass: "analytical", qualityFlags: [], prepState: null,
        score: 0.9, prefStatus: null, policyCategories: [], policy: { verdict: "allowed" } }],
      queryClass: "generic", autoResolve: null, catalogVersion: "v1",
    };
  }));
}

beforeEach(() => { vi.unstubAllEnvs(); vi.stubEnv("CAPTURE_METHODS", "text,voice,label,photo"); });

describe("grounding a five-item plate", () => {
  it("has at least four database calls in flight at once", async () => {
    const meter = overlapMeter();
    await proposeDraft(fakeDb(meter), fakeDb(meter), "u1", REQ,
      { runCapture: runCapture as never, searchFoods: searchFoods(meter) as never });
    expect(meter.peak()).toBeGreaterThanOrEqual(4);
  });

  it("returns the items in the model's order, whatever order the database answered in", async () => {
    const meter = overlapMeter();
    const draft = await proposeDraft(fakeDb(meter), fakeDb(meter), "u1", REQ,
      { runCapture: runCapture as never, searchFoods: searchFoods(meter) as never });
    expect(draft.items.map((i) => i.label)).toEqual(LABELS);
    expect(draft.items.map((i) => i.seq)).toEqual([0, 1, 2, 3, 4]);
  });

  it("runs an item's portions and its ingredients together, not one after the other", async () => {
    const meter = overlapMeter();
    const single = vi.fn(async () => ({
      items: [{ label: "eggs", grams: 100, qty: 2, unit: "whole", confidence: 0.8 }], notes: [] }));
    await proposeDraft(fakeDb(meter), fakeDb(meter), "u1", REQ,
      { runCapture: single as never, searchFoods: searchFoods(meter) as never });
    // One item: the search is alone, then portions + ingredients + the ref work overlap.
    expect(meter.peak()).toBeGreaterThanOrEqual(2);
  });
});

/**
 * Panel round 5, defect 3. `groundItem`'s own header says an item that did not ground comes back
 * `foodRefId: null` — "she picks" — and that is the right answer for an item whose catalog read
 * failed too. It was not: one rejection took the whole propose down with the catalog's raw error,
 * so a statement timeout on one of five foods lost the model call she had already paid for.
 */
describe("when one item cannot be grounded", () => {
  const failingSearch = (meter: ReturnType<typeof overlapMeter>) => {
    const ok = searchFoods(meter);
    return vi.fn(async (client: unknown, args: { q: string }) => {
      if (args.q.includes("avocado")) throw new Error("catalog_search: statement timeout");
      return ok(client, args);
    });
  };

  it("still returns the other four, in model order", async () => {
    const meter = overlapMeter();
    const draft = await proposeDraft(fakeDb(meter), fakeDb(meter), "u1", REQ,
      { runCapture: runCapture as never, searchFoods: failingSearch(meter) as never });
    expect(draft.items.map((i) => i.label)).toEqual(LABELS);
    // The other four reached the catalog and came back with something to pick from; the one whose
    // read failed has nothing at all.
    expect(draft.items.filter((i) => i.alternatives.length > 0)).toHaveLength(4);
  });

  it("hands the failed one back ungrounded rather than raising", async () => {
    const meter = overlapMeter();
    const draft = await proposeDraft(fakeDb(meter), fakeDb(meter), "u1", REQ,
      { runCapture: runCapture as never, searchFoods: failingSearch(meter) as never });
    const failed = draft.items.find((i) => i.label === "avocado");
    expect(failed).toMatchObject({ foodRefId: null, catalogFoodRevisionId: null, autoResolved: false });
    expect(failed?.alternatives).toEqual([]);
    // No evidence either way is "unverified", never "allowed".
    expect(failed?.policy).toEqual({ verdict: "unverified" });
    expect(failed?.grams).toBe(52);
  });

  it("logs the failure rather than swallowing it", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const meter = overlapMeter();
    await proposeDraft(fakeDb(meter), fakeDb(meter), "u1", REQ,
      { runCapture: runCapture as never, searchFoods: failingSearch(meter) as never });
    expect(errors.mock.calls.flat().join(" ")).toMatch(/grounding/i);
    errors.mockRestore();
  });
});

describe("the response carries the server's own ms", () => {
  it("reports how long the model took and how long grounding took", async () => {
    const meter = overlapMeter();
    const draft = await proposeDraft(fakeDb(meter), fakeDb(meter), "u1", REQ,
      { runCapture: runCapture as never, searchFoods: searchFoods(meter) as never });
    expect(typeof draft.timings?.model).toBe("number");
    expect(typeof draft.timings?.ground).toBe("number");
    expect(draft.timings!.model).toBeGreaterThanOrEqual(0);
    expect(draft.timings!.ground).toBeGreaterThanOrEqual(0);
  });
});
