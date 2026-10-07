/**
 * Coach latency, round two (2026-09-23). Each case gives every database or port call the same fixed
 * delay, so the elapsed time counts the SEQUENTIAL round trips a path makes. In production one
 * `search_foods` took ~5 s and the turn spent ~9 s before its first model call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { groundActions } from "@/lib/coach/ground";
import type { CoachActionInput } from "@/lib/coach/actions";
import { defaultPorts } from "@/lib/server/coach-ports";
import { runTurn } from "@/tests/coach/fixtures/run-turn";
import { TEST_PROFILE } from "@/tests/helpers/constraint-profile";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const REF = (suffix: string) => `3f1b1a2c-0000-4000-8000-0000000000${suffix}`;

/** A Supabase client whose every request answers after `delay` ms, from per-table rows. */
function slowDb(delay: number, tables: Record<string, unknown[]>, rpcs: Record<string, unknown> = {}) {
  const api = (table: string) => {
    const chain: Record<string, unknown> = {};
    const rows = () => tables[table] ?? [];
    Object.assign(chain, {
      select: () => chain, eq: () => chain, in: () => chain, is: () => chain, gte: () => chain,
      lte: () => chain, lt: () => chain, gt: () => chain, neq: () => chain, not: () => chain,
      or: () => chain, ilike: () => chain, order: () => chain, limit: () => chain,
      range: () => chain, filter: () => chain, match: () => chain,
      insert: () => chain, update: () => chain, upsert: () => chain, delete: () => chain,
      maybeSingle: async () => { await sleep(delay); return { data: rows()[0] ?? null, error: null }; },
      single: async () => { await sleep(delay); return { data: rows()[0] ?? null, error: null }; },
      then: (resolve: (v: { data: unknown[]; error: null }) => unknown,
        reject?: (e: unknown) => unknown) =>
        sleep(delay).then(() => ({ data: rows(), error: null })).then(resolve, reject),
    });
    return chain;
  };
  return {
    from: (table: string) => api(table),
    rpc: async (name: string) => { await sleep(delay); return { data: rpcs[name] ?? null, error: null }; },
  } as never;
}

