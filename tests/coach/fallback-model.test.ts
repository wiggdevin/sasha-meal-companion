import { beforeEach, describe, expect, it, vi } from "vitest";
import { runTurn } from "@/tests/coach/fixtures/run-turn";
import { COACH_FALLBACK_MODEL_ID, COACH_MODEL_ID, GEMINI_FLASH } from "@/lib/ai/models";

const REQ = { threadId: null, messageId: "3f1b1a2c-0000-4000-8000-000000000050",
  text: "what should I eat", now: "2026-09-16T15:00:00.000Z", tz: "America/Denver" };

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

/**
 * These cases are about which MODEL answers, so the classifier is stubbed out:
 * a live classify call would reach the network and, with no target revision on
 * this fixture, take the `needs_profile` fast path before `generate` ever runs.
 */
const noClassify = () => vi.fn().mockResolvedValue(null) as never;

describe("the coach's fallback model", () => {
  beforeEach(() => {
    vi.stubEnv("COACH_ENABLED", "1");
    vi.stubEnv("HEALTH_CONTEXT_PROVIDER", "gemini");
    vi.stubEnv("GEMINI_BILLING_ATTESTED", "1");
  });

  it("names the capture model, which is a different id from the pinned one", () => {
    expect(COACH_FALLBACK_MODEL_ID).toBe(GEMINI_FLASH);
    expect(COACH_FALLBACK_MODEL_ID).not.toBe(COACH_MODEL_ID);
  });

  it("retries the same turn once on the fallback and reports which model answered", async () => {
    const writes = { rows: [] as { table: string; row: unknown }[] };
    const seen: string[] = [];
    const generate = vi.fn(async (args: { route?: { modelId: string } }) => {
      const modelId = args.route?.modelId ?? "";
      seen.push(modelId);
      if (modelId === COACH_MODEL_ID) throw new Error("503 model overloaded");
      return { kind: "final", text: "Have the chicken." };
    }) as never;

    const res = await runTurn(db(writes), db(writes), "u1", REQ,
      { generate, ports, classifyIntent: noClassify(),
        newId: () => "3f1b1a2c-0000-4000-8000-0000000000a1" });

    expect(seen).toEqual([COACH_MODEL_ID, COACH_FALLBACK_MODEL_ID]);
    expect(res.model.modelId).toBe(COACH_FALLBACK_MODEL_ID);
    const assistant = writes.rows.filter((w) => w.table === "coach_messages")
      .map((w) => w.row as { role: string; model_id: string })
      .find((row) => row.role === "assistant");
    expect(assistant?.model_id).toBe(COACH_FALLBACK_MODEL_ID);
  });

  it("does not fall back a second time — a failing fallback is a 503", async () => {
    const writes = { rows: [] as { table: string; row: unknown }[] };
    const seen: string[] = [];
    const generate = vi.fn(async (args: { route?: { modelId: string } }) => {
      seen.push(args.route?.modelId ?? "");
      throw new Error("503 model overloaded");
    }) as never;

    await expect(runTurn(db(writes), db(writes), "u1", REQ,
      { generate, ports, classifyIntent: noClassify() }))
      .rejects.toMatchObject({ status: 503, code: "coach_unavailable" });
    expect(seen).toEqual([COACH_MODEL_ID, COACH_FALLBACK_MODEL_ID]);
  });

  it("stays on the pinned model when it answers", async () => {
    const writes = { rows: [] as { table: string; row: unknown }[] };
    const seen: string[] = [];
    const generate = vi.fn(async (args: { route?: { modelId: string } }) => {
      seen.push(args.route?.modelId ?? "");
      return { kind: "final", text: "Have the chicken." };
    }) as never;
    const res = await runTurn(db(writes), db(writes), "u1", REQ,
      { generate, ports, classifyIntent: noClassify() });
    expect(seen).toEqual([COACH_MODEL_ID]);
    expect(res.model.modelId).toBe(COACH_MODEL_ID);
  });
});
