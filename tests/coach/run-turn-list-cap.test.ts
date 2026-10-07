import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runTurn } from "@/tests/coach/fixtures/run-turn";
import { LIST_MARK_CAP_NOTICE, LIST_MARK_CAP_NOTICE_REMOVE } from "@/lib/coach/turn";

const REQ = { threadId: null, messageId: "3f1b1a2c-0000-4000-8000-000000000030", text: "" };

/** The same minimal doubles as tests/coach/run-turn.test.ts: one row per table, every read
 *  resolves to the whole table. */
function db(tables: Record<string, unknown[]>, writes: { rows: { table: string; row: unknown }[] }) {
  const api = (table: string) => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain, eq: () => chain, neq: () => chain, lte: () => chain, in: () => chain,
      is: () => chain, gte: () => chain, ilike: () => chain, order: () => chain, limit: () => chain,
      maybeSingle: async () => ({ data: (tables[table] ?? [])[0] ?? null, error: null }),
      single: async () => ({ data: (tables[table] ?? [])[0] ?? null, error: null }),
      then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve({ data: tables[table] ?? [], error: null }).then(resolve),
      insert: (row: unknown) => { writes.rows.push({ table, row }); return chain; },
      update: (row: unknown) => { writes.rows.push({ table, row }); return chain; },
    });
    return chain;
  };
  return { from: (t: string) => api(t), rpc: async () => ({ data: [], error: null }) } as never;
}

const ports = {
  dayTotals: async () => ({ local_date: "2026-09-20", nutrients: [] }),
  weekTotals: async () => [],
  activeTargets: async () => ({ kcal_train: 2200, protein_g: 135 }),
  latestEstimate: async () => ({ status: "burn_in", tdeeKcal: null }),
  searchFoods: async () => [{ foodRefId: "3f1b1a2c-0000-4000-8000-00000000001a", name: "eggs",
    brand: null, kcalPer100g: 150, prefStatus: null }],
  getConstraints: async () => ({ avoid_allergens: [] }),
  recentGut: async () => [],
  newDraftId: () => "draft-1",
};

/**
 * Evidence 2026-09-20: after a reply listing six items, "let's add all those to my eats list"
 * added only 3 — the final step's `actions` array is schema-capped there (lib/coach/wire.ts) — and
 * said nothing about the rest.
 */
describe("the reply says so when a final step fills the 3-action cap with list marks", () => {
  beforeEach(() => vi.stubEnv("COACH_ENABLED", "1"));
  afterEach(() => vi.unstubAllEnvs());

  it("adds a plain notice after three add_to_eats actions and nothing else", async () => {
    const generate = vi.fn().mockResolvedValueOnce({
      kind: "final", text: "Adding them to your Eats list.", actions: [
        { kind: "add_to_eats", name: "toast" },
        { kind: "add_to_eats", name: "eggs" },
        { kind: "add_to_eats", name: "mushrooms" },
      ],
    });
    const writes = { rows: [] as { table: string; row: unknown }[] };
    const result = await runTurn(db({}, writes), db({}, writes), "u1",
      { ...REQ, text: "let's add all those to my eats list" },
      { generate: generate as never, classifyIntent: vi.fn().mockResolvedValue(null) as never,
        ports, now: () => 0, newId: () => "id-1" });

    expect(result.actions).toHaveLength(3);
    expect(result.messages.at(-1)?.content).toContain(LIST_MARK_CAP_NOTICE);
  });

  /**
   * 2026-10-02 Grok audit: this used to get the exact same "say 'add the rest'" notice as the add
   * case above — nonsensical after three REMOVALS, where the user is taking things off a list.
   */
  it("says \"remove the rest\", not \"add the rest\", after three remove_from_eats actions", async () => {
    const generate = vi.fn().mockResolvedValueOnce({
      kind: "final", text: "Removing them from your Eats list.", actions: [
        { kind: "remove_from_eats", name: "toast" },
        { kind: "remove_from_eats", name: "eggs" },
        { kind: "remove_from_eats", name: "mushrooms" },
      ],
    });
    const writes = { rows: [] as { table: string; row: unknown }[] };
    const result = await runTurn(db({}, writes), db({}, writes), "u1",
      { ...REQ, text: "take all those off my eats list" },
      { generate: generate as never, classifyIntent: vi.fn().mockResolvedValue(null) as never,
        ports, now: () => 0, newId: () => "id-1" });

    expect(result.actions).toHaveLength(3);
    expect(result.messages.at(-1)?.content).toContain(LIST_MARK_CAP_NOTICE_REMOVE);
    expect(result.messages.at(-1)?.content).not.toMatch(/\badd the rest\b/);
  });

  it("says nothing extra when the actions fit inside the cap", async () => {
    const generate = vi.fn().mockResolvedValueOnce({
      kind: "final", text: "Adding them to your Eats list.", actions: [
        { kind: "add_to_eats", name: "toast" },
        { kind: "add_to_eats", name: "eggs" },
      ],
    });
    const writes = { rows: [] as { table: string; row: unknown }[] };
    const result = await runTurn(db({}, writes), db({}, writes), "u1",
      { ...REQ, text: "add toast and eggs to my eats list" },
      { generate: generate as never, classifyIntent: vi.fn().mockResolvedValue(null) as never,
        ports, now: () => 0, newId: () => "id-1" });

    expect(result.actions).toHaveLength(2);
    expect(result.messages.at(-1)?.content).not.toContain(LIST_MARK_CAP_NOTICE);
  });

  it("says nothing extra when three actions are not all repeatable list marks", async () => {
    const generate = vi.fn().mockResolvedValueOnce({
      kind: "final", text: "Logged breakfast and updated your list.", actions: [
        { kind: "add_to_eats", name: "toast" },
        { kind: "add_to_eats", name: "eggs" },
        { kind: "log_meal", date: "2026-09-20", slot: "meal-1",
          items: [{ name: "eggs", grams: 150 }] },
      ],
    });
    const writes = { rows: [] as { table: string; row: unknown }[] };
    const result = await runTurn(db({}, writes), db({}, writes), "u1",
      { ...REQ, text: "add toast and eggs, and log 150g eggs for breakfast" },
      { generate: generate as never, classifyIntent: vi.fn().mockResolvedValue(null) as never,
        ports, now: () => 0, newId: () => "id-1" });

    expect(result.actions).toHaveLength(3);
    expect(result.messages.at(-1)?.content).not.toContain(LIST_MARK_CAP_NOTICE);
  });
});
