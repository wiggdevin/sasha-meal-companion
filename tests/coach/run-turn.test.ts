import { withSpendRpc } from "@/tests/ai/spend-admin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mapCatalogFoodHit } from "@/lib/server/coach";
import { runTurn } from "@/tests/coach/fixtures/run-turn";
import { MEDICAL_DEFLECTION } from "@/lib/coach/deflect";
import { generateStructured } from "@/lib/ai/adapter";
import { DELIMITER_CLOSE, DELIMITER_OPEN } from "@/lib/coach/envelope";
import { abortMessage, TURN_LIMITS } from "@/lib/coach/turn";
import type { FoodDetail, FoodSearchHit } from "@/lib/server/catalog";
import type { ComposedMeal } from "@/lib/coach/compose";
import type { CoachAction } from "@/lib/coach/actions";
import { evaluatePolicy } from "@/lib/policy/constraints";
import { allergenFacts } from "@/lib/coach/policy";

const REQ = { threadId: null, messageId: "3f1b1a2c-0000-4000-8000-000000000010", text: "" };

/** Minimal Supabase doubles: a table-name-keyed recorder with the four chains runTurn uses. */
function db(tables: Record<string, unknown[]>, writes: { rows: { table: string; row: unknown }[] }) {
  const api = (table: string) => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain, eq: () => chain, neq: () => chain, lte: () => chain, in: () => chain, is: () => chain, gte: () => chain,
      order: () => chain, limit: () => chain,
      maybeSingle: async () => ({ data: (tables[table] ?? [])[0] ?? null, error: null }),
      single: async () => ({ data: (tables[table] ?? [])[0] ?? null, error: null }),
      // The real PostgREST builder is thenable; a chained read resolves to the filtered rows.
      then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve({ data: tables[table] ?? [], error: null }).then(resolve),
      insert: (row: unknown) => { writes.rows.push({ table, row }); return chain; },
      update: (row: unknown) => { writes.rows.push({ table, row }); return chain; },
    });
    return chain;
  };
  return withSpendRpc({ from: (t: string) => api(t), rpc: async () => ({ data: [], error: null }) }) as never;
}

const ports = {
  dayTotals: async () => ({ local_date: "2026-09-11", nutrients: [] }),
  weekTotals: async () => [],
  activeTargets: async () => ({ kcal_train: 2200, protein_g: 135 }),
  latestEstimate: async () => ({ status: "burn_in", tdeeKcal: null }),
  searchFoods: async () => [{ foodRefId: "3f1b1a2c-0000-4000-8000-00000000001a", name: "rice",
    brand: null, kcalPer100g: 130, prefStatus: "eats" as const }],
  getConstraints: async () => ({ avoid_allergens: ["gluten", "dairy", "apple"] }),
  recentGut: async () => [],
  newDraftId: () => "draft-1",
};

function composedCard(index: number): ComposedMeal {
  return {
    wish: `option ${index}`,
    slot: null,
    items: [],
    totals: { kcal: 300, protein: 25, carbs: 30, fat: 9 },
    target: { kcal: 300, protein: 25, carbs: 30, fat: 9 },
    flagged: [],
    fitsTarget: true,
    anchorProtein: `Protein ${index}`,
  };
}

/**
 * The search port as lib/server/coach.ts builds it: every hit goes through `mapCatalogFoodHit`,
 * which is where `FoodHit.category` gets the detail's `policyCategories`. Building the double the
 * same way is how this file proves the port carries the category, not just that checkItem can.
 */
function onionPorts() {
  const hit = {
    catalogFoodId: 8, revisionId: 80, description: "Onions, raw", brand: null,
    source: "fdc_sr_legacy", qualityClass: "analytical", qualityFlags: [], prepState: "raw",
    score: 0.9, prefStatus: null, policyCategories: ["onion_garlic"],
    policy: { verdict: "allowed" },
  } as unknown as FoodSearchHit;
  const detail = {
    ...hit, category: "Vegetables and Vegetable Products", policyCategories: ["onion_garlic"],
    catalogVersion: "2026-09", attribution: "USDA", per100g: {},
    kcalPer100g: null, simplePer100g: null, portions: [], servingPortions: [], defaultPortion: null,
    ingredients: [{ seq: 1, name: "onion", allergenTags: [] }],
  } as unknown as FoodDetail;
  return {
    ...ports,
    searchFoods: async () => [
      mapCatalogFoodHit(hit, detail, "3f1b1a2c-0000-4000-8000-0000000000e1"),
    ],
  };
}

describe("mapCatalogFoodHit and the label-completeness flag (§9 R1, finding #1)", () => {
  it("does not let a split label's first fragment read as a complete statement", () => {
    const hit = {
      catalogFoodId: 12, revisionId: 120, description: "Trail mix bar", brand: null,
      source: "fdc_branded", qualityClass: "analytical", qualityFlags: [], prepState: null,
      score: 0.9, prefStatus: null, policyCategories: [],
      policy: { verdict: "allowed" },
    } as unknown as FoodSearchHit;
    const detail = {
      ...hit, category: null, catalogVersion: "2026-09", attribution: "USDA", per100g: {},
      kcalPer100g: null, simplePer100g: null, portions: [], servingPortions: [], defaultPortion: null,
      ingredients: [
        { seq: 1, name: "sugar", allergenTags: [] },
        { seq: 2, name: "wheat flour", allergenTags: [] },
      ],
      // seq 1's own raw_text reads as a complete statement in isolation (three resolved items, a
      // terminator) — but seq 2 carries its OWN raw_text too, so the label was split across rows
      // and this fragment is not the whole printed statement
      // (lib/foods/catalog-ingredients.ts completenessText marks that `verbatim: false`).
      ingredientsText: "Sugar, corn syrup, salt.",
      ingredientsTextIsLabel: false,
      nameOnlyAllergenHints: [],
    } as unknown as FoodDetail;
    const mapped = mapCatalogFoodHit(hit, detail, "3f1b1a2c-0000-4000-8000-0000000000f1");
    expect(mapped.ingredientsTextIsLabel).toBe(false);
    const verdict = evaluatePolicy(
      { avoid_allergens: ["wheat"], avoid_food_ref_ids: [], banned_categories: [] },
      {
        foodRefId: mapped.foodRefId, allergenTags: mapped.allergenTags ?? null,
        ...allergenFacts(mapped), foodName: mapped.name,
        category: mapped.category ?? null, onEatsList: false, onAvoidList: false,
      },
    );
    const wheat = verdict.allergens?.find((f) => f.allergen === "wheat");
    expect(wheat?.text).not.toContain("No wheat listed on the label");
  });
});

/** The same doubles, with a search that returns dairy evidence for the food it matched. */
/**
 * There is no code-level allergen or category floor any more (design §6.1): a
 * policy block exists only because the ACCOUNT recorded the restriction. Tests
 * that expect a refusal therefore supply the row that carries it.
 */
const RESTRICTED = {
  constraint_profiles: [{
    rev: 1, conditions: [], notes: null,
    avoid_allergens: ["gluten", "dairy", "apple"], avoid_food_ref_ids: [],
    banned_categories: ["onion_garlic", "simple_sugars"], custom_rules: [],
  }],
};

function cheesePorts() {
  return { ...ports, searchFoods: async () => [{
    foodRefId: "3f1b1a2c-0000-4000-8000-0000000000c1", name: "cheese", brand: null,
    kcalPer100g: null, prefStatus: null, allergenTags: ["dairy"], category: null }] };
}

function policyChecks(writes: { rows: { table: string; row: Record<string, unknown> }[] }) {
  return writes.rows.filter((w) => w.table === "coach_messages").at(-1)!
    .row.policy_checks as { verdict: string; reason: string | null }[];
}