describe("search_foods round trips", () => {
  it("answers one lookup in four sequential round trips, not six", async () => {
    // This counts round trips by comparing elapsed wall-clock time against a multiple of the fixed
    // per-hop delay. Under the full suite's default parallelism that comparison raced real OS/event-
    // loop scheduling (CPU contention could inflate the real delay enough to blow the margin even
    // with only 4 sequential hops), so the clock is faked and driven deterministically instead.
    // `slowDb`'s own `sleep` (above) is a plain `setTimeout` wrapper, which `vi.useFakeTimers()`
    // controls directly — nothing here reaches `node:timers/promises`, which it would not fake.
    // With the clock faked, 4 sequential D-ms hops advance it by exactly 4*D and nothing more, so
    // the bound is exact (not just an upper margin) — a real regression to 5 or 6 hops fails this
    // outright rather than needing to blow past a loose ceiling.
    try {
      vi.useFakeTimers();
      const D = 60;
      const searchRow = (id: number) => ({
        catalog_food_id: id, revision_id: id * 10, description: `Food ${id}`, brand: null,
        source: "fdc_foundation", quality_class: "A", quality_flags: [], prep_state: null,
        score: 0.9 - id / 100, pref_status: null, category: null, policy_categories: [],
      });
      const detailRow = {
        id: 10, catalog_food_id: 1, description: "Food 1", brand: null, category: null,
        policy_categories: [], prep_state: null, quality_class: "A", quality_flags: [],
        catalog_foods: { source: "fdc_foundation" }, catalog_food_nutrients: [],
        catalog_portions: [], catalog_ingredients: [],
      };
      const db = slowDb(D, {
        catalog_versions: [{ version_label: "fdc-2026-04" }],
        catalog_food_revisions: [detailRow],
      }, {
        catalog_search: [searchRow(1), searchRow(2), searchRow(3)],
        get_or_create_food_ref: REF("21"),
      });
      const ports = defaultPorts(db, db, () => "id-1", { tz: "UTC", date: "2026-09-23" });

      const started = Date.now();
      const resultPromise = ports.searchFoods("u1", "chicken breast", 3);
      await vi.runAllTimersAsync();
      const hits = await resultPromise;
      const elapsed = Date.now() - started;

      expect(hits).toHaveLength(3);
      // Four sequential D-ms hops, exactly — not six (360 ms) and not any looser bound either.
      expect(elapsed).toBe(4 * D);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("groundActions", () => {
  it("grounds independent actions together and keeps their order", async () => {
    const searchFoods = vi.fn(async (_u: string, query: string) => {
      await sleep(100);
      return [{ foodRefId: REF(query === "kale" ? "31" : query === "oats" ? "32" : "33"),
        name: `${query}, raw`, brand: null, catalogFoodRevisionId: 7, kcalPer100g: 30,
        proteinPer100g: 1, carbsPer100g: 5, fatPer100g: 0.2, prefStatus: null }];
    });
    let n = 0;
    const inputs: CoachActionInput[] = [
      { kind: "add_to_eats", name: "kale" },
      { kind: "add_to_avoid", name: "oats" },
      { kind: "add_to_eats", name: "rice" },
    ];

    const started = Date.now();
    const result = await groundActions("u1", inputs, TEST_PROFILE,
      { searchFoods, newActionId: () => `action-${++n}` });
    const elapsed = Date.now() - started;

    // One after another is 300 ms.
    expect(elapsed).toBeLessThan(200);
    expect(result.actions.map((a) => [a.kind, (a as { name: string }).name, a.actionId])).toEqual([
      ["add_to_eats", "kale, raw", "action-1"],
      ["add_to_avoid", "oats, raw", "action-2"],
      ["add_to_eats", "rice, raw", "action-3"],
    ]);
  });
});

describe("groundActions failure order (review r1, FIX 2)", () => {
  it("reports the first failing INPUT, after every input has settled", async () => {
    const settled: string[] = [];
    const searchFoods = vi.fn(async (_u: string, query: string) => {
      await sleep(query === "first" ? 100 : 10);
      settled.push(query);
      throw new Error(query);
    });
    const inputs: CoachActionInput[] = [
      { kind: "add_to_eats", name: "first" },
      { kind: "add_to_eats", name: "second" },
    ];
    await expect(groundActions("u1", inputs, TEST_PROFILE,
      { searchFoods, newActionId: () => "a" })).rejects.toThrow("first");
    expect(settled.sort()).toEqual(["first", "second"]);
  });
});

describe("late work (review r2, FIX 2 and FIX 3)", () => {
  it("mints no food refs once the turn has given up on the lookup", async () => {
    const rpcs: string[] = [];
    const inner = slowDb(0, { catalog_versions: [{ version_label: "v" }] }, {
      catalog_search: [{ catalog_food_id: 1, revision_id: 10, description: "Food 1", brand: null,
        source: "fdc_foundation", quality_class: "A", quality_flags: [], prep_state: null,
        score: 0.9, pref_status: null, category: null, policy_categories: [] }],
    }) as unknown as { from: unknown; rpc: (name: string) => Promise<unknown> };
    const db = { ...inner, rpc: (name: string) => { rpcs.push(name); return inner.rpc(name); } } as never;
    const controller = new AbortController();
    const ports = defaultPorts(db, db, () => "id-1", { tz: "UTC", date: "2026-09-23" },
      { signal: controller.signal });
    controller.abort();
    await expect(ports.searchFoods("u1", "chicken", 3)).rejects.toThrow();
    expect(rpcs).not.toContain("get_or_create_food_ref");
  });

  it("waits for every item search of a meal before reporting its failure", async () => {
    const settled: string[] = [];
    const searchFoods = vi.fn(async (_u: string, query: string) => {
      await sleep(query === "slow" ? 80 : 5);
      settled.push(query);
      throw new Error(query);
    });
    const inputs: CoachActionInput[] = [{ kind: "log_meal", date: "2026-09-23", slot: "meal_1",
      title: "Lunch", items: [{ name: "slow", grams: 100 }, { name: "fast", grams: 100 }] } as never];
    await expect(groundActions("u1", inputs, TEST_PROFILE,
      { searchFoods, newActionId: () => "a" })).rejects.toThrow("slow");
    expect(settled.sort()).toEqual(["fast", "slow"]);
  });
});

describe("runTurn fast path (review r1, FIX 3)", () => {
  beforeEach(() => { vi.stubEnv("COACH_ENABLED", "1"); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("does not read the day context on a fast-path turn", async () => {
    const seen: string[] = [];
    const inner = slowDb(0, {
      constraint_profiles: [{ rev: 1, conditions: [], notes: null, avoid_allergens: [],
        avoid_food_ref_ids: [], banned_categories: [], custom_rules: [] }],
    }) as unknown as { from: (t: string) => unknown; rpc: unknown };
    const db = { ...inner, from: (t: string) => { seen.push(t); return inner.from(t); } } as never;
    const classifyIntent = vi.fn(async () => ({ intent: "log_water", confidence: 0.99,
      args: { ml: 500 }, argConfidence: {} }));
    const res = await runTurn(db, db, "u1",
      { threadId: null, messageId: "3f1b1a2c-0000-4000-8000-0000000000ac", text: "log 500 ml water" },
      { generate: vi.fn() as never, now: () => Date.now(), newId: () => "3f1b1a2c-0000-4000-8000-0000000000ad",
        classifyIntent: classifyIntent as never });
    await sleep(20);
    expect(res.fastPath).toBe(true);
    expect(seen).not.toContain("recipes");
    expect(seen).not.toContain("user_food_prefs");
  });
});

describe("runTurn setup", () => {
  beforeEach(() => { vi.stubEnv("COACH_ENABLED", "1"); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("reaches the first model call in few sequential round trips", async () => {
    const D = 40;
    const threadId = "3f1b1a2c-0000-4000-8000-0000000000aa";
    const db = slowDb(D, {
      coach_threads: [{ id: threadId, user_id: "u1", kind: "chat", summary: null }],
      constraint_profiles: [{ rev: 1, conditions: [], notes: null, avoid_allergens: [],
        avoid_food_ref_ids: [], banned_categories: [], custom_rules: [] }],
    });
    let firstModelAt = 0;
    const generate = vi.fn(async () => {
      firstModelAt ||= Date.now();
      return { kind: "final", text: "Hello." };
    });
    const classifyIntent = vi.fn(async () => { await sleep(D); return null; });

    const started = Date.now();
    await runTurn(db, db, "u1",
      { threadId, messageId: "3f1b1a2c-0000-4000-8000-0000000000ab", text: "hi" },
      { generate: generate as never, now: () => Date.now(), newId: () => "id-1",
        classifyIntent: classifyIntent as never });
    const hops = (firstModelAt - started) / D;

    expect(generate).toHaveBeenCalled();
    // Budget, stored turn, thread, seq, profile, history, intent and context each waited for
    // the one before. Now: one round of reads, then the intent call beside the context reads.
    expect(hops).toBeLessThan(6);
  });
});
