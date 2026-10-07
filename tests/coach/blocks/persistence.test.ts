import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposedMeal } from "@/lib/coach/compose";
import { uiBlockSchema } from "@/lib/coach/ui-blocks";
import { runTurn } from "@/tests/coach/fixtures/run-turn";

const request = {
  threadId: null,
  messageId: "3f1b1a2c-0000-4000-8000-000000000010",
  text: "What would you ask next?",
  now: "2026-09-19T10:00:00-06:00",
  tz: "America/Denver",
};

type Query = {
  table: string;
  columns: string;
  equals: Record<string, unknown>;
  limit: number | null;
  orders: { column: string; ascending: boolean }[];
};

function database(
  writes: { table: string; row: Record<string, unknown> }[],
  answer: (query: Query) => { data: unknown[]; error: unknown } = () => ({ data: [], error: null }),
  queries: Query[] = [],
) {
  const from = (table: string) => {
    const query: Query = { table, columns: "", equals: {}, limit: null, orders: [] };
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: (columns: string) => { query.columns = columns; return chain; },
      eq: (column: string, value: unknown) => { query.equals[column] = value; return chain; },
      neq: () => chain, lte: () => chain, lt: () => chain,
      in: () => chain, is: () => chain, gte: () => chain,
      order: (column: string, options?: { ascending?: boolean }) => {
        query.orders.push({ column, ascending: options?.ascending ?? true });
        return chain;
      },
      limit: (value: number) => { query.limit = value; return chain; },
      // Consult `answer` so a fixture can supply a single row (a target revision,
      // say) and not only list reads.
      maybeSingle: async () => ({ data: answer(query).data[0] ?? null, error: null }),
      single: async () => ({ data: answer(query).data[0] ?? null, error: null }),
      then: (resolve: (value: { data: unknown[]; error: null }) => unknown) => {
        queries.push({ ...query, equals: { ...query.equals }, orders: [...query.orders] });
        return Promise.resolve(answer(query) as { data: unknown[]; error: null }).then(resolve);
      },
      insert: (row: Record<string, unknown>) => { writes.push({ table, row }); return chain; },
      update: () => chain,
    });
    return chain;
  };
  return { from, rpc: async () => ({ data: [], error: null }) } as never;
}

/** A chart needs a target row: a day with no revision is not plotted (design §5.3). */
const TARGET_PROFILE_ROW = {
  id: "target-1", user_id: "user-1", effective_from: "2026-09-01", rev: 1,
  kcal_train: 2200, kcal_rest: 1800, authored_by: "user", mode: "grams",
  protein_g: 120, fat_g: 80, carb_g: 250,
  protein_pct: null, fat_pct: null, carb_pct: null,
  kcal_min: 1200, protein_g_min: 120, fat_g_min: 50, carb_g_min: 0,
  goal_rate_bp_week: 0, max_weekly_kcal_step: 150, notes: null, target_source: "derived",
  training_macros: { kcal: 2200, protein: 120, carbs: 250, fat: 80 },
  rest_macros: { kcal: 1800, protein: 120, carbs: 150, fat: 80 },
  pin_training_kcal: null, pin_rest_kcal: null, pin_protein_g: null,
  input_weight_kg: 59.25, input_weight_source: "weigh-in", input_training_weekdays: [1, 3, 5],
  input_activity_level: "moderate", input_goal: "recomp", formula_name: "profile-energy-v1",
};

const sample = (value: number, date = "2026-09-19") => ({
  value, unit: "kg", start_time: `${date}T08:00:00.000Z`, end_time: `${date}T08:00:00.000Z`,
  tz: "America/Denver", device_label: null, vendor_sample_id: `sample-${date}`,
  health_sources: { kind: "device" },
});

function loggedEntry(date: string) {
  return {
    id: `entry-${date}`, eaten_at: `${date}T18:00:00.000Z`, slot: "meal-1", note: null,
    log_items: [{
      seq: 0, grams: 100, food_ref_id: `food-${date}`,
      snapshot: {
        energy_kcal_calc: { amount: date === "2026-09-19" ? 1400 : 1250 },
        protein: { amount: 80 }, carbohydrate: { amount: 150 }, fat_total: { amount: 45 },
      },
    }],
  };
}

