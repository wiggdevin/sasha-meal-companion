import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposedMeal } from "@/lib/coach/compose";
import type { Intent, IntentResult } from "@/lib/coach/intent";
import { runTurn } from "@/tests/coach/fixtures/run-turn";
import { pilotRecipes } from "@/lib/recipe-catalog/pilot";

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
  systemOne: (p: { state: unknown; questions: unknown; purpose: string }, o?: object) =>
    systemOneMock(p.state, p.questions, { ...o, purpose: p.purpose }),
}));

const THREAD = "3f1b1a2c-0000-4000-8000-0000000000aa";
const MESSAGE = "3f1b1a2c-0000-4000-8000-000000000010";
const REF_ONE = "3f1b1a2c-0000-4000-8000-000000000011";
const REF_TWO = "3f1b1a2c-0000-4000-8000-000000000012";
const NOW = new Date("2026-09-19T16:00:00.000Z").getTime();

type Row = Record<string, unknown>;

function db(tables: Record<string, Row[]> = {}, writes = { rows: [] as { table: string; row: unknown }[] }) {
  const api = (table: string) => {
    const filters: ((row: Row) => boolean)[] = [];
    let limit: number | null = null;
    const rows = () => (tables[table] ?? []).filter((row) => filters.every((pick) => pick(row)))
      .slice(0, limit ?? undefined);
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      eq: (column: string, value: unknown) => {
        filters.push((row) => row[column] === value);
        return chain;
      },
      neq: () => chain,
      lte: () => chain,
      gte: () => chain,
      in: () => chain,
      is: () => chain,
      order: () => chain,
      limit: (value: number) => { limit = value; return chain; },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      single: async () => ({ data: rows()[0] ?? null, error: null }),
      insert: (row: unknown) => { writes.rows.push({ table, row }); return chain; },
      update: (row: unknown) => { writes.rows.push({ table, row }); return chain; },
      then: (resolve: (value: { data: Row[]; error: null }) => unknown) =>
        Promise.resolve({ data: rows(), error: null }).then(resolve),
    });
    return chain;
  };
  return { from: (table: string) => api(table), rpc: async () => ({ data: [], error: null }) } as never;
}

const ports = {
  searchFoods: async () => [{
    foodRefId: REF_ONE,
    name: "Watermelon, raw",
    brand: null,
    kcalPer100g: 30,
    proteinPer100g: 0.6,
    carbsPer100g: 7.6,
    fatPer100g: 0.2,
    prefStatus: null,
  }],
};

/** The assistant row this turn saved (persist inserts the user and assistant rows together). */
function savedAssistant(writes: { rows: { table: string; row: unknown }[] }) {
  return writes.rows.filter((write) => write.table === "coach_messages")
    .flatMap((write) => Array.isArray(write.row) ? write.row : [write.row])
    .map((row) => row as { role?: string; tool_calls?: unknown })
    .findLast((row) => row.role === "assistant");
}

function composedCard(index: number, shortfallNote?: string): ComposedMeal {
  return {
    wish: `Option ${index}`,
    slot: null,
    items: [],
    totals: { kcal: 300, protein: 25, carbs: 30, fat: 9 },
    target: { kcal: 300, protein: 25, carbs: 30, fat: 9 },
    flagged: [],
    fitsTarget: true,
    ...(shortfallNote ? { shortfallNote } : {}),
  };
}

function intentAnswers(
  confidence: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    intent: { type: "choice", choice: "suggest_options", confidence },
    suggest_kind: { type: "choice", choice: "meal", confidence: 0.97 },
    suggest_count: { type: "choice", choice: "3", confidence: 0.97 },
    suggest_slot: { type: "choice", choice: "none", confidence: 0.97 },
    fit_remaining: { type: "noul", noul: 0.05 },
    mentions_specific_foods: { type: "noul", noul: 0.05 },
    mentions_size: { type: "noul", noul: 0.05 },
    ...overrides,
  };
}

