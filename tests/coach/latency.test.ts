/**
 * Coach latency, 2026-09-23. The owner saw "The coach did not answer in time" on a turn that the
 * server finished with a 200 — 43 s after the request started, 3 s after the phone gave up at its
 * 40 s deadline (lib/fetch-with-deadline.ts). Production evidence (ai_calls + coach_messages):
 *
 *   request start -> first model call      ~9.0 s  (DB reads, intent, context)
 *   model call 1                            3.2 s
 *   three search_foods, one after another  ~16  s  <- the largest single cost
 *   model call 2                            3.9 s
 *   grounding, verify, persist             ~11  s
 *
 * Model time was 7.1 s of 43 s. The server's own budget (75 s, counted from AFTER the intent
 * call) was larger than the phone's, so nothing on the server stopped the turn in time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runTurn } from "@/tests/coach/fixtures/run-turn";
import { PER_CALL_TIMEOUT_MS, TURN_LIMITS, TURN_REPLY_DEADLINE_MS } from "@/lib/coach/turn";
import { DEADLINES } from "@/lib/fetch-with-deadline";

const REQ = { threadId: null, messageId: "3f1b1a2c-0000-4000-8000-000000000011", text: "" };

function db() {
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    select: () => chain, eq: () => chain, in: () => chain, is: () => chain, gte: () => chain,
    order: () => chain, limit: () => chain, insert: () => chain, update: () => chain,
    delete: () => chain,
    maybeSingle: async () => ({ data: null, error: null }),
    single: async () => ({ data: null, error: null }),
    then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(resolve),
  });
  return { from: () => chain, rpc: async () => ({ data: null, error: null }) } as never;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const DELAY_BY_QUERY: Record<string, number> = { oats: 300, eggs: 200, rice: 100 };

const ports = {
  dayTotals: async () => ({ local_date: "2026-09-23", nutrients: [] }),
  weekTotals: async () => [],
  activeTargets: async () => ({ kcal_train: 2200, protein_g: 135 }),
  latestEstimate: async () => ({ status: "burn_in", tdeeKcal: null }),
  searchFoods: async (_userId: string, query: string) => {
    await sleep(DELAY_BY_QUERY[query] ?? 0);
    return [{ foodRefId: null, name: `${query}-hit`, brand: null, kcalPer100g: 100,
      prefStatus: null }];
  },
  getConstraints: async () => ({ avoid_allergens: [] }),
  recentGut: async () => [],
  newDraftId: () => "draft-1",
};

const noIntent = () => vi.fn().mockResolvedValue(null) as never;

describe("coach turn latency", () => {
  beforeEach(() => { vi.stubEnv("COACH_ENABLED", "1"); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("runs one batch of tool calls concurrently, and keeps their results in call order", async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce({ kind: "tool", calls: [
        { name: "search_foods", args: { query: "oats" } },
        { name: "search_foods", args: { query: "eggs" } },
        { name: "search_foods", args: { query: "rice" } },
      ] })
      .mockResolvedValueOnce({ kind: "final", text: "Oats, eggs and rice all fit." });

    const started: string[] = [];
    const release = new Map<string, () => void>();
    const controlledPorts = { ...ports, searchFoods: async (_userId: string, query: string) =>
      new Promise<Awaited<ReturnType<typeof ports.searchFoods>>>((resolve) => {
        started.push(query);
        release.set(query, () => resolve([{ foodRefId: null, name: `${query}-hit`, brand: null,
          kcalPer100g: 100, prefStatus: null }]));
      }) };
    const turn = runTurn(db(), db(), "u1", { ...REQ, text: "breakfast ideas" },
      { generate: generate as never, ports: controlledPorts, now: () => 0, newId: () => "id-1",
        classifyIntent: noIntent() });
    // All three must start before any can finish. Release in reverse completion order.
    await vi.waitFor(() => expect(started).toEqual(["oats", "eggs", "rice"]));
    release.get("rice")!(); release.get("eggs")!(); release.get("oats")!();
    const res = await turn;
    expect(res.messages.at(-1)!.content).toContain("Oats");
    // The model reads the results in the order it asked for them, whichever landed first.
    const prompt = (generate.mock.calls[1][0] as { payload: { parts: { text: string }[] } }).payload.parts[0].text;
    const at = (name: string) => prompt.indexOf(`${name}-hit`);
    expect(at("oats")).toBeGreaterThan(-1);
    expect(at("oats")).toBeLessThan(at("eggs"));
    expect(at("eggs")).toBeLessThan(at("rice"));
  });

  it("counts the turn's budget from the start of the turn, not from after the intent call", async () => {
    const generate = vi.fn();
    const slowIntent = vi.fn(async () => { await sleep(80); return null; });
    const res = await runTurn(db(), db(), "u1", { ...REQ, text: "what should I eat" },
      { generate: generate as never, ports, now: () => 0, newId: () => "id-1",
        classifyIntent: slowIntent as never, wallClockMs: 50 });
    expect(generate).not.toHaveBeenCalled();
    expect(res.messages.at(-1)!.content).toContain("took too long");
  });

  it("does not start another model call once the tools have spent the budget", async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce({ kind: "tool", calls: [{ name: "search_foods", args: { query: "oats" } }] })
      .mockResolvedValueOnce({ kind: "final", text: "too late to be read" });
    const res = await runTurn(db(), db(), "u1", { ...REQ, text: "breakfast ideas" },
      { generate: generate as never, ports, now: () => 0, newId: () => "id-1",
        classifyIntent: noIntent(), wallClockMs: 100 });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(res.messages.at(-1)!.content).toContain("took too long");
  });
});

describe("coach turn deadline (review r1, BLOCK 1)", () => {
  beforeEach(() => { vi.stubEnv("COACH_ENABLED", "1"); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("abandons a tool batch that outlives the turn's budget", async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce({ kind: "tool", calls: [{ name: "search_foods", args: { query: "slow" } }] })
      .mockResolvedValueOnce({ kind: "final", text: "never read" });
    const slowPorts = { ...ports, searchFoods: async () => { await sleep(400); return []; } };
    const started = Date.now();
    const res = await runTurn(db(), db(), "u1", { ...REQ, text: "breakfast ideas" },
      { generate: generate as never, ports: slowPorts, now: () => 0, newId: () => "id-1",
        classifyIntent: noIntent(), wallClockMs: 100, replyDeadlineMs: 150 });
    expect(Date.now() - started).toBeLessThan(300);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(res.messages.at(-1)!.content).toContain("took too long");
  });

  it("stops grounding the final reply at the reply deadline and says so", async () => {
    const generate = vi.fn().mockResolvedValueOnce({ kind: "final", text: "Adding kale.",
      actions: [{ kind: "add_to_eats", name: "kale" }] });
    const slowPorts = { ...ports, searchFoods: async () => { await sleep(400); return []; } };
    const started = Date.now();
    const res = await runTurn(db(), db(), "u1", { ...REQ, text: "add kale to my eats" },
      { generate: generate as never, ports: slowPorts, now: () => 0, newId: () => "id-1",
        classifyIntent: noIntent(), wallClockMs: 100, replyDeadlineMs: 150 });
    expect(Date.now() - started).toBeLessThan(300);
    expect(res.actions).toEqual([]);
    expect(res.messages.at(-1)!.content).toContain("ran out of time");
  });
});

describe("coach turn deadline (review r2)", () => {
  beforeEach(() => { vi.stubEnv("COACH_ENABLED", "1"); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("bounds fast-path grounding by the reply deadline (BLOCK 1)", async () => {
    const generate = vi.fn();
    const slowPorts = { ...ports, searchFoods: async () => { await sleep(400); return []; } };
    const classifyIntent = vi.fn(async () => ({ intent: "add_to_eats", confidence: 0.99,
      args: { name: "kale" }, argConfidence: {} }));
    const started = Date.now();
    const res = await runTurn(db(), db(), "u1", { ...REQ, text: "add kale to my eats" },
      { generate: generate as never, ports: slowPorts, now: () => 0, newId: () => "id-1",
        classifyIntent: classifyIntent as never, wallClockMs: 100, replyDeadlineMs: 150 });
    expect(Date.now() - started).toBeLessThan(300);
    expect(generate).not.toHaveBeenCalled();
    expect(res.actions).toEqual([]);
    expect(res.messages.at(-1)!.content).toContain("took too long");
  });

  it("clears every card when final grounding runs out of time (FIX 4)", async () => {
    const generate = vi.fn().mockResolvedValueOnce({ kind: "final", text: "Adding kale.",
      suggestions: [{ name: "kale", foodRefId: null, grams: 50 }],
      actions: [{ kind: "add_to_eats", name: "kale" }] });
    const slowPorts = { ...ports, searchFoods: async () => { await sleep(400); return []; } };
    const res = await runTurn(db(), db(), "u1", { ...REQ, text: "add kale to my eats" },
      { generate: generate as never, ports: slowPorts, now: () => 0, newId: () => "id-1",
        classifyIntent: noIntent(), wallClockMs: 100, replyDeadlineMs: 150 });
    expect(res.actions).toEqual([]);
    expect(res.suggestions).toEqual([]);
    expect(res.composed ?? []).toEqual([]);
    expect(res.draft).toBeNull();
    expect(res.messages.at(-1)!.content).toContain("ran out of time");
  });
});

/** Like db(), but records writes and never answers for the tables in `stall`. */
function stallDb(stall: string[], writes: { table: string; op: string; row: unknown }[] = []) {
  const never = new Promise<never>(() => {});
  const api = (table: string) => {
    const chain: Record<string, unknown> = {};
    const answer = <T,>(value: T) => stall.includes(table) ? never : Promise.resolve(value);
    Object.assign(chain, {
      select: () => chain, eq: () => chain, in: () => chain, is: () => chain, gte: () => chain,
      order: () => chain, limit: () => chain, delete: () => chain,
      insert: (row: unknown) => { writes.push({ table, op: "insert", row }); return chain; },
      update: (row: unknown) => { writes.push({ table, op: "update", row }); return chain; },
      maybeSingle: () => answer({ data: null, error: null }),
      single: () => answer({ data: null, error: null }),
      then: (resolve: (v: { data: unknown[]; error: null }) => unknown,
        reject?: (e: unknown) => unknown) => answer({ data: [], error: null }).then(resolve, reject),
    });
    return chain;
  };
  return { from: (table: string) => api(table), rpc: async () => ({ data: null, error: null }) } as never;
}