function foodHit(index: number) {
  return {
    foodRefId: `food-${index}`, catalogFoodRevisionId: index + 1, name: `Food ${index}`,
    brand: null, kcalPer100g: 100 + index, prefStatus: null,
    allergenTags: [], category: [],
  };
}

const composedMeal: ComposedMeal = {
  wish: "chicken rice bowl", slot: "meal-2",
  items: [{
    name: "Chicken breast", foodRefId: "food-chicken", catalogFoodRevisionId: 71,
    grams: 120, kcalPer100g: 165, proteinPer100g: 31, carbsPer100g: 0, fatPer100g: 3.6,
    macros: { kcal: 198, protein: 37.2, carbs: 0, fat: 4.3 }, verdict: "allowed",
  }, {
    name: "Avocado", foodRefId: "food-avocado", catalogFoodRevisionId: 72,
    grams: 50, kcalPer100g: 160, proteinPer100g: 2, carbsPer100g: 8.5, fatPer100g: 14.7,
    macros: { kcal: 80, protein: 1, carbs: 4.3, fat: 7.4 }, verdict: "allowed",
    addedFor: "fat",
  }],
  totals: { kcal: 278, protein: 38.2, carbs: 4.3, fat: 11.7 },
  target: { kcal: 300, protein: 40, carbs: 5, fat: 12 },
  flagged: [], fitsTarget: true,
};