function classified<I extends Intent>(
  intent: I,
  args: Extract<IntentResult, { intent: I }>["args"],
  confidence = 0.97,
  argConfidence: Record<string, number> = {},
): Extract<IntentResult, { intent: I }> {
  return { intent, confidence, args, argConfidence, raw: {} as never } as unknown as
    Extract<IntentResult, { intent: I }>;
}

function request(text: string, threadId: string | null = null) {
  return {
    threadId,
    messageId: MESSAGE,
    text,
    now: "2026-09-19T10:00:00-06:00",
    tz: "America/Denver",
  };
}

describe("coach mechanical intent fast path", () => {
  beforeEach(() => {
    vi.stubEnv("COACH_ENABLED", "1");
    vi.stubEnv("TYPESAFE_API_KEY", "");
    sameNameRefIdsMock.mockReset().mockResolvedValue([]);
    systemOneMock.mockReset();
  });

  afterEach(() => vi.unstubAllEnvs());

  it("returns complete shared recipes as a read-only recipe block", async () => {
    const recipe = { ...pilotRecipes()[0], eligibility: { status: "eligible" as const, reasons: [] } };
    const suggest = vi.fn().mockResolvedValue({ candidates: [recipe], noResultReasons: [] });
    const generate = vi.fn(() => { throw new Error("Recipe discovery must stay deterministic"); });
    const writes = { rows: [] as { table: string; row: unknown }[] };
    const result = await runTurn(db({}, writes), db({}, writes), "u1",
      request("find a chicken stew recipe"), { classifyIntent: vi.fn().mockResolvedValue(classified("suggest_options", {
        kind: "recipe", count: 3, fitRemaining: false,
      }, 0.97, { kind: 0.97, count: 0.97, fitRemaining: 0.97 })) as never,
      generate: generate as never, ports: { ...ports, suggest },
      now: () => NOW, newId: () => "id-1" });
    expect(result.composed).toEqual([]);
    expect(result.actions).toEqual([]);
    expect(result.messages.at(-1)?.blocks).toMatchObject([{ kind: "recipe_results",
      recipes: [recipe] }]);
    expect(suggest).toHaveBeenCalledWith("u1", { kind: "recipe", count: 3,
      fitRemaining: false, wish: "find a chicken stew recipe" });
    expect(writes.rows.filter((row) => ["log_entries", "plan_days"].includes(row.table))).toEqual([]);
    expect(generate).not.toHaveBeenCalled();
  });

  it("keeps a mixed recipe search and eaten-food log on the action-capable turn path", async () => {
    const suggest = vi.fn();
    const generate = vi.fn().mockResolvedValue({ kind: "final", text: "I can help with both." });
    const result = await runTurn(db(), db(), "u1",
      request("Find stew ideas and log the soup I ate"), {
        classifyIntent: vi.fn().mockResolvedValue(classified("suggest_options", {
          kind: "recipe", count: 3, fitRemaining: false,
        }, 0.97, { kind: 0.97, count: 0.97, fitRemaining: 0.97 })) as never,
        generate: generate as never, ports: { ...ports, suggest },
        now: () => NOW, newId: () => "id-1",
      });
    expect(result.fastPath).toBeUndefined();
    expect(generate).toHaveBeenCalledOnce();
    expect(suggest).not.toHaveBeenCalled();
  });

  it("returns a grounded 30-minute shift without calling Gemini", async () => {
    const classifyIntent = vi.fn().mockResolvedValue(classified("shift_schedule", {
      minutes: 30, direction: "later", scope: "remaining",
    }));
    const generate = vi.fn(() => { throw new Error("Gemini must not run"); });
    const writes = { rows: [] as { table: string; row: unknown }[] };

    const result = await runTurn(db({}, writes), db({}, writes), "u1",
      request("move my meals 30 minutes later"), {
        classifyIntent: classifyIntent as never,
        generate: generate as never,
        ports,
        now: () => NOW,
        newId: () => "id-1",
      });

    expect(result).toMatchObject({
      fastPath: true,
      intent: "shift_schedule",
      actions: [{ kind: "shift_schedule", date: "2026-09-19", minutes: 30,
        scope: "remaining" }],
      model: { modelId: "" },
      timings: { model: 0 },
    });
    expect(result.messages.at(-1)?.content).toBe(
      "Moving your remaining meals 30 minutes later.");
    expect(generate).not.toHaveBeenCalled();
    expect(writes.rows.filter((write) => write.table === "coach_messages")).toHaveLength(2);
    // C8: Jev's intent read chose this action, so the reply and its card say AI (jev), and the
    // saved row carries it — no column tells a fast path from a structured Plan sheet answer.
    const JEV = { ai: true, source: "jev", purpose: "coach-intent" };
    expect(result.provenance).toEqual(JEV);
    expect(result.messages.at(-1)?.provenance).toEqual(JEV);
    expect(result.messages[0]).not.toHaveProperty("provenance");
    expect(savedAssistant(writes)?.tool_calls).toMatchObject({ provenance: JEV });
  });

  it("keeps the Jev-only fast path when the Gemini attestation is off (Phase 13 §2)", async () => {
    vi.stubEnv("GEMINI_BILLING_ATTESTED", "");
    const classifyIntent = vi.fn().mockResolvedValue(classified("shift_schedule", {
      minutes: 30, direction: "later", scope: "remaining",
    }));
    const generate = vi.fn(() => { throw new Error("Gemini must not run"); });
    const result = await runTurn(db({}), db({}), "u1", request("move my meals 30 minutes later"),
      { classifyIntent: classifyIntent as never, generate: generate as never, ports,
        now: () => NOW, newId: () => "id-1" });
    expect(result).toMatchObject({ fastPath: true, intent: "shift_schedule" });
    expect(generate).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("uses the real runTurn classifier with the live script call shape", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    systemOneMock.mockResolvedValue({
      intent: { choice: "shift_schedule", confidence: 1 },
      direction: { choice: "later", confidence: 1 },
      scope: { choice: "remaining", confidence: 1 },
    });
    const generate = vi.fn(() => { throw new Error("should not be called"); });

    const result = await runTurn(db(), db(), "u1",
      request("move all my meals by 30 minutes"), {
        generate: generate as never,
        now: () => NOW,
        newId: () => "id-1",
      });

    expect(systemOneMock).toHaveBeenCalledOnce();
    expect(generate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      fastPath: true,
      intent: "shift_schedule",
      actions: [{ kind: "shift_schedule", minutes: 30, scope: "remaining" }],
      timings: { model: 0 },
    });
  });

  it("returns five Eats-list suggestions through the tool executor without calling Gemini", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    systemOneMock.mockResolvedValue(intentAnswers(0.97, {
      suggest_count: { type: "choice", choice: "5" },
    }));
    const cards = Array.from({ length: 5 }, (_, index) => ({
      ...composedCard(index + 1), allItemsOnEats: true,
    }));
    const suggest = vi.fn().mockResolvedValue(cards);
    const generate = vi.fn(() => { throw new Error("Gemini must not run"); });
    const writes = { rows: [] as { table: string; row: unknown }[] };

    const result = await runTurn(db({}, writes), db({}, writes), "u1",
      request("make me 5 suggestions from my eats list"), {
        generate: generate as never,
        ports: { ...ports, suggest },
        now: () => NOW,
        newId: () => "id-1",
      });

    expect(result).toMatchObject({
      fastPath: true,
      intent: "suggest_options",
      composed: cards,
      toolsUsed: ["suggest_options"],
      actions: [],
      timings: { model: 0 },
    });
    expect(result.composed).toHaveLength(5);
    expect(result.messages.at(-1)?.content).toBe(
      "Here are 5 meal options from your Favorites.");
    expect(suggest).toHaveBeenCalledWith("u1", {
      kind: "meal", count: 5, fitRemaining: false,
    });
    expect(systemOneMock).toHaveBeenCalledOnce();
    expect(generate).not.toHaveBeenCalled();
    expect(writes.rows.filter((write) => write.table === "coach_messages")).toHaveLength(2);
  });

  it("keeps a Plan-sheet meal request on its named slot even if intent would call it a snack", async () => {
    const classifyIntent = vi.fn().mockResolvedValue(classified("suggest_options", {
      kind: "snack", count: 3, fitRemaining: true,
    }, 0.99, { kind: 0.99, count: 0.99, fitRemaining: 0.99 }));
    const suggest = vi.fn().mockResolvedValue([{ ...composedCard(1), allItemsOnEats: true }]);
    const generate = vi.fn(() => { throw new Error("Plan sheet must not call Gemini"); });
    const writes = { rows: [] as { table: string; row: unknown }[] };
    const result = await runTurn(db({}, writes), db({}, writes), "u1", {
      ...request("Suggest three meal options for Meal 4 (meal-4) on 2026-09-30 that fit my remaining macros."),
      planningSlot: "meal-4", surface: "plan" as const,
    }, { classifyIntent: classifyIntent as never, generate: generate as never,
      ports: { ...ports, suggest }, now: () => NOW, newId: () => "id-1" });

    expect(suggest).toHaveBeenCalledWith("u1", {
      kind: "meal", count: 3, fitRemaining: true, slot: "meal-4",
    });
    expect(result).toMatchObject({ fastPath: true, intent: "suggest_options",
      toolsUsed: ["suggest_options"] });
    expect(result.messages.at(-1)?.content).toContain("meal options");
    expect(result.messages.at(-1)?.content).not.toContain("snack");
    // C8: the Plan sheet's structured request took this path, not Jev: the reply is the app's.
    expect(result.provenance).toEqual({ ai: false, source: "app" });
    expect(result.messages.at(-1)?.provenance).toEqual({ ai: false, source: "app" });
    expect(savedAssistant(writes)?.tool_calls).toMatchObject({ provenance: { ai: false, source: "app" } });
    expect(classifyIntent).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(writes.rows.filter((write) => ["plan_days", "log_entries"].includes(write.table)))
      .toEqual([]);
  });

  it("pins the Plan sheet's slot on a later High protein pick that Jev read without one", async () => {
    const suggest = vi.fn().mockResolvedValue([]);
    await runTurn(db(), db(), "u1", {
      ...request("Suggest three meal options for Meal 2 (meal-2) on 2026-09-19 that fit my remaining macros. Prioritize protein. Do not put a meal in the plan until I choose one."),
      surface: "plan" as const,
    }, { classifyIntent: vi.fn().mockResolvedValue(classified("suggest_options", {
      kind: "meal", count: 3, fitRemaining: false,
    }, 0.97, { kind: 0.97, count: 0.97, fitRemaining: 0.97 })) as never,
    generate: vi.fn(() => { throw new Error("Gemini must not run"); }) as never,
    ports: { ...ports, suggest }, now: () => NOW, newId: () => "id-1" });

    expect(suggest).toHaveBeenCalledWith("u1", {
      kind: "meal", count: 3, fitRemaining: true, slot: "meal-2",
    });
  });

  it("does not give an empty Plan-sheet meal a snack message", async () => {
    const result = await runTurn(db(), db(), "u1", {
      ...request("Suggest three meal options for Meal 4"), planningSlot: "meal-4", surface: "plan" as const,
    }, { classifyIntent: vi.fn(() => { throw new Error("do not classify"); }) as never,
      generate: vi.fn(() => { throw new Error("do not generate"); }) as never,
      ports: { ...ports, suggest: async () => [] }, now: () => NOW, newId: () => "id-1" });

    expect(result.composed).toEqual([]);
    expect(result.messages.at(-1)?.content).toContain("meal option");
    expect(result.messages.at(-1)?.content).not.toContain("snack");
  });

  it.each([
    ["false", false],
    ["unknown", undefined],
  ] as const)("says suggestions are built around Eats foods when Eats membership is %s",
    async (_label, allItemsOnEats) => {
      const cards = [
        { ...composedCard(1), allItemsOnEats: true },
        { ...composedCard(2), allItemsOnEats },
      ];

      const result = await runTurn(db(), db(), "u1", request("suggest two meal options"), {
        classifyIntent: vi.fn().mockResolvedValue(classified("suggest_options", {
          kind: "meal", count: 2, fitRemaining: false,
        }, 0.91, { kind: 0.95, count: 0.95, fitRemaining: 0.95 })) as never,
        generate: vi.fn(() => { throw new Error("Gemini must not run"); }) as never,
        ports: { ...ports, suggest: async () => cards },
        now: () => NOW,
        newId: () => "id-1",
      });

      expect(result.messages.at(-1)?.content).toBe(
        "Here are 2 meal options that fit your day.");
    });

  it("returns an honest retry without Gemini when the suggestion executor fails", async () => {
    const generate = vi.fn(() => { throw new Error("Gemini must not run"); });

    const result = await runTurn(db(), db(), "u1", request("suggest three meal options"), {
      classifyIntent: vi.fn().mockResolvedValue(classified("suggest_options", {
        kind: "meal", count: 3, fitRemaining: false,
      }, 0.91, { kind: 0.95, count: 0.95, fitRemaining: 0.95 })) as never,
      generate: generate as never,
      ports: { ...ports, suggest: async () => { throw new Error("catalog unavailable"); } },
      now: () => NOW,
      newId: () => "id-1",
    });

    expect(result.messages.at(-1)?.content).toBe(
      "I couldn't build those suggestions right now. Please try again.");
    expect(result.model.modelId).toBe("");
    expect(generate).not.toHaveBeenCalled();
  });

  it("keeps a 0.94 mutating classification on the LLM path", async () => {
    const generate = vi.fn().mockResolvedValue({ kind: "final", text: "I can help with that." });

    const result = await runTurn(db(), db(), "u1", request("move my meals 30 minutes later"), {
      classifyIntent: vi.fn().mockResolvedValue(classified("shift_schedule", {
        minutes: 30, direction: "later", scope: "remaining",
      }, 0.94, { minutes: 1, direction: 0.99, scope: 0.99 })) as never,
      generate: generate as never,
      ports,
      now: () => NOW,
      newId: () => "id-1",
    });

    expect(result.fastPath).toBeUndefined();
    expect(generate).toHaveBeenCalledOnce();
  });

  it("keeps a 0.96 mutating classification on the LLM path when one argument is 0.85", async () => {
    const generate = vi.fn().mockResolvedValue({ kind: "final", text: "I can help with that." });

    const result = await runTurn(db(), db(), "u1", request("move my meals 30 minutes later"), {
      classifyIntent: vi.fn().mockResolvedValue(classified("shift_schedule", {
        minutes: 30, direction: "later", scope: "remaining",
      }, 0.96, { minutes: 1, direction: 0.99, scope: 0.85 })) as never,
      generate: generate as never,
      ports,
      now: () => NOW,
      newId: () => "id-1",
    });

    expect(result.fastPath).toBeUndefined();
    expect(generate).toHaveBeenCalledOnce();
  });

  it("returns remaining-macro snack suggestions with the default count", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    systemOneMock.mockResolvedValue(intentAnswers(0.97, {
      suggest_kind: { type: "choice", choice: "snack", confidence: 0.97 },
      fit_remaining: { type: "noul", noul: 0.99 },
    }));
    const cards = Array.from({ length: 3 }, (_, index) => composedCard(index + 1));
    const suggest = vi.fn().mockResolvedValue(cards);
    const generate = vi.fn(() => { throw new Error("Gemini must not run"); });

    const result = await runTurn(db(), db(), "u1",
      request("suggest a snack that fits my remaining macros"), {
        generate: generate as never,
        ports: { ...ports, suggest },
        now: () => NOW,
        newId: () => "id-1",
      });

    expect(result).toMatchObject({
      fastPath: true,
      intent: "suggest_options",
      composed: cards,
      toolsUsed: ["suggest_options"],
    });
    expect(result.messages.at(-1)?.content).toBe(
      "Here are 3 snacks that fit what you have left today.");
    expect(suggest).toHaveBeenCalledWith("u1", {
      kind: "snack", count: 3, fitRemaining: true,
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it("uses the tool shortfall note when fewer suggestions fit", async () => {
    const note = "1 of 5 fit your remaining macros";
    const suggest = vi.fn().mockResolvedValue([composedCard(1, note)]);

    const result = await runTurn(db(), db(), "u1",
      request("make me 5 suggestions from my eats list"), {
        classifyIntent: vi.fn().mockResolvedValue(classified("suggest_options", {
          kind: "meal", count: 5, fitRemaining: false,
        })) as never,
        generate: vi.fn(() => { throw new Error("Gemini must not run"); }) as never,
        ports: { ...ports, suggest },
        now: () => NOW,
        newId: () => "id-1",
      });

    expect(result.messages.at(-1)?.content).toBe(note);
    expect(result.composed).toHaveLength(1);
  });

  it("uses the nothing-left sentence when the suggestion executor returns zero cards", async () => {
    const result = await runTurn(db(), db(), "u1",
      request("suggest a snack that fits my remaining macros"), {
        classifyIntent: vi.fn().mockResolvedValue(classified("suggest_options", {
          kind: "snack", count: 3, fitRemaining: true,
        })) as never,
        generate: vi.fn(() => { throw new Error("Gemini must not run"); }) as never,
        ports: { ...ports, suggest: async () => [] },
        now: () => NOW,
        newId: () => "id-1",
      });

    expect(result.messages.at(-1)?.content).toBe(
      "There are no calories left in today's target for a snack.");
    expect(result.composed).toEqual([]);
  });

  it("falls through to Gemini when the suggestion contains a named-food wish", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    systemOneMock
      .mockResolvedValueOnce(intentAnswers(0.97, {
        fit_remaining: { type: "noul", noul: 0.99 },
        mentions_specific_foods: { type: "noul", noul: 0.99 },
      }))
      .mockResolvedValue(null);
    const generate = vi.fn().mockResolvedValue({ kind: "final", text: "I can build that wrap." });
    const suggest = vi.fn();

    const result = await runTurn(db(), db(), "u1",
      request("a chicken wrap that fits my macros"), {
        generate: generate as never,
        ports: { ...ports, suggest },
        now: () => NOW,
        newId: () => "id-1",
      });

    expect(result.fastPath).toBeUndefined();
    expect(suggest).not.toHaveBeenCalled();
    expect(generate).toHaveBeenCalledOnce();
  });

  it("falls through to Gemini for a low-confidence suggestion intent", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    systemOneMock
      .mockResolvedValueOnce(intentAnswers(0.89, {
        suggest_count: { type: "choice", choice: "5" },
      }))
      .mockResolvedValue(null);
    const generate = vi.fn().mockResolvedValue({ kind: "final", text: "Here are some ideas." });
    const suggest = vi.fn();

    const result = await runTurn(db(), db(), "u1",
      request("make me 5 suggestions from my eats list"), {
        generate: generate as never,
        ports: { ...ports, suggest },
        now: () => NOW,
        newId: () => "id-1",
      });

    expect(result.fastPath).toBeUndefined();
    expect(suggest).not.toHaveBeenCalled();
    expect(generate).toHaveBeenCalledOnce();
  });

  it("falls through on low confidence and injects the hint into the Gemini prompt", async () => {
    const intent = classified("shift_schedule", {
      minutes: 30, direction: "later", scope: "remaining",
    }, 0.61);
    const generate = vi.fn().mockResolvedValue({ kind: "final", text: "Which meals?" });

    const result = await runTurn(db(), db(), "u1", request("move my meals 30 minutes"), {
      classifyIntent: vi.fn().mockResolvedValue(intent) as never,
      generate: generate as never,
      ports,
      now: () => NOW,
      newId: () => "id-1",
    });

    expect(result.fastPath).toBeUndefined();
    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0][0].payload.parts[0].text).toContain(
      "Likely intent: shift_schedule (0.61), minutes=30");
  });

  it("falls through when a schedule shift is missing its amount", async () => {
    const intent = classified("shift_schedule", {
      direction: "later", scope: "remaining", missing: ["minutes"],
    });
    const generate = vi.fn().mockResolvedValue({
      kind: "final", text: "How many minutes later?",
    });

    const result = await runTurn(db(), db(), "u1", request("move my meals later"), {
      classifyIntent: vi.fn().mockResolvedValue(intent) as never,
      generate: generate as never,
      ports,
      now: () => NOW,
      newId: () => "id-1",
    });

    expect(result.fastPath).toBeUndefined();
    expect(result.actions).not.toContainEqual(expect.objectContaining({
      kind: "shift_schedule",
    }));
    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0][0].payload.parts[0].text).toContain(
      "Likely intent: shift_schedule (0.97), direction=later, scope=remaining, missing=minutes");
  });

  it("grounds an add-to-avoid name to both same-name refs", async () => {
    sameNameRefIdsMock.mockResolvedValue([REF_ONE, REF_TWO]);
    const classifyIntent = vi.fn().mockResolvedValue(classified("add_to_avoid", {
      name: "watermelon",
    }));

    const result = await runTurn(db(), db(), "u1", request("add watermelon to my avoid list"), {
      classifyIntent: classifyIntent as never,
      generate: vi.fn(() => { throw new Error("Gemini must not run"); }) as never,
      ports,
      now: () => NOW,
      newId: () => "id-1",
    });

    expect(result.fastPath).toBe(true);
    expect(result.actions[0]).toMatchObject({
      kind: "add_to_avoid",
      foodRefId: REF_ONE,
      alsoFoodRefIds: [REF_TWO],
    });
    expect(classifyIntent).toHaveBeenCalledWith("add watermelon to my avoid list", {
      now: "2026-09-19T16:00:00.000Z",
      userId: "u1",
      foodsMentioned: ["watermelon"],
    });
  });

  it("falls through when a named food does not ground", async () => {
    const generate = vi.fn().mockResolvedValue({ kind: "final", text: "Which food do you mean?" });
    const result = await runTurn(db(), db(), "u1", request("add moon melon to my avoid list"), {
      classifyIntent: vi.fn().mockResolvedValue(classified("add_to_avoid", {
        name: "moon melon",
      })) as never,
      generate: generate as never,
      ports: { searchFoods: async () => [] },
      now: () => NOW,
      newId: () => "id-1",
    });

    expect(result.fastPath).toBeUndefined();
    expect(result.actions).toEqual([]);
    expect(generate).toHaveBeenCalledOnce();
  });

  it("lets Gemini own the exchange after the last assistant turn asked a question", async () => {
    const tables = {
      coach_threads: [{ id: THREAD, user_id: "u1", kind: "chat", summary: null }],
      coach_messages: [
        { id: "old-user", thread_id: THREAD, user_id: "u1", role: "user",
          content: "move my meals", seq: 1, tool_calls: [] },
        { id: "old-assistant", thread_id: THREAD, user_id: "u1", role: "assistant",
          content: "How many minutes later?", seq: 2, tool_calls: [] },
      ],
    };
    const generate = vi.fn().mockResolvedValue({ kind: "final", text: "Which meals do you mean?" });

    const result = await runTurn(db(tables), db(tables), "u1",
      request("30 minutes", THREAD), {
        classifyIntent: vi.fn().mockResolvedValue(classified("shift_schedule", {
          minutes: 30, direction: "later", scope: "remaining",
        })) as never,
        generate: generate as never,
        ports,
        now: () => NOW,
        newId: () => "id-1",
      });

    expect(result.fastPath).toBeUndefined();
    expect(generate).toHaveBeenCalledOnce();
  });

  it("keeps today's LLM path and adds no hint when classification is unavailable", async () => {
    const generate = vi.fn().mockResolvedValue({ kind: "final", text: "Tell me more." });

    await runTurn(db(), db(), "u1", request("help me"), {
      classifyIntent: vi.fn().mockResolvedValue(null) as never,
      generate: generate as never,
      ports,
      now: () => NOW,
      newId: () => "id-1",
    });

    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0][0].payload.parts[0].text).not.toContain("Likely intent:");
  });
});
