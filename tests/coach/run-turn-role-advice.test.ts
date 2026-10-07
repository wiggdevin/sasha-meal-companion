import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IntentResult } from "@/lib/coach/intent";
import { runTurn } from "@/tests/coach/fixtures/run-turn";

const { sameNameRefIdsMock, systemOneMock } = vi.hoisted(() => ({
  sameNameRefIdsMock: vi.fn(),
  systemOneMock: vi.fn(),
}));

vi.mock("@/lib/server/catalog-names", () => ({ sameNameRefIds: sameNameRefIdsMock }));
vi.mock("@/lib/ai/typesafe", () => ({
  choice: (instructions: string, criteria: Record<string, string>) => ({
    type: "choice", instructions, criteria,
  }),
  noul: (instructions: string) => ({ type: "noul", instructions }),
  systemOne: systemOneMock,
}));

const FOOD_REF = "3f1b1a2c-0000-4000-8000-000000000011";
const MESSAGE_ID = "3f1b1a2c-0000-4000-8000-000000000010";
const NOW = new Date("2026-09-20T16:00:00.000Z").getTime();
type Row = Record<string, unknown>;
type Write = { table: string; operation: "insert" | "update" | "upsert"; row: unknown };

function db(tables: Record<string, Row[]> = {}, writes = { rows: [] as Write[] }) {
  const api = (table: string) => {
    const filters: ((row: Row) => boolean)[] = [];
    const rows = () => (tables[table] ?? []).filter((row) => filters.every((pick) => pick(row)));
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      eq: (column: string, value: unknown) => {
        filters.push((row) => row[column] === value);
        return chain;
      },
      neq: () => chain, lte: () => chain, gte: () => chain, in: () => chain, is: () => chain,
      order: () => chain, limit: () => chain,
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      single: async () => ({ data: rows()[0] ?? null, error: null }),
      insert: (row: unknown) => {
        writes.rows.push({ table, operation: "insert", row }); return chain;
      },
      update: (row: unknown) => {
        writes.rows.push({ table, operation: "update", row }); return chain;
      },
      upsert: (row: unknown) => {
        writes.rows.push({ table, operation: "upsert", row }); return chain;
      },
      then: (resolve: (value: { data: Row[]; error: null }) => unknown) =>
        Promise.resolve({ data: rows(), error: null }).then(resolve),
    });
    return chain;
  };
  return { from: (table: string) => api(table), rpc: async () => ({ data: [], error: null }) } as never;
}

const ports = {
  searchFoods: async () => [{
    foodRefId: FOOD_REF,
    name: "Blue pea crunch",
    brand: null,
    kcalPer100g: 167,
    proteinPer100g: 30,
    carbsPer100g: 5,
    fatPer100g: 3,
    prefStatus: null,
  }],
};

function request(text: string) {
  return { threadId: null, messageId: MESSAGE_ID, text };
}

function listIntent(kind: "add_to_eats" | "add_to_avoid"): IntentResult {
  return {
    intent: kind,
    confidence: 0.99,
    args: { name: "Blue pea crunch" },
    argConfidence: { name: 1 },
    raw: {} as never,
  } as IntentResult;
}

function persistedActions(writes: { rows: Write[] }) {
  const assistant = writes.rows.filter((write) => write.table === "coach_messages").at(-1)?.row;
  return (assistant as { tool_calls: { actions: unknown[] } }).tool_calls.actions;
}

function preferenceWrites(writes: { rows: Write[] }) {
  return writes.rows.filter((write) => write.table === "user_food_prefs");
}

describe("runTurn post-ground role advice", () => {
  beforeEach(() => {
    vi.stubEnv("COACH_ENABLED", "1");
    sameNameRefIdsMock.mockReset().mockResolvedValue([]);
    systemOneMock.mockReset().mockResolvedValue({
      meal_component_role: {
        type: "choice",
        choice: "protein_anchor",
        probabilities: {
          protein_anchor: 1, carb_source: 0, fat_source: 0,
          produce_or_free: 0, mixed_dish: 0, none: 0,
        },
        confidence: 0.94,
      },
    });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("persists confirm-required role advice on the classified fast path", async () => {
    const writes = { rows: [] as Write[] };
    const result = await runTurn(db({}, writes), db({}, writes), "user-1",
      request("add Blue pea crunch to my eats list"), {
        classifyIntent: vi.fn().mockResolvedValue(listIntent("add_to_eats")) as never,
        generate: vi.fn(() => { throw new Error("the fast path must not call Gemini"); }) as never,
        ports,
        now: () => NOW,
        newId: () => "id-1",
      });

    expect(result.fastPath).toBe(true);
    expect(result.actions).toEqual([expect.objectContaining({
      roleAdvice: expect.objectContaining({
        proposedRole: "protein", currentRole: null,
        reason: "The food is chiefly the meal's protein anchor.",
        requiresConfirmation: true,
      }),
    })]);
    expect(persistedActions(writes)).toEqual([expect.objectContaining({
      kind: "add_to_eats",
      roleAdvice: expect.objectContaining({ requiresConfirmation: true }),
    })]);
    expect(preferenceWrites(writes)).toEqual([]);
  });

  it("persists confirm-required role advice on the LLM final path", async () => {
    const writes = { rows: [] as Write[] };
    const result = await runTurn(db({}, writes), db({}, writes), "user-1",
      request("keep Blue pea crunch away"), {
        classifyIntent: vi.fn().mockResolvedValue(null) as never,
        generate: vi.fn().mockResolvedValue({
          kind: "final",
          text: "Adding Blue pea crunch to your Avoid list.",
          actions: [{ kind: "add_to_avoid", name: "Blue pea crunch" }],
        }) as never,
        ports,
        now: () => NOW,
        newId: () => "id-1",
      });

    expect(result.fastPath).toBeUndefined();
    expect(result.actions).toEqual([expect.objectContaining({
      roleAdvice: expect.objectContaining({
        proposedRole: "protein", currentRole: null,
        reason: "The food is chiefly the meal's protein anchor.",
        requiresConfirmation: true,
      }),
    })]);
    expect(persistedActions(writes)).toEqual([expect.objectContaining({
      kind: "add_to_avoid",
      roleAdvice: expect.objectContaining({ requiresConfirmation: true }),
    })]);
    expect(preferenceWrites(writes)).toEqual([]);
  });
});