describe("runTurn", () => {
  beforeEach(() => {
    vi.stubEnv("COACH_ENABLED", "1");
    vi.stubEnv("TYPESAFE_API_KEY", "");
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("does not create an empty thread on provider failure and can retry the same message", async () => {
    const writes = { rows: [] as { table: string; row: unknown }[] };
    const client = db({}, writes);
    // "unavailable" IS a capacity answer, so the turn tries the fallback model before giving up:
    // two rejections are what make this turn fail (T6 §5).
    const generate = vi.fn().mockRejectedValueOnce(new Error("provider unavailable"))
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValueOnce({ kind: "final", text: "Try rice." });
    const req = { ...REQ, text: "what should I eat" };
    const deps = { generate: generate as never, ports, now: () => 0, newId: () => "id-1" };
    await expect(runTurn(client, client, "u1", req, deps))
      .rejects.toMatchObject({ status: 503, code: "coach_unavailable" });
    expect(writes.rows.filter((write) => write.table !== "coach_intent_events")).toEqual([]);
    expect(writes.rows.filter((write) => write.table === "coach_intent_events")).toHaveLength(1);
    const result = await runTurn(client, client, "u1", req, deps);
    expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(writes.rows.filter((w) => w.table === "coach_threads"
      && "id" in (w.row as object))).toHaveLength(1);
    expect(writes.rows.filter((w) => w.table === "coach_messages")).toHaveLength(2);
  });

  it("says how long an open circuit can take instead of promising a minute", async () => {
    // The breaker reads a ten-minute window, so "Try again in a minute" was untrue (2026-10-01).
    const client = db({}, { rows: [] });
    const open = new Error("circuit open for google: 5 failures in the last 10 minutes");
    const generate = vi.fn().mockRejectedValue(open);
    const failure = await runTurn(client, client, "u1", { ...REQ, text: "what should I eat" },
      { generate: generate as never, ports, now: () => 0, newId: () => "id-1" }).catch((e: unknown) => e);
    expect(failure).toMatchObject({ status: 503, code: "coach_unavailable" });
    expect((failure as Error).message).not.toMatch(/a minute/);
    expect((failure as Error).message).toMatch(/few minutes/);
  });

  it("does not write to an existing thread when its next reply fails", async () => {
    const writes = { rows: [] as { table: string; row: unknown }[] };
    const client = db({ coach_threads: [{ id: "existing", kind: "chat" }] }, writes);
    await expect(runTurn(client, client, "u1",
      { ...REQ, threadId: "existing", text: "what should I eat" },
      { generate: vi.fn().mockRejectedValue(new Error("provider unavailable")) as never, ports }))
      .rejects.toMatchObject({ status: 503, code: "coach_unavailable" });
    expect(writes.rows.filter((write) => write.table !== "coach_intent_events")).toEqual([]);
    expect(writes.rows.filter((write) => write.table === "coach_intent_events")).toHaveLength(1);
  });

  it("returns the fixed deflection with zero model calls for a medical question", async () => {
    const generate = vi.fn();
    const writes = { rows: [] };
    const res = await runTurn(db({}, writes), db({}, writes), "u1",
      { ...REQ, text: "is my colitis getting worse" },
      { generate: generate as never, ports, now: () => 0, newId: () => "id-1" });
    expect(generate).not.toHaveBeenCalled();
    expect(res.deflected).toBe(true);
    expect(res.messages.at(-1)!.content).toBe(MEDICAL_DEFLECTION);
    expect(res.model.modelId).toBe("");
    // C8: the fixed deflection is the app's own copy; no AI wrote it.
    expect(res.provenance).toEqual({ ai: false, source: "app" });
    expect(res.messages.at(-1)!.provenance).toEqual({ ai: false, source: "app" });
  });

  it("tells the coach the account's local date, not the server process's UTC one", async () => {
    const generate = vi.fn().mockResolvedValueOnce({ kind: "final", text: "eat rice" });
    const writes = { rows: [] as { table: string; row: unknown }[] };
    vi.stubEnv("TZ", "UTC");
    // A Vercel Node function runs with TZ=UTC. At this instant it is already tomorrow in UTC
    // (01:00), but still tonight — Saturday the 12th — in America/New_York (21:00 the 12th).
    // The zone comes from the request: the server default is now neutral UTC (design §6.4).
    const nowMs = new Date("2026-09-13T01:00:00.000Z").getTime();
    await runTurn(db({}, writes), db({}, writes), "u1",
      { ...REQ, text: "what should I eat", tz: "America/New_York" },
      { generate: generate as never, ports, now: () => nowMs, newId: () => "id-1" });
    const promptText = (generate.mock.calls[0][0] as { payload: { parts: { text: string }[] } }).payload.parts[0].text;
    expect(promptText).toContain("Today is 2026-09-12 (your local date).");
  });

  it("loops tool then final, and reports only registry tools in toolsUsed", async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce({ kind: "tool", calls: [{ name: "get_day", args: { date: "2026-09-11" } }] })
      .mockResolvedValueOnce({ kind: "tool", calls: [{ name: "set_targets", args: {} }] })
      .mockResolvedValueOnce({ kind: "final", text: "eat rice", suggestions: [{ name: "rice", grams: 150 }] });
    const writes = { rows: [] as { table: string; row: unknown }[] };
    const res = await runTurn(db({}, writes), db({}, writes), "u1",
      { ...REQ, text: "what should I eat" },
      { generate: generate as never, ports, now: () => 0, newId: () => "id-1" });
    expect(res.toolsUsed).toEqual(["get_day"]);
    expect(res.suggestions.map((s) => s.name)).toEqual(["rice"]);
    expect(writes.rows.filter((w) => w.table === "coach_messages")).toHaveLength(2);
  });

  it("returns grounded actions and writes no log or plan rows", async () => {
    const generate = vi.fn().mockResolvedValueOnce({
      kind: "final", text: "I logged breakfast.", actions: [{
        kind: "log_meal", date: "2026-09-16", slot: "meal-1",
        items: [{ name: "rice", grams: 150 }],
      }],
    });
    const writes = { rows: [] as { table: string; row: unknown }[] };
    const res = await runTurn(db({}, writes), db({}, writes), "u1",
      { ...REQ, text: "I ate 150 grams of rice for breakfast" },
      { generate: generate as never, ports, now: () => 0,
        newId: () => "3f1b1a2c-0000-4000-8000-0000000000d1" });

    expect(res.actions).toHaveLength(1);
    // This fake db has no facet/evidence tables, so the suggestion-evidence read answers
    // "unavailable" and the owner's 2026-10-02 fail-safe ruling marks the item unverified rather
    // than allowed — it cannot be proven that this food clears every rule it was never checked
    // against.
    expect(res.actions[0]).toMatchObject({
      kind: "log_meal", flagged: [],
      items: [{ name: "rice", grams: 150,
        foodRefId: "3f1b1a2c-0000-4000-8000-00000000001a", verdict: "unverified" }],
    });
    const assistant = writes.rows.filter((row) => row.table === "coach_messages").at(-1)!
      .row as { tool_calls: { calls: unknown[]; actions: unknown[] } };
    expect(assistant.tool_calls.actions).toEqual(res.actions);
    expect(writes.rows.filter((row) =>
      row.table === "log_entries" || row.table === "plan_days")).toEqual([]);
    // C8: a model turn wrote the reply and the action card beside it.
    const MODEL = { ai: true, source: "model", purpose: "coach" };
    expect(res.provenance).toEqual(MODEL);
    expect(res.messages.at(-1)!.provenance).toEqual(MODEL);
    expect(res.messages.at(-1)!.actions).toEqual(res.actions);
    expect(assistant.tool_calls).toMatchObject({ provenance: MODEL });
  });

  it("persists deterministic sanity before an async write-back can run", async () => {
    const generate = vi.fn().mockResolvedValueOnce({
      kind: "final", text: "Logging breakfast.", actions: [{
        kind: "log_meal", date: "2026-09-16", slot: "meal-1",
        items: [{ name: "rice", grams: 150 }],
      }],
    });
    const writes = { rows: [] as { table: string; row: unknown }[] };
    const sanity = vi.fn((_client: unknown, _userId: string, _messageId: string, value: unknown) => {
      const toolCalls = value as { actions: CoachAction[] };
      return {
        toolCalls,
        actions: toolCalls.actions,
        settled: new Promise<typeof toolCalls>(() => undefined),
      };
    });

    await runTurn(db({}, writes), db({}, writes), "u1",
      { ...REQ, text: "I ate 150 grams of rice for breakfast" },
      { generate: generate as never, ports, sanity: sanity as never, now: () => 0,
        newId: () => "3f1b1a2c-0000-4000-8000-0000000000d1" });

    const assistant = writes.rows.filter((row) => row.table === "coach_messages").at(-1)!
      .row as { tool_calls: { actions: CoachAction[] } };
    expect(assistant.tool_calls.actions[0]).toMatchObject({
      kind: "log_meal", items: [{ sanity: { status: "pending", warnings: [] } }],
    });
  });

  it("keeps a grounded action even when Jev would flag the matching reply", async () => {
    const generate = vi.fn().mockResolvedValue({
      kind: "final", text: "Logged your lunch", actions: [{
        kind: "log_meal", date: "2026-09-16", slot: "meal-2",
        items: [{ name: "rice", grams: 150 }],
      }],
    });
    const verifyReply = vi.fn().mockResolvedValue({ flagged: true, p: 0.95 });

    const result = await runTurn(db({}, { rows: [] }), db({}, { rows: [] }), "u1",
      { ...REQ, text: "I ate 150 grams of rice for lunch" },
      { generate: generate as never, verifyReply: verifyReply as never, ports,
        now: () => new Date("2026-09-16T18:00:00.000Z").getTime(),
        newId: () => "3f1b1a2c-0000-4000-8000-0000000000d1" });

    // Same fail-safe ruling as above: this fake db's suggestion-evidence read is unavailable, so
    // the log policy appends its own "could not be checked" notice to the reply.
    expect(result.messages.at(-1)?.content).toBe(
      "Logged your lunch Not verified: rice (your food rules could not be checked).");
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({ kind: "log_meal", slot: "meal-2" });
    expect(generate).toHaveBeenCalledOnce();
    expect(verifyReply).not.toHaveBeenCalled();
  });

  it("retries one action claim with no actions and returns the retry's grounded action", async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce({ kind: "final", text: "Logged 150g rice for meal 1." })
      .mockResolvedValueOnce({
        kind: "final", text: "Logged 150g rice for meal 1.", actions: [{
          kind: "log_meal", date: "2026-09-16", slot: "meal-1",
          items: [{ name: "rice", grams: 150 }],
        }],
      });
    const result = await runTurn(db({}, { rows: [] }), db({}, { rows: [] }), "u1",
      { ...REQ, text: "I ate 150 grams of rice for breakfast" },
      { generate: generate as never, ports,
        now: () => new Date("2026-09-16T18:00:00.000Z").getTime(), newId: () => "id-1" });

    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({ kind: "log_meal", slot: "meal-1" });
    const retryPrompt = generate.mock.calls[1][0].payload.parts[0].text as string;
    const correctiveMessage = retryPrompt.slice(retryPrompt.lastIndexOf("\n\n") + 2);
    expect(correctiveMessage).toContain(
      "Your reply claimed an action but `actions` was empty");
    expect(correctiveMessage).toContain("reply again with the same final and the action in `actions`");
    expect(correctiveMessage).not.toContain(DELIMITER_OPEN);
    expect(correctiveMessage).not.toContain(DELIMITER_CLOSE);
  });

  it.each(["wall_clock", "max_tool_calls"])(
    "keeps the %s abort after requesting a claim correction", async (reason) => {
      const generate = vi.fn()
        .mockResolvedValueOnce({ kind: "final", text: "Logged 150g rice for meal 1." })
        .mockResolvedValueOnce({ kind: "abort", reason });
      const writes = { rows: [] as { table: string; row: Record<string, unknown> }[] };
      const result = await runTurn(db({}, writes), db({}, writes), "u1",
        { ...REQ, text: "I ate 150 grams of rice for breakfast" },
        { generate: generate as never, ports, now: () => 0, newId: () => "id-1" });

      expect(result.messages.at(-1)?.content).toBe(abortMessage(reason));
      const assistant = writes.rows.filter((row) => row.table === "coach_messages").at(-1)!.row;
      expect(assistant.policy_checks).not.toContainEqual({
        verdict: "blocked", reason: "claim_without_action",
      });
    },
  );

  it("uses grounding clarifications from the corrective retry without a claim policy flag", async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce({ kind: "final", text: "Logged 150g unicorn egg for meal 1." })
      .mockResolvedValueOnce({
        kind: "final", text: "Logged 150g unicorn egg for meal 1.", actions: [{
          kind: "log_meal", date: "2026-09-16", slot: "meal-1",
          items: [{ name: "unicorn egg", grams: 150 }],
        }],
      });
    const writes = { rows: [] as { table: string; row: Record<string, unknown> }[] };
    const result = await runTurn(db({}, writes), db({}, writes), "u1",
      { ...REQ, text: "I ate a 150 gram unicorn egg for breakfast" },
      { generate: generate as never, ports: { ...ports, searchFoods: async () => [] },
        now: () => 0, newId: () => "id-1" });

    expect(result.actions).toEqual([]);
    expect(result.messages.at(-1)?.content).toBe(
      'I could not find "unicorn egg" — what should I log it as?');
    const assistant = writes.rows.filter((row) => row.table === "coach_messages").at(-1)!.row;
    expect(assistant.policy_checks).not.toContainEqual({
      verdict: "blocked", reason: "claim_without_action",
    });
  });

  it("keeps a non-claiming final from the corrective retry without a claim policy flag", async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce({ kind: "final", text: "Logged breakfast." })
      .mockResolvedValueOnce({ kind: "final", text: "How much rice did you eat?" });
    const writes = { rows: [] as { table: string; row: Record<string, unknown> }[] };
    const result = await runTurn(db({}, writes), db({}, writes), "u1",
      { ...REQ, text: "I ate rice for breakfast" },
      { generate: generate as never, ports, now: () => 0, newId: () => "id-1" });

    expect(result.messages.at(-1)?.content).toBe("How much rice did you eat?");
    const assistant = writes.rows.filter((row) => row.table === "coach_messages").at(-1)!.row;
    expect(assistant.policy_checks).not.toContainEqual({
      verdict: "blocked", reason: "claim_without_action",
    });
  });

  it("replaces a repeated empty action claim and records the policy check", async () => {
    const generate = vi.fn().mockResolvedValue({
      kind: "final", text: "Logged 150g rice for meal 1.",
    });
    const writes = { rows: [] as { table: string; row: Record<string, unknown> }[] };
    const result = await runTurn(db({}, writes), db({}, writes), "u1",
      { ...REQ, text: "I ate 150 grams of rice for breakfast" },
      { generate: generate as never, ports, now: () => 0, newId: () => "id-1" });

    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.actions).toEqual([]);
    expect(result.messages.at(-1)?.content).toBe(
      "I have not logged that yet. Tell me the amounts once more and I will.");
    const assistant = writes.rows.filter((row) => row.table === "coach_messages").at(-1)!.row;
    expect(assistant.policy_checks).toContainEqual({
      verdict: "blocked", reason: "claim_without_action",
    });
  });

  it("does not retry a plain final answer with no action claim", async () => {
    const generate = vi.fn().mockResolvedValue({
      kind: "final", text: "Your meal 1 target is ready.",
    });
    const result = await runTurn(db({}, { rows: [] }), db({}, { rows: [] }), "u1",
      { ...REQ, text: "What is my meal 1 target?" },
      { generate: generate as never, ports, now: () => 0, newId: () => "id-1" });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.messages.at(-1)?.content).toBe("Your meal 1 target is ready.");
  });

  it("grounds a live catalog-shaped hit with its revision and per-100 g macros", async () => {
    const hit = {
      catalogFoodId: 7, revisionId: 70, description: "Chicken breast", brand: null,
      source: "fdc_sr_legacy", qualityClass: "analytical", qualityFlags: [], prepState: "cooked",
      score: 0.95, prefStatus: "eats", policyCategories: [], policy: { verdict: "allowed" },
      kcalPer100g: 165, per100g: { kcal: 165, protein: 31, carbs: 0, fat: 3.6 },
      portions: [{ id: null, label: "100 g", grams: 100, kcal: 165 }], defaultPortion: null,
    } as FoodSearchHit;
    const detail = {
      ...hit, category: "poultry", catalogVersion: "2026-09", attribution: "USDA",
      per100g: {
        energy_kcal: { amount: 165, unit: "kcal" }, protein: { amount: 31, unit: "g" },
        carbohydrate: { amount: 0, unit: "g" }, fat_total: { amount: 3.6, unit: "g" },
      },
      kcalPer100g: 165, simplePer100g: { kcal: 165, protein: 31, carbs: 0, fat: 3.6 },
      portions: [], servingPortions: [{ id: null, label: "100 g", grams: 100, kcal: 165 }],
      defaultPortion: null,
      ingredients: [], ingredientsText: null, ingredientsTextIsLabel: true,
      nameOnlyAllergenHints: [],
    } as FoodDetail;
    const generate = vi.fn(async () => ({
      kind: "final", text: "Logged breakfast: chicken.", actions: [{
        kind: "log_meal", date: "2026-09-16", slot: "meal-1",
        items: [{ name: "chicken", grams: 170 }],
      }],
    }));
    const result = await runTurn(db({}, { rows: [] }), db({}, { rows: [] }), "u1",
      { ...REQ, text: "I ate 170 grams of chicken" }, {
        generate: generate as never, now: () => new Date("2026-09-16T18:00:00Z").getTime(),
        newId: () => "3f1b1a2c-0000-4000-8000-0000000000d3",
        ports: { ...ports, searchFoods: async () => [mapCatalogFoodHit(
          hit, detail, "3f1b1a2c-0000-4000-8000-00000000001b")],
        },
      });

    expect(result.actions[0]).toMatchObject({
      kind: "log_meal",
      items: [{ catalogFoodRevisionId: 70, kcalPer100g: 165, proteinPer100g: 31,
        carbsPer100g: 0, fatPer100g: 3.6 }],
    });
  });

  it("replaces a dropped action confirmation with its clarification", async () => {
    const generate = vi.fn().mockResolvedValueOnce({
      kind: "final", text: "Logged breakfast: unicorn egg.", actions: [{
        kind: "log_meal", date: "2026-09-16", slot: "meal-1",
        items: [{ name: "unicorn egg", grams: 150 }],
      }],
    });
    const res = await runTurn(db({}, { rows: [] }), db({}, { rows: [] }), "u1",
      { ...REQ, text: "I ate a 150 gram unicorn egg" },
      { generate: generate as never, ports: { ...ports, searchFoods: async () => [] },
        now: () => 0, newId: () => "3f1b1a2c-0000-4000-8000-0000000000d2" });

    expect(res.actions).toEqual([]);
    expect(res.messages.at(-1)?.content).toBe(
      'I could not find "unicorn egg" — what should I log it as?');
    expect(res.messages.at(-1)?.content).not.toContain("Logged breakfast");
  });

  it("keeps the model's question when a dropped action already asked for clarification", async () => {
    const generate = vi.fn().mockResolvedValueOnce({
      kind: "final", text: "What should I log the unicorn egg as?", actions: [{
        kind: "log_meal", date: "2026-09-16", slot: "meal-1",
        items: [{ name: "unicorn egg", grams: 150 }],
      }],
    });
    const result = await runTurn(db({}, { rows: [] }), db({}, { rows: [] }), "u1",
      { ...REQ, text: "I ate a 150 gram unicorn egg" },
      { generate: generate as never, ports: { ...ports, searchFoods: async () => [] },
        now: () => 0, newId: () => "3f1b1a2c-0000-4000-8000-0000000000d4" });

    expect(result.actions).toEqual([]);
    expect(result.messages.at(-1)?.content).toBe("What should I log the unicorn egg as?");
  });

  it("keeps the grounded half of a mixed batch and asks about the dropped half", async () => {
    const generate = vi.fn(async () => ({
      kind: "final", text: "Logged both meals.", actions: [
        { kind: "log_meal", date: "2026-09-16", slot: "meal-1",
          items: [{ name: "rice", grams: 150 }] },
        { kind: "log_meal", date: "2026-09-16", slot: "meal-2",
          items: [{ name: "unicorn egg", grams: 100 }] },
      ],
    }));
    const result = await runTurn(db({}, { rows: [] }), db({}, { rows: [] }), "u1",
      { ...REQ, text: "I ate both" }, { generate: generate as never,
        ports: { ...ports, searchFoods: async (_userId, name) => name === "rice"
          ? ports.searchFoods() : [] }, now: () => 0, newId: () => "id-1" });
    expect(result.actions).toHaveLength(1);
    expect(result.messages.at(-1)?.content).toContain("I have the other item ready.");
    expect(result.messages.at(-1)?.content).toContain('I could not find "unicorn egg"');
    expect(result.messages.at(-1)?.content).not.toContain("Logged both meals");
  });

  it("refuses a plan write that carries a blocked food, instead of applying it marked off-plan", async () => {
    // GPT-6 Sol audit B1 (2026-10-04): a plan never holds a food the account's rules block.
    const generate = vi.fn().mockResolvedValueOnce({
      kind: "final", text: "Meal 2 is now cheese and rice.", actions: [{
        kind: "set_slot_meal", date: "2026-09-16", slot: "meal-2", title: "Cheese and rice",
        items: [{ name: "cheese", grams: 30 }, { name: "rice", grams: 100 }],
      }],
    });
    const writes = { rows: [] as { table: string; row: Record<string, unknown> }[] };
    const result = await runTurn(db(RESTRICTED, writes), db(RESTRICTED, writes), "u1",
      { ...REQ, text: "make meal 2 cheese and rice" }, {
        generate: generate as never,
        classifyIntent: vi.fn().mockResolvedValue(null) as never,
        verifyReply: vi.fn().mockResolvedValue({ flagged: false, p: null }) as never,
        ports: {
          ...ports,
          searchFoods: async (_userId, name) => name === "cheese" ? [{
            foodRefId: "3f1b1a2c-0000-4000-8000-0000000000c1", name: "cheese",
            brand: null, kcalPer100g: 400, proteinPer100g: 20, carbsPer100g: 2,
            fatPer100g: 33, prefStatus: null, allergenTags: ["dairy"], category: [],
          }] : [{
            foodRefId: "3f1b1a2c-0000-4000-8000-0000000000e1", name: "rice",
            brand: null, kcalPer100g: 130, proteinPer100g: 2.7, carbsPer100g: 28,
            fatPer100g: 0.3, prefStatus: "eats" as const,
          }],
        },
        now: () => 0,
        newId: () => "id-1",
      });
    expect(result.actions).toEqual([]);
    expect(result.messages.at(-1)?.content).toContain("I didn't put cheese in your plan");
  });

  it("returns and persists all-refused recipe copy even when the final ends in a question", async () => {
    const generate = vi.fn().mockResolvedValueOnce({
      kind: "final", text: "Save this as Dinner?", actions: [{
        kind: "save_recipe", name: "Dinner", items: [
          { name: "cheese", grams: 30 }, { name: "rice", grams: 100 },
        ],
      }],
    });
    const writes = { rows: [] as { table: string; row: Record<string, unknown> }[] };
    const result = await runTurn(db(RESTRICTED, writes), db(RESTRICTED, writes), "u1",
      { ...REQ, text: "save cheese and rice as Dinner" }, {
        generate: generate as never,
        classifyIntent: vi.fn().mockResolvedValue(null) as never,
        verifyReply: vi.fn().mockResolvedValue({ flagged: false, p: null }) as never,
        ports: {
          ...ports,
          searchFoods: async (_userId, name) => name === "cheese" ? [{
            foodRefId: "3f1b1a2c-0000-4000-8000-0000000000c1", name: "cheese",
            brand: null, kcalPer100g: 400, proteinPer100g: 20, carbsPer100g: 2,
            fatPer100g: 33, prefStatus: null, allergenTags: ["dairy"], category: [],
          }] : [{
            foodRefId: "3f1b1a2c-0000-4000-8000-0000000000e1", name: "rice",
            brand: null, kcalPer100g: 130, proteinPer100g: 2.7, carbsPer100g: 28,
            fatPer100g: 0.3, prefStatus: "eats" as const,
          }],
        },
        now: () => 0,
        newId: () => "id-1",
      });
    const refusals = [
      "Skipped cheese: not verified as human food.",
      // Phase 13 §5: an active allergen finding speaks in the card's own words, not the generic
      // food-preferences copy — rice carries no gluten evidence, so the allergen floor is unknown.
      "Cannot verify rice: check the label for gluten — marked Not verified.",
    ];

    expect(result.messages.at(-1)?.content).toBe(refusals.join(" "));
    expect(result.actions).toEqual([]);
    const assistant = writes.rows.filter((row) => row.table === "coach_messages").at(-1)!
      .row as { tool_calls: { actions: unknown[]; recipeRefusals?: string[] } };
    expect(assistant.tool_calls.actions).toEqual([]);
    expect(assistant.tool_calls.recipeRefusals).toEqual(refusals);
  });

  it("policy-filters an injected compose result into refusals with no ideas or composed card", async () => {
    const meal: ComposedMeal = {
      wish: "cheese dinner", slot: null,
      items: [{
        name: "cheese", foodRefId: "3f1b1a2c-0000-4000-8000-0000000000c1",
        catalogFoodRevisionId: 1, grams: 100, kcalPer100g: 400,
        proteinPer100g: 20, carbsPer100g: 2, fatPer100g: 33,
        macros: { kcal: 400, protein: 20, carbs: 2, fat: 33 }, verdict: "blocked",
      }],
      totals: { kcal: 400, protein: 20, carbs: 2, fat: 33 },
      target: { kcal: 500, protein: 35, carbs: 45, fat: 18 },
      flagged: ["cheese"], fitsTarget: false,
    };
    const generate = vi.fn()
      .mockResolvedValueOnce({ kind: "tool", calls: [{
        name: "compose_meal", args: { wish: "cheese dinner" },
      }] })
      .mockResolvedValueOnce({ kind: "final", text: "I could not compose that meal." });
    const writes = { rows: [] as { table: string; row: Record<string, unknown> }[] };
    const result = await runTurn(db({}, writes), db({}, writes), "u1",
      { ...REQ, text: "make me a cheese dinner" }, {
        generate: generate as never,
        classifyIntent: vi.fn().mockResolvedValue(null) as never,
        verifyReply: vi.fn().mockResolvedValue({ flagged: false, p: null }) as never,
        ports: { ...ports, compose: async () => meal },
        now: () => 0,
        newId: () => "id-1",
      });

    expect(result.composed).toEqual([]);
    const assistant = writes.rows.filter((row) => row.table === "coach_messages").at(-1)!
      .row as { tool_calls: { calls: { result?: { ideas?: unknown[]; refusals?: string[] } }[] } };
    expect(assistant.tool_calls.calls[0]?.result).toMatchObject({
      ideas: [], refusals: ["Skipped cheese: not verified as human food."],
    });
  });

  it("defaults an omitted action date to the turn's local today", async () => {
    const generate = vi.fn(async () => ({ kind: "final", text: "Moved dinner.", actions: [{
      kind: "move_slot", slot: "meal-3", time: "19:30",
    }] }));
    const nowMs = new Date("2026-09-16T18:00:00.000Z").getTime();
    const result = await runTurn(db({}, { rows: [] }), db({}, { rows: [] }), "u1",
      { ...REQ, text: "move dinner" },
      { generate: generate as never, ports, now: () => nowMs, newId: () => "id-1" });
    expect(result.actions[0]).toMatchObject({ kind: "move_slot", date: "2026-09-16" });
  });

  it("takes the schema-failure path for log_meal without grams and never invents a quantity", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const generate = vi.fn(async () => ({ kind: "final", text: "Logged breakfast.", actions: [{
      kind: "log_meal", slot: "meal-1", items: [{ name: "rice" }],
    }] }));
    await expect(runTurn(db({}, { rows: [] }), db({}, { rows: [] }), "u1",
      { ...REQ, text: "I ate rice" },
      { generate: generate as never, ports, now: () => 0, newId: () => "id-1" }))
      .rejects.toMatchObject({ status: 503, code: "coach_unavailable" });
    expect(logged).toHaveBeenCalled();
  });

  it("clears actions when free-text policy aborts the reply", async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce({ kind: "tool", calls: [
        { name: "search_foods", args: { query: "cheese" } }] })
      .mockResolvedValueOnce({ kind: "final", text: "Cheese is ready.", actions: [{
        kind: "move_slot", date: "2026-09-16", slot: "meal-3", time: "19:30",
      }] });
    const writes = { rows: [] as { table: string; row: Record<string, unknown> }[] };
    const result = await runTurn(db(RESTRICTED, writes), db(RESTRICTED, writes), "u1",
      { ...REQ, text: "move dinner and add cheese" },
      { generate: generate as never, ports: cheesePorts(), now: () => 0, newId: () => "id-1" });
    expect(result.messages.at(-1)?.content).toMatch(/try naming the meal or food you mean/i);
    expect(result.actions).toEqual([]);
    const assistant = writes.rows.filter((row) => row.table === "coach_messages").at(-1)!.row;
    expect(assistant.tool_calls).toMatchObject({ actions: [] });
  });

  it("replays the grounded actions persisted on the assistant message", async () => {
    const action = { actionId: "a-replay", kind: "move_slot", date: "2026-09-16",
      slot: "meal-3", time: "19:30", flagged: [] };
    const tables = { coach_threads: [{ id: "thread-1", kind: "chat" }], coach_messages: [
      { id: REQ.messageId, thread_id: "thread-1", user_id: "u1", role: "user",
        content: "move dinner", seq: 1, tool_calls: [] },
      { id: "assistant-1", thread_id: "thread-1", user_id: "u1", role: "assistant",
        content: "Moved dinner.", seq: 2, tool_calls: { calls: [], actions: [action] } },
    ] };
    const generate = vi.fn();
    const result = await runTurn(db(tables, { rows: [] }), db(tables, { rows: [] }), "u1",
      { ...REQ, text: "move dinner" },
      { generate: generate as never, ports, now: () => 0, newId: () => "id-1" });
    expect(generate).not.toHaveBeenCalled();
    expect(result.actions).toEqual([action]);
  });

  it("returns all five suggestion cards and preserves them on thread replay", async () => {
    const cards = Array.from({ length: 5 }, (_, index) => composedCard(index + 1));
    const generate = vi.fn()
      .mockResolvedValueOnce({ kind: "tool", calls: [{
        name: "suggest_options", args: { kind: "meal", count: 5 },
      }] })
      .mockResolvedValueOnce({ kind: "final", text: "Here are five options." });
    const writes = { rows: [] as { table: string; row: Record<string, unknown> }[] };

    const first = await runTurn(db({}, writes), db({}, writes), "u1",
      { ...REQ, text: "give me five meal options" }, {
        classifyIntent: vi.fn().mockResolvedValue(null) as never,
        verifyReply: vi.fn().mockResolvedValue({ flagged: false, p: null }) as never,
        generate: generate as never,
        ports: { ...ports, suggest: async () => cards },
        now: () => 0,
        newId: () => "id-1",
      });

    expect(first.composed).toEqual(cards);
    expect(first.composed).toHaveLength(5);
    const persisted = writes.rows.filter((write) => write.table === "coach_messages")
      .map((write) => write.row);
    const replayGenerate = vi.fn();
    const replayTables = { coach_threads: [{ id: "id-1", kind: "chat" }], coach_messages: persisted };
    const replay = await runTurn(db(replayTables, { rows: [] }),
      db(replayTables, { rows: [] }), "u1",
      { ...REQ, text: "give me five meal options" }, {
        generate: replayGenerate as never,
        ports,
        now: () => 0,
        newId: () => "id-2",
      });
    expect(replay.composed).toEqual(cards);
    expect(replayGenerate).not.toHaveBeenCalled();
    // C8: the replay says what the first answer said — a model turn.
    expect(replay.provenance).toEqual({ ai: true, source: "model", purpose: "coach" });
  });

  // 2026-09-24/25, production: suggest_options is declared once per turn, but nothing enforced it.
  // Two calls ran the turn past its 30 s budget ("That took too long"); a failing one was retried
  // seven times ("that lookup failed").
  it("runs a once-per-turn tool once and tells the model to answer with what it has", async () => {
    const suggest = vi.fn(async () => [composedCard(1)]);
    const generate = vi.fn()
      .mockResolvedValueOnce({ kind: "tool", calls: [
        { name: "suggest_options", args: { kind: "meal", count: 3 } },
        { name: "suggest_options", args: { kind: "meal", count: 3 } },
      ] })
      .mockResolvedValueOnce({ kind: "tool", calls: [{ name: "suggest_options", args: { kind: "meal", count: 2 } }] })
      .mockResolvedValueOnce({ kind: "final", text: "Here is one option." });
    const result = await runTurn(db({}, { rows: [] }), db({}, { rows: [] }), "u1",
      { ...REQ, text: "six dinner recipes" }, {
        classifyIntent: vi.fn().mockResolvedValue(null) as never,
        verifyReply: vi.fn().mockResolvedValue({ flagged: false, p: null }) as never,
        generate: generate as never, ports: { ...ports, suggest }, now: () => 0, newId: () => "id-1",
      });
    expect(suggest).toHaveBeenCalledTimes(1);
    expect(result.messages.at(-1)?.content).toBe("Here is one option.");
  });

  it("stops a tool after two calls with bad arguments", async () => {
    const generate = vi.fn();
    for (let i = 0; i < 4; i += 1) {
      generate.mockResolvedValueOnce({ kind: "tool", calls: [{ name: "draft_log_entry", args: {} }] });
    }
    generate.mockResolvedValueOnce({ kind: "final", text: "How many grams of yams?" });
    await runTurn(db({}, { rows: [] }), db({}, { rows: [] }), "u1",
      { ...REQ, text: "log yams" }, {
        classifyIntent: vi.fn().mockResolvedValue(null) as never,
        verifyReply: vi.fn().mockResolvedValue({ flagged: false, p: null }) as never,
        generate: generate as never, ports, now: () => 0, newId: () => "id-1",
      });
    const transcript = JSON.stringify(generate.mock.calls.at(-1));
    expect(transcript).toContain("already called draft_log_entry");
  });

  it("normalises a legacy single composed card to a one-element replay array", async () => {
    const card = composedCard(1);
    const tables = { coach_threads: [{ id: "thread-1", kind: "chat" }], coach_messages: [
      { id: REQ.messageId, thread_id: "thread-1", user_id: "u1", role: "user",
        content: "make a meal", seq: 1, tool_calls: [] },
      { id: "assistant-1", thread_id: "thread-1", user_id: "u1", role: "assistant",
        content: "Here it is.", seq: 2,
        tool_calls: { calls: [], actions: [], suggestions: [], composed: card } },
    ] };

    const result = await runTurn(db(tables, { rows: [] }), db(tables, { rows: [] }), "u1",
      { ...REQ, text: "make a meal" }, {
        generate: vi.fn() as never,
        ports,
        now: () => 0,
        newId: () => "id-1",
      });

    expect(result.composed).toEqual([card]);
  });

  it("replays no actions from an old assistant row without an actions key", async () => {
    const tables = { coach_threads: [{ id: "thread-1", kind: "chat" }], coach_messages: [
      { id: REQ.messageId, thread_id: "thread-1", user_id: "u1", role: "user",
        content: "hello", seq: 1, tool_calls: [] },
      { id: "assistant-1", thread_id: "thread-1", user_id: "u1", role: "assistant",
        content: "Hello.", seq: 2, tool_calls: [] },
    ] };
    const generate = vi.fn();
    const result = await runTurn(db(tables, { rows: [] }), db(tables, { rows: [] }), "u1",
      { ...REQ, text: "hello" },
      { generate: generate as never, ports, now: () => 0, newId: () => "id-1" });
    expect(generate).not.toHaveBeenCalled();
    expect(result.actions).toEqual([]);
  });

  it("drops malformed stored actions while replaying valid ones", async () => {
    const action = { actionId: "a-replay", kind: "move_slot", date: "2026-09-16",
      slot: "meal-3", time: "19:30", flagged: [] };
    const tables = { coach_threads: [{ id: "thread-1", kind: "chat" }], coach_messages: [
      { id: REQ.messageId, thread_id: "thread-1", user_id: "u1", role: "user",
        content: "move dinner", seq: 1, tool_calls: [] },
      { id: "assistant-1", thread_id: "thread-1", user_id: "u1", role: "assistant",
        content: "Moved dinner.", seq: 2, tool_calls: { calls: [], actions: [
          action, { ...action, actionId: 42, time: "whenever" },
        ] } },
    ] };
    const result = await runTurn(db(tables, { rows: [] }), db(tables, { rows: [] }), "u1",
      { ...REQ, text: "move dinner" },
      { generate: vi.fn() as never, ports, now: () => 0, newId: () => "id-1" });
    expect(result.actions).toEqual([action]);
  });

  it("records the refused out-of-registry call in coach_messages.tool_calls", async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce({ kind: "tool", calls: [{ name: "set_targets", args: {} }] })
      .mockResolvedValueOnce({ kind: "final", text: "no" });
    const writes = { rows: [] as { table: string; row: Record<string, unknown> }[] };
    await runTurn(db({}, writes), db({}, writes), "u1", { ...REQ, text: "lower my protein" },
      { generate: generate as never, ports, now: () => 0, newId: () => "id-1" });
    const assistant = writes.rows.filter((w) => w.table === "coach_messages").at(-1)!.row;
    expect(JSON.stringify(assistant.tool_calls)).toContain("unknown_tool: set_targets");
  });

  it("blocks a suggestion with the evidence from this turn's own search", async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce({ kind: "tool", calls: [
        { name: "search_foods", args: { query: "cheese" } }] })
      .mockResolvedValueOnce({ kind: "final", text: "cheese on the side", suggestions: [
        { name: "cheese", grams: 30 }] });
    const writes = { rows: [] as { table: string; row: Record<string, unknown> }[] };
    const res = await runTurn(db(RESTRICTED, writes), db(RESTRICTED, writes), "u1",
      { ...REQ, text: "can I have cheese" },
      { generate: generate as never, ports: cheesePorts(), now: () => 0, newId: () => "id-1" });
    // Phase 13 §6 row 5, §9 R7: the prose names the blocked food, so the reply is a re-ask; the
    // re-ask replaces the reply, not the verdict, so the card stays on screen as blocked (Phase 7).
    expect(res.messages.at(-1)!.content).toMatch(/try naming the meal or food you mean/i);
    expect(res.suggestions).toEqual([expect.objectContaining({ name: "cheese", verdict: "blocked" })]);
    expect(policyChecks(writes).some((c) => c.verdict === "blocked"
      && /^allergen:dairy/.test(c.reason ?? ""))).toBe(true);
  });

  it("blocks a suggestion whose search hit carries a banned policy category", async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce({ kind: "tool", calls: [
        { name: "search_foods", args: { query: "onion" } }] })
      .mockResolvedValueOnce({ kind: "final", text: "raw onion works", suggestions: [
        { name: "Onions, raw", grams: 50 }] });
    const writes = { rows: [] as { table: string; row: Record<string, unknown> }[] };
    const res = await runTurn(db(RESTRICTED, writes), db(RESTRICTED, writes), "u1",
      { ...REQ, text: "can I have raw onion" },
      { generate: generate as never, ports: onionPorts(), now: () => 0, newId: () => "id-1" });
    expect(res.messages.at(-1)!.content).toMatch(/try naming the meal or food you mean/i);
    expect(res.suggestions).toEqual([expect.objectContaining({
      name: "Onions, raw", verdict: "blocked", reason: "category:onion_garlic" })]);
    expect(policyChecks(writes).some((c) => c.verdict === "blocked"
      && c.reason === "category:onion_garlic")).toBe(true);
  });

  it("blocks free text naming a food this turn's search flagged, even with no suggestions card", async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce({ kind: "tool", calls: [
        { name: "search_foods", args: { query: "cheese" } }] })
      .mockResolvedValueOnce({ kind: "final", text: "Cheese is a solid snack.", suggestions: [] });
    const writes = { rows: [] as { table: string; row: Record<string, unknown> }[] };
    const res = await runTurn(db(RESTRICTED, writes), db(RESTRICTED, writes), "u1",
      { ...REQ, text: "can I have cheese" },
      { generate: generate as never, ports: cheesePorts(), now: () => 0, newId: () => "id-1" });
    expect(res.messages.at(-1)!.content).not.toContain("Cheese is a solid snack");
    expect(res.messages.at(-1)!.content).toMatch(/try naming the meal or food you mean/i);
    expect(res.suggestions).toEqual([]);
    const checks = writes.rows.filter((w) => w.table === "coach_messages").at(-1)!
      .row.policy_checks as { verdict: string; reason: string | null }[];
    expect(checks.some((c) => c.verdict === "blocked" && /^allergen:dairy/.test(c.reason ?? "")))
      .toBe(true);
  });

  it("drops a draft item the turn's own search found dairy evidence for, and records it", async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce({ kind: "tool", calls: [
        { name: "search_foods", args: { query: "cheese" } }] })
      .mockResolvedValueOnce({ kind: "tool", calls: [
        { name: "draft_log_entry", args: { slot: "meal-2", items: [{ name: "cheese", grams: 30 }] } }] })
      .mockResolvedValueOnce({ kind: "final", text: "not today", suggestions: [] });
    const writes = { rows: [] as { table: string; row: Record<string, unknown> }[] };
    const res = await runTurn(db(RESTRICTED, writes), db(RESTRICTED, writes), "u1",
      { ...REQ, text: "log some cheese" },
      { generate: generate as never, ports: cheesePorts(), now: () => 0, newId: () => "id-1" });
    expect(res.draft).toBeNull();
    const checks = writes.rows.filter((w) => w.table === "coach_messages").at(-1)!
      .row.policy_checks as { verdict: string; reason: string | null }[];
    expect(checks.some((c) => c.verdict === "blocked" && /^allergen:dairy/.test(c.reason ?? "")))
      .toBe(true);
  });

  it("404s a threadId she does not own before the model runs", async () => {
    const generate = vi.fn();
    const error = await runTurn(db({}, { rows: [] }), db({}, { rows: [] }), "u1",
      { ...REQ, threadId: "3f1b1a2c-0000-4000-8000-0000000000ff", text: "what should I eat" },
      { generate: generate as never, ports, now: () => 0, newId: () => "id-1" }).catch((e) => e);
    expect(error).toMatchObject({ status: 404, code: "not_found" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("keeps a threadId that is in her coach_threads table", async () => {
    const threadId = "3f1b1a2c-0000-4000-8000-0000000000ee";
    const generate = vi.fn()
      .mockResolvedValueOnce({ kind: "final", text: "eat rice", suggestions: [] });
    const res = await runTurn(db({ coach_threads: [{ id: threadId, kind: "chat" }] }, { rows: [] }),
      db({ coach_threads: [{ id: threadId, kind: "chat" }] }, { rows: [] }), "u1",
      { ...REQ, threadId, text: "what should I eat" },
      { generate: generate as never, ports, now: () => 0, newId: () => "id-1" });
    expect(res.threadId).toBe(threadId);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("aborts with a readable message once the tool-call cap is reached", async () => {
    const generate = vi.fn().mockResolvedValue(
      { kind: "tool", calls: [{ name: "get_day", args: { date: "2026-09-11" } }] });
    const res = await runTurn(db({}, { rows: [] }), db({}, { rows: [] }), "u1",
      { ...REQ, text: "what should I eat" },
      { generate: generate as never, ports, now: () => 0, newId: () => "id-1" });
    expect(generate).toHaveBeenCalledTimes(TURN_LIMITS.maxToolCalls + 1);
    expect(res.messages.at(-1)!.content).toContain("pin that one down");
  });

  it("aborts on the wall-clock budget instead of hanging forever when the model call never settles", async () => {
    // A provider call that never resolves (a real hang, not a slow-but-eventual reply) — the
    // production smoke report ("can I have a cheeseburger for meal 2" stuck on "Thinking" for
    // over 3 minutes, no /api/coach response ever completing). Nothing in the loop bounds the
    // in-flight generate() call itself, so today this test would hang until vitest's own
    // per-test timeout kills it, not until the documented 30s wall clock does.
    const generate = vi.fn(() => new Promise<never>(() => {}));
    const res = await runTurn(db({}, { rows: [] }), db({}, { rows: [] }), "u1",
      { ...REQ, text: "can I have a cheeseburger for meal 2" },
      { generate: generate as never, ports, now: () => 0, newId: () => "id-1", wallClockMs: 20 });
    expect(res.messages.at(-1)!.content).toContain("took too long");
  });

  it("returns 503 nous_unconfirmed when her profile carries conditions or notes, and never calls the adapter", async () => {
    vi.stubEnv("HEALTH_CONTEXT_PROVIDER", "");   // the health switch is off
    const tables = { constraint_profiles: [{ rev: 1, conditions: ["ulcerative colitis"],
      notes: null, avoid_allergens: ["gluten", "dairy", "apple"], avoid_food_ref_ids: [],
      banned_categories: ["simple_sugars"], custom_rules: [] }] };
    const generate = vi.fn();
    const writes = { rows: [] as { table: string; row: unknown }[] };
    await expect(runTurn(db(tables, writes), db(tables, writes), "u1",
      { ...REQ, text: "what should I eat" },
      { generate: generate as never, ports, now: () => 0, newId: () => "id-1" }))
      .rejects.toMatchObject({ status: 503, code: "nous_unconfirmed" });
    expect(generate).not.toHaveBeenCalled();
    expect(writes.rows).toEqual([]);
  });

  it("returns 503 nous_unconfirmed when her profile carries non-empty notes and no conditions, and never calls the adapter", async () => {
    vi.stubEnv("HEALTH_CONTEXT_PROVIDER", "");   // the health switch is off
    const tables = { constraint_profiles: [{ rev: 1, conditions: [],
      notes: "flares on high-fiber days", avoid_allergens: [], avoid_food_ref_ids: [],
      banned_categories: [], custom_rules: [] }] };
    const generate = vi.fn();
    const writes = { rows: [] as { table: string; row: unknown }[] };
    await expect(runTurn(db(tables, writes), db(tables, writes), "u1",
      { ...REQ, text: "what should I eat" },
      { generate: generate as never, ports, now: () => 0, newId: () => "id-1" }))
      .rejects.toMatchObject({ status: 503, code: "nous_unconfirmed" });
    expect(generate).not.toHaveBeenCalled();
    expect(writes.rows).toEqual([]);
  });

  it("wires the default latestEstimate port to the real expenditure_estimates table when no ports are injected", async () => {
    const tables = {
      expenditure_estimates: [{ local_date: "2026-09-10", status: "steady", tdee_kcal: 2400,
        weight_trend_kg: -0.2, intake_completeness: 1, qualified_days: 21, weigh_in_count: 5,
        confidence: 0.9, reason: "ok", engine_version: 1 }],
    };
    const generate = vi.fn()
      .mockResolvedValueOnce({ kind: "tool", calls: [{ name: "get_expenditure_status", args: {} }] })
      .mockResolvedValueOnce({ kind: "final", text: "you're at 2400", suggestions: [] });
    const writes = { rows: [] as { table: string; row: unknown }[] };
    await runTurn(db(tables, writes), db(tables, writes), "u1",
      { ...REQ, text: "what's my expenditure" },
      { generate: generate as never, now: () => 0, newId: () => "id-1" });
    const secondCallText = (generate.mock.calls[1][0] as { payload: { parts: { text: string }[] } })
      .payload.parts[0].text;
    expect(secondCallText).toContain("\"status\":\"steady\"");
    expect(secondCallText).toContain("2400");
  });

  /** Run one get_targets turn against `tables` and return what the tool handed the model. */
  async function getTargetsPayload(tables: Record<string, unknown[]>): Promise<
    { id: string; resolved: { training: { protein: number }; rest: { protein: number } } } | null
  > {
    const generate = vi.fn()
      .mockResolvedValueOnce({ kind: "tool", calls: [{ name: "get_targets", args: {} }] })
      .mockResolvedValueOnce({ kind: "final", text: "Your targets are available." });
    const client = db(tables, { rows: [] });
    await runTurn(client, client, "u1", { ...REQ, text: "what are my targets" },
      { generate: generate as never }); // No injected target port: exercise the production wiring.
    const transcript = generate.mock.calls[1][0].payload.parts[0].text as string;
    return JSON.parse(transcript.split("tool: get_targets\n")[1].split("\n")[0]);
  }

  it("get_targets supplies the authored active profile to the next model step", async () => {
    const target = await getTargetsPayload({ target_profiles: [{
      id: "authored-target", mode: "grams", kcal_train: 2200, kcal_rest: 1800,
      protein_g: 125, fat_g: 80, carb_g: 200,
      kcal_min: 1650, protein_g_min: 125, fat_g_min: 50, carb_g_min: 0,
    }], user_settings: [] });
    expect(target?.id).toBe("authored-target");
    expect(target?.resolved.training.protein).toBe(125);
    expect(target?.resolved.rest.protein).toBe(125);
  });

  it("get_targets supplies no numbers when no revision is effective", async () => {
    // The ramp is deleted (design §5.1): a missing revision is `needs_profile`,
    // and the coach never invents a substitute.
    expect(await getTargetsPayload({ user_settings: [{}], target_profiles: [] })).toBeNull();
  });
  // The turn budget (W035) is proven in tests/coach/turn-budget.test.ts.
});


describe("coach provider attempt budget", () => {
  beforeEach(() => {
    vi.stubEnv("COACH_ENABLED", "1");
    vi.stubEnv("TYPESAFE_API_KEY", "");
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it("keeps a healthy ten-second response alive through the real adapter", async () => {
    const client = db({}, { rows: [] });
    const callGemini = vi.fn((_model, _parts, _schema, _tokens, signal?: AbortSignal) =>
      new Promise<{ text: string; inputTokens: number; outputTokens: number }>((resolve, reject) => {
        const timer = setTimeout(() => resolve({
          text: JSON.stringify({ kind: "final", text: "Try rice." }), inputTokens: 1, outputTokens: 1,
        }), 10_000);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        }, { once: true });
      }));
    let reply: Awaited<ReturnType<typeof runTurn>> | undefined;
    const pending = runTurn(client, client, "slow-healthy", { ...REQ, text: "what should I eat" },
      { ports, generate: (args) => generateStructured(args, { callGemini }) })
      .then((value) => { reply = value; });
    await vi.advanceTimersByTimeAsync(10_001);
    expect(reply?.messages.at(-1)?.content).toBe("Try rice.");
    expect(callGemini).toHaveBeenCalledTimes(1);
    await pending;
  });

  it("aborts stalled attempts and still ends inside the thirty-second call budget", async () => {
    const client = db({}, { rows: [] });
    const signals: AbortSignal[] = [];
    const callGemini = vi.fn((_model, _parts, _schema, _tokens, signal?: AbortSignal) => {
      signals.push(signal!);
      return new Promise<never>(() => {}); // Even a transport ignoring abort cannot extend the call.
    });
    let outcome: "reply" | "failure" | null = null;
    let failure: unknown;
    let reply: Awaited<ReturnType<typeof runTurn>> | undefined;
    const pending = runTurn(client, client, "stalled", { ...REQ, text: "what should I eat" },
      { ports, generate: (args) => generateStructured(args, { callGemini }) })
      .then((value) => { reply = value; outcome = "reply"; })
      .catch((error) => { failure = error; outcome = "failure"; });
    // Live 2026-10-02: a stall that leaves time in the turn tries the fallback model once with
    // what is left; the turn still ends on its own 30 s wall clock with every attempt aborted —
    // as a 503, or as the wall-clock reply when the fallback runs the clock out.
    await vi.advanceTimersByTimeAsync(30_500);
    expect(outcome).not.toBeNull();
    if (outcome === "failure") expect(failure).toMatchObject({ status: 503, code: "coach_unavailable" });
    else expect(reply?.messages.at(-1)?.content).toMatch(/took too long/i);
    expect(callGemini.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(callGemini.mock.calls.at(-1)?.[0]).not.toBe(callGemini.mock.calls[0][0]);
    expect(signals.slice(0, 2).every((signal) => signal.aborted)).toBe(true);
    await pending;
  });
});

describe("coach output token limit", () => {
  beforeEach(() => {
    vi.stubEnv("COACH_ENABLED", "1");
    vi.stubEnv("TYPESAFE_API_KEY", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("caps every attempt and retries a truncated reply without saving partial text", async () => {
    const writes = { rows: [] as { table: string; row: unknown }[] };
    const client = db({}, writes);
    const caps: (number | undefined)[] = [];
    const callGemini = vi.fn(async (_model, _parts, _schema, cap?: number) => {
      caps.push(cap);
      return { text: caps.length === 1 ? '{"kind":"final","text":"unfinished'
        : JSON.stringify({ kind: "final", text: "Your reply is ready." }), inputTokens: 1, outputTokens: 1 };
    });
    const result = await runTurn(client, client, "truncated-then-ok",
      { ...REQ, text: "please help with a snack" },
      { ports, generate: (args) => generateStructured(args, { callGemini, sleep: async () => {} }) });
    expect(caps).toEqual([TURN_LIMITS.maxOutputTokens, TURN_LIMITS.maxOutputTokens]);
    expect(result.messages.at(-1)?.content).toBe("Your reply is ready.");
    expect(JSON.stringify(writes.rows.filter((row) => row.table === "coach_messages")))
      .not.toContain("unfinished");
  });

  it("never saves an assistant reply when every capped attempt returns truncated JSON", async () => {
    const writes = { rows: [] as { table: string; row: unknown }[] };
    const client = db({}, writes);
    const caps: (number | undefined)[] = [];
    const callGemini = vi.fn(async (_model, _parts, _schema, cap?: number) => {
      caps.push(cap);
      return { text: '{"kind":"final","text":"unfinished', inputTokens: 1, outputTokens: 1 };
    });
    await expect(runTurn(client, client, "always-truncated",
      { ...REQ, text: "please help with a snack" },
      { ports, generate: (args) => generateStructured(args, { callGemini, sleep: async () => {} }) }))
      .rejects.toMatchObject({ status: 503, code: "coach_unavailable" });
    // Three capped attempts, and no fallback: a truncated reply is a schema failure, ours.
    expect(caps).toEqual(Array(3).fill(TURN_LIMITS.maxOutputTokens));
    expect(writes.rows.filter((row) => row.table === "coach_messages")).toEqual([]);
  });
});
