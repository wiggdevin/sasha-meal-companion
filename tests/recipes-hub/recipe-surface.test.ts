import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runTurn } from "@/tests/coach/fixtures/run-turn";
import { RECIPE_SURFACE_GUIDANCE, surfaceGuidance } from "@/lib/coach/recipe-surface";
import { coachTurnRequestSchema, threadKindFor } from "@/lib/coach/types";

/** A filtering client double, as in tests/coach/run-turn-draft-context.test.ts. */
function db(tables: Record<string, Record<string, unknown>[]>) {
  const from = (table: string) => {
    const filters: Record<string, unknown> = {};
    let limit = 1000;
    const result = () => ({ data: (tables[table] ?? []).filter((row) => Object.entries(filters)
      .every(([field, value]) => row[field] === value
        || (field === "deleted_at" && value === null && row[field] === undefined))).slice(0, limit),
    error: null });
    const chain = {
      select: () => chain,
      eq: (field: string, value: unknown) => { filters[field] = value; return chain; },
      is: (field: string, value: unknown) => { filters[field] = value; return chain; },
      gte: () => chain, lte: () => chain, order: () => chain, in: () => chain, neq: () => chain,
      limit: (n: number) => { limit = n; return chain; },
      maybeSingle: async () => ({ data: result().data[0] ?? null, error: null }),
      single: async () => ({ data: result().data[0] ?? null, error: null }),
      insert: (row: Record<string, unknown>) => { (tables[table] ??= []).push(row); return chain; },
      update: () => chain,
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve),
    };
    return chain;
  };
  return { from, rpc: async () => ({ data: [], error: null }) } as never;
}

const ports = {
  dayTotals: async () => ({ local_date: "2026-09-20", nutrients: [] }),
  weekTotals: async () => [],
  activeTargets: async () => ({ kcal_train: 2200, protein_g: 135 }),
  latestEstimate: async () => ({ status: "burn_in", tdeeKcal: null }),
  searchFoods: async () => [],
  getConstraints: async () => ({ avoid_allergens: [] }),
  recentGut: async () => [],
  newDraftId: () => "draft-1",
};

const base = { threadId: null, messageId: "3f1b1a2c-0000-4000-8000-000000000041", text: "Any hearty soup?" };

describe("the recipe widget's coach surface", () => {
  it("is a valid surface that may carry a photo's foods but never a plan slot, attachment or history", () => {
    expect(coachTurnRequestSchema.safeParse({ ...base, surface: "recipes" }).success).toBe(true);
    expect(coachTurnRequestSchema.safeParse({ ...base, surface: "recipes",
      planSource: { title: null, ingredients: ["leek", "potato"] } }).success).toBe(true);
    expect(coachTurnRequestSchema.safeParse({ ...base, surface: "recipes", planSlot: "meal-2" }).success).toBe(false);
    expect(coachTurnRequestSchema.safeParse({ ...base, surface: "recipes",
      historySourceThreadId: "3f1b1a2c-0000-4000-8000-000000000042" }).success).toBe(false);
    const attachment = { kind: "barcode", v: 1, gtin14: "00012345678905",
      foodRefId: "3f1b1a2c-0000-4000-8000-000000000043", revisionId: "71", localDate: "2026-09-19",
      slot: "meal-2", scannedAt: "2026-09-19T16:00:00.000Z" };
    expect(coachTurnRequestSchema.safeParse({ ...base, text: "", attachment }).success).toBe(true);
    expect(coachTurnRequestSchema.safeParse({ ...base, text: "", surface: "recipes", attachment }).success)
      .toBe(false);
  });

  it("stores its threads as private plan threads", () => {
    expect(threadKindFor("recipes")).toBe("plan");
    expect(threadKindFor("plan")).toBe("plan");
    expect(threadKindFor(undefined)).toBe("chat");
  });

  it("asks for portions sized from the day, said as estimates, with no allergen safety claim", () => {
    const text = RECIPE_SURFACE_GUIDANCE.join("\n");
    expect(text).toMatch(/remaining calories/);
    expect(text).toMatch(/estimate/);
    expect(text).toMatch(/2 slices/);
    expect(text).toMatch(/Never say a dish is safe for an allergy/);
    expect(text).toMatch(/Emit NO actions/);
    expect(surfaceGuidance(undefined)).toEqual([]);
    expect(surfaceGuidance("plan")).toEqual([]);
  });
});

describe("a recipe-widget turn reaches the model with its guidance", () => {
  beforeEach(() => {
    vi.stubEnv("COACH_ENABLED", "1");
    vi.stubEnv("TYPESAFE_API_KEY", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  async function promptFor(surface: "recipes" | undefined, id: string) {
    const tables: Record<string, Record<string, unknown>[]> = {};
    const generate = vi.fn().mockResolvedValueOnce({ kind: "final", text: "About 1 slice fits." });
    await runTurn(db(tables), db(tables), "u1", {
      threadId: null, messageId: `3f1b1a2c-0000-4000-8000-0000000000${id}`,
      text: "A friend is cooking lasagna, how much can I eat?", ...(surface ? { surface } : {}),
    }, { generate: generate as never, ports, now: () => 0,
      newId: () => `3f1b1a2c-0000-4000-8000-0000000001${id}` });
    expect(generate).toHaveBeenCalledTimes(1);
    const text = (generate.mock.calls[0][0] as { payload: { parts: { text: string }[] } }).payload.parts[0].text;
    return { text, tables };
  }

  it("adds the recipe block before the user's words and keeps the thread private", async () => {
    const { text, tables } = await promptFor("recipes", "51");
    const at = text.indexOf("RECIPE WIDGET");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(text.lastIndexOf("USER: "));
    expect(tables.coach_threads?.[0]).toMatchObject({ kind: "plan" });
  });

  it("leaves an ordinary Coach turn without it", async () => {
    const { text } = await promptFor(undefined, "52");
    expect(text).not.toContain("RECIPE WIDGET");
  });
});

describe("a recipe-widget turn never takes the mutating fast path", () => {
  beforeEach(() => { vi.stubEnv("COACH_ENABLED", "1"); vi.stubEnv("TYPESAFE_API_KEY", ""); });
  afterEach(() => vi.unstubAllEnvs());

  it("sends an action-shaped ask to the model instead of answering with an action", async () => {
    const classifyIntent = vi.fn().mockResolvedValue({ intent: "shift_schedule", confidence: 0.99,
      args: { minutes: 30, direction: "later", scope: "remaining" }, argConfidence: {}, raw: {} });
    const generate = vi.fn().mockResolvedValueOnce({ kind: "final", text: "ok" });
    const tables: Record<string, Record<string, unknown>[]> = {};
    const result = await runTurn(db(tables), db(tables), "u1", {
      threadId: null, messageId: "3f1b1a2c-0000-4000-8000-000000000061", surface: "recipes",
      text: "move my meals 30 minutes later", now: "2026-09-19T10:00:00-06:00", tz: "America/Denver",
    }, { classifyIntent: classifyIntent as never, generate: generate as never, ports, now: () => 0,
      newId: () => "3f1b1a2c-0000-4000-8000-000000000062" });
    expect(result.fastPath).toBeUndefined();
    expect(result.actions).toEqual([]);
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
