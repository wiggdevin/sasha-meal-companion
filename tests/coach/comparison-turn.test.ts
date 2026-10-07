/**
 * The comparison card inside a real coach turn: when the tool loop composed two or more options
 * and no other block claimed the turn's one block slot, the reply carries the code-built "Compare"
 * card (lib/coach/blocks/hydrate-comparison.ts). No model call draws it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runTurn } from "@/tests/coach/fixtures/run-turn";
import type { ComposedMeal } from "@/lib/coach/compose";

const REQ = { threadId: null, messageId: "3f1b1a2c-0000-4000-8000-000000000010",
  text: "compare two dinners" };

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
};

/** Totals the loop fetched, on a card that fails the full meal schema: no food_ideas block. */
const partialCard = (kcal: number) => ({ wish: "dinner", slot: null, items: [],
  totals: { kcal, protein: 30, carbs: 40, fat: 12 } }) as unknown as ComposedMeal;

async function turn() {
  const generate = vi.fn()
    .mockResolvedValueOnce({ kind: "tool", calls: [{
      name: "suggest_options", args: { kind: "meal", count: 2 } }] })
    .mockResolvedValueOnce({ kind: "final", text: "Here are two dinners." });
  const result = await runTurn(db(), db(), "u1", REQ, {
    classifyIntent: vi.fn().mockResolvedValue(null) as never,
    verifyReply: vi.fn().mockResolvedValue({ flagged: false, p: null }) as never,
    generate: generate as never,
    ports: { ...ports, suggest: async () => [partialCard(500), partialCard(640)] },
    now: () => 0,
    newId: () => "id-1",
  });
  return { result, blocks: result.messages[1]?.blocks ?? [] };
}

describe("the comparison card inside a coach turn", () => {
  beforeEach(() => {
    vi.stubEnv("COACH_ENABLED", "1");
    vi.stubEnv("TYPESAFE_API_KEY", "");
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the comparison card from the composed options, with no network call", async () => {
    const { blocks } = await turn();
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "ui", root: { type: "card", title: "Compare" } });
    expect(JSON.stringify(blocks[0])).toContain("500");
    expect(JSON.stringify(blocks[0])).toContain("640");
    expect(fetch).not.toHaveBeenCalled();
  });
});