describe("coach turn deadline (review r3)", () => {
  beforeEach(() => { vi.stubEnv("COACH_ENABLED", "1"); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("keeps a late answer's memory out of the thread (BLOCK 2)", async () => {
    const writes: { table: string; op: string; row: unknown }[] = [];
    const generate = vi.fn().mockResolvedValueOnce({ kind: "final", text: "Adding kale.",
      memory: ["liked_food|kale"], actions: [{ kind: "add_to_eats", name: "kale" }] });
    const slowPorts = { ...ports, searchFoods: async () => { await sleep(400); return []; } };
    await runTurn(stallDb([], writes), stallDb([], writes), "u1", { ...REQ, text: "add kale" },
      { generate: generate as never, ports: slowPorts, now: () => 0, newId: () => "id-1",
        classifyIntent: noIntent(), wallClockMs: 100, replyDeadlineMs: 150 });
    const patches = writes.filter((w) => w.table === "coach_threads" && w.op === "update");
    expect(patches.length).toBeGreaterThan(0);
    for (const patch of patches) expect(patch.row).not.toHaveProperty("summary");
  });

  it("answers 503 instead of hanging when a setup read stalls (BLOCK 1)", async () => {
    const started = Date.now();
    await expect(runTurn(stallDb(["coach_messages"]), stallDb([]), "u1", { ...REQ, text: "hi" },
      { generate: vi.fn() as never, ports, now: () => 0, newId: () => "id-1",
        classifyIntent: noIntent(), wallClockMs: 100, replyDeadlineMs: 150 }))
      .rejects.toMatchObject({ status: 503 });
    expect(Date.now() - started).toBeLessThan(300);
  });

  it("does not hold the reply for a stalled telemetry write (BLOCK 1)", async () => {
    const classifyIntent = vi.fn(async () => ({ intent: "log_water", confidence: 0.99,
      args: { ml: 500 }, argConfidence: {} }));
    const started = Date.now();
    const res = await runTurn(stallDb([]), stallDb(["coach_intent_events"]), "u1",
      { ...REQ, text: "log 500 ml water" },
      { generate: vi.fn() as never, ports, now: () => 0, newId: () => "id-1",
        classifyIntent: classifyIntent as never, wallClockMs: 100, replyDeadlineMs: 150 });
    expect(Date.now() - started).toBeLessThan(300);
    expect(res.fastPath).toBe(true);
  });
});

describe("coach budgets", () => {
  it("stops the model loop well inside the phone's deadline", () => {
    // Grounding, the verify call and the writes run after the loop, then the response has to
    // travel. 2026-09-23 measured 11 s for that tail on a bad turn and ~2-3 s on ordinary ones.
    expect(TURN_LIMITS.wallClockMs).toBeLessThanOrEqual(DEADLINES.coach - 8_000);
  });

  it("finishes the reply, grounding included, before the phone gives up", () => {
    expect(TURN_REPLY_DEADLINE_MS).toBeGreaterThan(TURN_LIMITS.wallClockMs);
    // Persisting the turn and sending the response still have to fit after it.
    expect(TURN_REPLY_DEADLINE_MS).toBeLessThanOrEqual(DEADLINES.coach - 3_000);
  });

  it("never gives one model call the whole turn", () => {
    expect(PER_CALL_TIMEOUT_MS).toBeLessThan(TURN_LIMITS.wallClockMs);
  });
});