describe("server block persistence", () => {
  beforeEach(() => vi.stubEnv("COACH_ENABLED", "1"));
  afterEach(() => vi.unstubAllEnvs());

  it("validates and persists hydrated blocks on the assistant message", async () => {
    const writes: { table: string; row: Record<string, unknown> }[] = [];
    const client = database(writes);
    const generate = vi.fn()
      .mockResolvedValueOnce({ kind: "tool", calls: [{
        name: "quick_replies", args: { options: ["Show today", "Plan tomorrow"] },
      }] })
      .mockResolvedValueOnce({ kind: "final", text: "Which would help?" });

    const result = await runTurn(client, client, "user-1", request, {
      generate: generate as never,
      logEntryExists: async () => true,
      classifyIntent: vi.fn().mockResolvedValue(null) as never,
      verifyReply: vi.fn().mockResolvedValue({ flagged: false, p: null }) as never,
      newId: (() => { let n = 0; return () => `generated-${++n}`; })(),
    });

    const assistant = writes.filter((write) => write.table === "coach_messages").at(-1)!.row;
    const blocks = (assistant.tool_calls as { blocks: unknown[] }).blocks;
    expect(blocks).toHaveLength(1);
    expect(uiBlockSchema.parse(blocks[0])).toMatchObject({
      kind: "quick_replies", options: ["Show today", "Plan tomorrow"],
    });
    expect(blocks.some((block) => uiBlockSchema.parse(block).kind === "next_action_chip"))
      .toBe(false);
    // Read back, each block says who produced it; the stored block carries no claim of its own.
    expect(result.messages.at(-1)?.blocks).toEqual(blocks.map((block) => ({ ...(block as object),
      provenance: { ai: true, source: "model", purpose: "coach" } })));
    expect(result.provenance).toEqual({ ai: true, source: "model", purpose: "coach" });
    expect(writes.map((write) => write.table)).not.toEqual(expect.arrayContaining([
      "health_samples", "log_entries", "plan_days", "user_food_prefs", "user_settings",
    ]));
  });

  it("returns invalid tool arguments to the model instead of throwing the turn", async () => {
    const writes: { table: string; row: Record<string, unknown> }[] = [];
    const client = database(writes);
    const generate = vi.fn()
      .mockResolvedValueOnce({ kind: "tool", calls: [{
        name: "quick_replies", args: { options: ["Only one"] },
      }] })
      .mockResolvedValueOnce({ kind: "final", text: "Tell me what you prefer." });

    await expect(runTurn(client, client, "user-1", request, {
      generate: generate as never,
      logEntryExists: async () => true,
      classifyIntent: vi.fn().mockResolvedValue(null) as never,
      verifyReply: vi.fn().mockResolvedValue({ flagged: false, p: null }) as never,
      newId: () => "generated-1",
    })).resolves.toMatchObject({ messages: [
      { role: "user" }, { role: "assistant", content: "Tell me what you prefer." },
    ] });
    const assistant = writes.filter((write) => write.table === "coach_messages").at(-1)!.row;
    expect((assistant.tool_calls as { blocks: unknown[] }).blocks).toEqual([]);
    expect(JSON.stringify(assistant.tool_calls)).toContain("invalid_arguments");
  });

  it("hydrates weight history through runTurn without writing the series into the model transcript", async () => {
    const writes: { table: string; row: Record<string, unknown> }[] = [];
    const client = database(writes, ({ table }) => ({
      data: table === "health_samples" ? [sample(57.6, "2026-09-18"), sample(58)] : [],
      error: null,
    }));
    const generate = vi.fn()
      .mockResolvedValueOnce({ kind: "tool", calls: [{
        name: "show_chart", args: { chart: "weight_trend", days: 30 },
      }] })
      .mockResolvedValueOnce({ kind: "final", text: "Here is your weight trend." });

    const result = await runTurn(client, client, "user-1", {
      ...request, text: "Show my weight trend",
    }, {
      generate: generate as never,
      logEntryExists: async () => true,
      classifyIntent: vi.fn().mockResolvedValue(null) as never,
      verifyReply: vi.fn().mockResolvedValue({ flagged: false, p: null }) as never,
      newId: (() => { let n = 0; return () => `generated-${++n}`; })(),
    });

    const transcript = (generate.mock.calls[1][0] as { payload: { parts: { text: string }[] } }).payload.parts[0].text;
    expect(transcript).toContain('"block":"chart"');
    expect(transcript).toContain('"points":2');
    expect(transcript).not.toContain('"series"');
    expect(transcript).not.toMatch(/127(?:\.0|\.9)?/);
    expect(result.messages.at(-1)?.blocks?.[0]).toMatchObject({
      kind: "chart", chart: "weight_trend", series: [{ points: expect.any(Array) }],
    });
    expect(result.messages.at(-1)?.blocks).toHaveLength(1);
    const assistant = writes.filter((write) => write.table === "coach_messages").at(-1)!.row;
    expect(JSON.stringify((assistant.tool_calls as { calls: unknown }).calls)).not.toContain("127");
  });

  it("degrades a hydration failure to a plain reply without persisting an invalid block", async () => {
    const writes: { table: string; row: Record<string, unknown> }[] = [];
    const client = database(writes, ({ table }) => ({
      data: [], error: table === "health_samples" ? { message: "read failed" } : null,
    }));
    const generate = vi.fn()
      .mockResolvedValueOnce({ kind: "tool", calls: [{
        name: "show_chart", args: { chart: "weight_trend", days: 30 },
      }] })
      .mockResolvedValueOnce({ kind: "final", text: "I could not load that chart right now." });

    await expect(runTurn(client, client, "user-1", request, {
      generate: generate as never,
      logEntryExists: async () => true,
      classifyIntent: vi.fn().mockResolvedValue(null) as never,
      verifyReply: vi.fn().mockResolvedValue({ flagged: false, p: null }) as never,
      newId: () => "generated-1",
    })).resolves.toMatchObject({ messages: [
      { role: "user" },
      { role: "assistant", content: "I could not load that chart right now." },
    ] });
    const assistant = writes.filter((write) => write.table === "coach_messages").at(-1)!.row;
    expect((assistant.tool_calls as { blocks: unknown[] }).blocks).toEqual([]);
  });

  it.each([
    [11, true],
    [10, false],
  ] as const)(
    "returns ten of %i food-search hits and reports truncated=%s",
    async (hitCount, truncated) => {
      const writes: { table: string; row: Record<string, unknown> }[] = [];
      const client = database(writes);
      const hits = Array.from({ length: hitCount }, (_, index) => foodHit(index + 1));
      const searchFoods = vi.fn(async (_userId: string, _query: string, limit: number) =>
        hits.slice(0, limit));
      const generate = vi.fn()
        .mockResolvedValueOnce({ kind: "tool", calls: [{
          name: "search_foods", args: { query: "food", intent: "browse", limit: 10 },
        }] })
        .mockResolvedValueOnce({ kind: "final", text: "Here are the matches." });

      await runTurn(client, client, "user-1", request, {
        generate: generate as never,
        logEntryExists: async () => true,
        classifyIntent: vi.fn().mockResolvedValue(null) as never,
        verifyReply: vi.fn().mockResolvedValue({ flagged: false, p: null }) as never,
        ports: { searchFoods },
        newId: (() => { let n = 0; return () => `generated-${++n}`; })(),
      });

      expect(searchFoods).toHaveBeenCalledWith("user-1", "food", 11);
      const assistant = writes.filter((write) => write.table === "coach_messages").at(-1)!.row;
      const block = uiBlockSchema.parse(
        (assistant.tool_calls as { blocks: unknown[] }).blocks[0],
      );
      expect(block).toMatchObject({ kind: "food_search", truncated });
      expect(block.kind === "food_search" ? block.results : []).toHaveLength(10);
      expect((assistant.tool_calls as { blocks: unknown[] }).blocks).toHaveLength(1);
    },
  );

  it("persists named food-idea acknowledgement separately from the full block", async () => {
    const writes: { table: string; row: Record<string, unknown> }[] = [];
    const client = database(writes);
    const generate = vi.fn()
      .mockResolvedValueOnce({ kind: "tool", calls: [{
        name: "compose_meal", args: { wish: "chicken rice bowl", slot: "meal-2" },
      }] })
      .mockResolvedValueOnce({ kind: "final", text: "Here is the meal." });

    await runTurn(client, client, "user-1", request, {
      generate: generate as never,
      logEntryExists: async () => true,
      classifyIntent: vi.fn().mockResolvedValue(null) as never,
      verifyReply: vi.fn().mockResolvedValue({ flagged: false, p: null }) as never,
      ports: { compose: async () => composedMeal },
      newId: (() => { let n = 0; return () => `generated-${++n}`; })(),
    });

    const assistant = writes.filter((write) => write.table === "coach_messages").at(-1)!.row;
    const toolCalls = assistant.tool_calls as {
      calls: { result?: unknown }[];
      blocks: unknown[];
    };
    expect(toolCalls.calls[0].result).toEqual({
      ok: true,
      block: "food_ideas",
      ideas: [{
        wish: "chicken rice bowl",
        slot: "meal-2",
        itemNames: ["Chicken breast", "Avocado"],
        composerAdded: [{ name: "Avocado", for: "fat" }],
        fitsTarget: true,
      }],
    });
    expect(JSON.stringify(toolCalls.calls[0].result))
      .not.toMatch(/"(?:totals|target|kcal)"\s*:/i);
    expect(uiBlockSchema.parse(toolCalls.blocks[0])).toMatchObject({
      kind: "food_ideas",
      ideas: [{
        items: [{ name: "Chicken breast", grams: 120 }, { name: "Avocado", grams: 50 }],
        totals: composedMeal.totals,
        target: composedMeal.target,
      }],
    });
    expect(toolCalls.blocks).toHaveLength(2);
    expect(uiBlockSchema.parse(toolCalls.blocks[1])).toMatchObject({
      kind: "next_action_chip", action: "pick_suggestion",
    });
  });

  it.each([
    ["show my weight trend", "weight_trend"],
    ["how am I doing this week", "kcal_week"],
  ] as const)("fast-paths %s to a hydrated block without calling Gemini", async (text, chart) => {
    const writes: { table: string; row: Record<string, unknown> }[] = [];
    const loggedDates = new Set(["2026-09-10", "2026-09-19"]);
    const client = database(writes, ({ table, columns, equals }) => {
      if (table === "target_profiles") return { data: [TARGET_PROFILE_ROW], error: null };
      if (table === "health_samples") return { data: [sample(58)], error: null };
      if (table === "daily_energy" && columns === "local_date") {
        return { data: [...loggedDates].map((local_date) => ({ local_date })), error: null };
      }
      if (table === "log_entries" && typeof equals.local_date === "string"
          && loggedDates.has(equals.local_date)) {
        return { data: [loggedEntry(equals.local_date)], error: null };
      }
      return { data: [], error: null };
    });
    const generate = vi.fn();
    const classified = {
      intent: "show_chart", confidence: 0.98, args: { chart }, argConfidence: { chart: 1 }, raw: {},
    };

    const result = await runTurn(client, client, "user-1", { ...request, text }, {
      generate: generate as never,
      classifyIntent: vi.fn().mockResolvedValue(classified) as never,
      verifyReply: vi.fn().mockResolvedValue({ flagged: false, p: null }) as never,
      newId: (() => { let n = 0; return () => `generated-${++n}`; })(),
    });

    expect(generate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ fastPath: true, toolsUsed: ["show_chart"] });
    expect(result.messages.at(-1)?.blocks?.[0]).toMatchObject({ kind: "chart", chart });
    if (chart === "kcal_week") {
      expect(result.messages.at(-1)?.blocks?.[0]).toMatchObject({
        days: 2, caption: "Calories over 2 logged days",
      });
      const block = result.messages.at(-1)?.blocks?.[0];
      expect(block?.kind === "chart" ? block.series[0].points.map((point) => point.x) : [])
        .toEqual(["2026-09-10", "2026-09-19"]);
    }
  });

  it("bounds the logged-date query and renders the latest seven of forty logged days", async () => {
    const writes: { table: string; row: Record<string, unknown> }[] = [];
    const queries: Query[] = [];
    const loggedDates = Array.from({ length: 40 }, (_, index) =>
      new Date(Date.parse("2026-09-19T12:00:00.000Z") - index * 86_400_000)
        .toISOString().slice(0, 10));
    const client = database(writes, (query) => {
      if (query.table === "target_profiles") return { data: [TARGET_PROFILE_ROW], error: null };
      if (query.columns === "local_date") {
        return {
          data: loggedDates.slice(0, query.limit ?? loggedDates.length)
            .map((local_date) => ({ local_date })),
          error: null,
        };
      }
      if (query.table === "log_entries" && typeof query.equals.local_date === "string") {
        return { data: [loggedEntry(query.equals.local_date)], error: null };
      }
      return { data: [], error: null };
    }, queries);
    const classified = {
      intent: "show_chart", confidence: 0.98, args: { chart: "kcal_week" },
      argConfidence: { chart: 1 }, raw: {},
    };

    const result = await runTurn(client, client, "user-1", {
      ...request, text: "How am I doing this week?",
    }, {
      generate: vi.fn() as never,
      classifyIntent: vi.fn().mockResolvedValue(classified) as never,
      verifyReply: vi.fn().mockResolvedValue({ flagged: false, p: null }) as never,
      newId: (() => { let n = 0; return () => `generated-${++n}`; })(),
    });

    const dateQueries = queries.filter((query) => query.columns === "local_date");
    expect(dateQueries).toEqual([expect.objectContaining({
      table: "daily_energy",
      equals: { user_id: expect.any(String) },
      limit: 7,
      orders: [{ column: "local_date", ascending: false }],
    })]);
    const block = result.messages.at(-1)?.blocks?.[0];
    expect(block).toMatchObject({ kind: "chart", chart: "kcal_week", days: 7 });
    expect(block?.kind === "chart" ? block.series[0].points : []).toHaveLength(7);
  });
});
