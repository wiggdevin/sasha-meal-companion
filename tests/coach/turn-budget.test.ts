/**
 * W035 (audit A159, A116, A152): the coach turn budget counts turns, not model steps, whatever
 * provider answers; the check and the reserve are one atomic limiter hit; it fails closed; a
 * replay of a saved turn never spends a slot; and an OpenRouter-served reply links its own
 * `coach-openrouter` ai_calls row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withSpendRpc } from "@/tests/ai/spend-admin";
import { runTurn } from "@/tests/coach/fixtures/run-turn";
import { CoachRateLimited, reserveTurn, TURNS_PER_DAY, TURNS_PER_HOUR } from "@/lib/server/coach";
import { memoryRateLimitStore, setRateLimitStore, type RateLimitStore }
  from "@/lib/server/ratelimit";

vi.mock("@/lib/ai/lanes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/lanes")>();
  return { ...actual, OPENROUTER_PINS: { ...actual.OPENROUTER_PINS,
    coachFallback: "openai/gpt-5-mini" } };
});

const REQ = { threadId: null, messageId: "3f1b1a2c-0000-4000-8000-000000000350",
  text: "what should I eat", now: "2026-09-16T15:00:00.000Z", tz: "America/Denver" };
const HOUR_KEY = "coach:turn:hour:user:u1";
const DAY_KEY = "coach:turn:day:user:u1";

type Row = Record<string, unknown>;

/** A recording store over the in-memory windows: every hit's key, in order. */
function recordingStore(): RateLimitStore & { keys: string[] } {
  const inner = memoryRateLimitStore();
  const keys: string[] = [];
  return { keys, hit: (key, limit, windowSeconds) => {
    keys.push(key);
    return inner.hit(key, limit, windowSeconds);
  } };
}

/**
 * A Supabase double whose `ai_calls` reads honour eq/in and newest-first order, so the reply's
 * ai_call link is read the way the database answers it. Other tables answer their rows unfiltered.
 */
function db(tables: Record<string, Row[]>, writes: { table: string; row: Row }[]) {
  const api = (table: string) => {
    const eqs: [string, unknown][] = [];
    const ins: [string, readonly unknown[]][] = [];
    const rows = () => (tables[table] ?? []).filter((row) => table !== "ai_calls"
      || (eqs.every(([col, val]) => row[col] === val)
        && ins.every(([col, vals]) => vals.includes(row[col]))))
      .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain, neq: () => chain, lte: () => chain, is: () => chain, gte: () => chain,
      order: () => chain, limit: () => chain,
      eq: (col: string, val: unknown) => { eqs.push([col, val]); return chain; },
      in: (col: string, vals: readonly unknown[]) => { ins.push([col, vals]); return chain; },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      single: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (resolve: (v: { data: Row[]; error: null }) => unknown) =>
        Promise.resolve({ data: rows(), error: null }).then(resolve),
      insert: (row: Row) => { writes.push({ table, row }); return chain; },
      update: (row: Row) => { writes.push({ table, row }); return chain; },
    });
    return chain;
  };
  return withSpendRpc({ from: (t: string) => api(t), rpc: async () => ({ data: [], error: null }) }) as never;
}

const ports = {
  dayTotals: async () => ({ local_date: "2026-09-16", nutrients: [] }),
  weekTotals: async () => [],
  activeTargets: async () => ({ kcal_train: 2200 }),
  latestEstimate: async () => ({ status: "burn_in" }),
  searchFoods: async () => [],
  getConstraints: async () => ({ avoid_allergens: [] }),
  recentGut: async () => [],
  newDraftId: () => "draft-1",
};

const noClassify = () => vi.fn().mockResolvedValue(null) as never;

describe("reserveTurn (W035)", () => {
  let store: ReturnType<typeof recordingStore>;
  beforeEach(() => { store = recordingStore(); setRateLimitStore(store); });
  afterEach(() => { setRateLimitStore(null); vi.useRealTimers(); });

  it("allows ten turns an hour and refuses the eleventh with a retry time", async () => {
    for (let i = 0; i < TURNS_PER_HOUR; i += 1) await reserveTurn("u1");
    const error = await reserveTurn("u1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CoachRateLimited);
    expect((error as CoachRateLimited).status).toBe(429);
    expect((error as CoachRateLimited).retryAfterSeconds).toBeGreaterThan(0);
    // The hour refused it, so it spent no day slot.
    expect(store.keys.filter((k) => k === DAY_KEY)).toHaveLength(TURNS_PER_HOUR);
  });

  it("allows sixty turns a day and refuses the sixty-first in a fresh hour", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-10-11T00:00:00.000Z"));
    for (let hour = 0; hour < TURNS_PER_DAY / TURNS_PER_HOUR; hour += 1) {
      for (let i = 0; i < TURNS_PER_HOUR; i += 1) await reserveTurn("u1");
      vi.advanceTimersByTime(3_600_000);
    }
    const error = await reserveTurn("u1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CoachRateLimited);
    expect(store.keys.at(-1)).toBe(DAY_KEY);
  });

  it("fails closed with 503 rate_limit_unavailable when the limiter cannot answer", async () => {
    setRateLimitStore({ hit: async () => { throw new Error("db down"); } });
    await expect(reserveTurn("u1")).rejects.toMatchObject({
      status: 503, code: "rate_limit_unavailable" });
  });

  it("keeps each account's budget its own", async () => {
    for (let i = 0; i < TURNS_PER_HOUR; i += 1) await reserveTurn("u1");
    await expect(reserveTurn("u2")).resolves.toBeUndefined();
  });
});

describe("a coach turn spends exactly one slot (W035)", () => {
  let store: ReturnType<typeof recordingStore>;
  beforeEach(() => {
    store = recordingStore();
    setRateLimitStore(store);
    vi.stubEnv("COACH_ENABLED", "1");
  });
  afterEach(() => { setRateLimitStore(null); vi.unstubAllEnvs(); });

  it("counts a tool step, a second tool step and the final step as one turn", async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce({ kind: "tool", calls: [{ name: "get_day", args: { date: "2026-09-16" } }] })
      .mockResolvedValueOnce({ kind: "tool", calls: [{ name: "get_day", args: { date: "2026-09-15" } }] })
      .mockResolvedValueOnce({ kind: "final", text: "Eat rice." });
    const writes: { table: string; row: Row }[] = [];
    await runTurn(db({}, writes), db({}, writes), "u1", REQ,
      { generate: generate as never, ports, classifyIntent: noClassify(), newId: () => "id-1" });
    expect(generate).toHaveBeenCalledTimes(3);
    expect(store.keys).toEqual([HOUR_KEY, DAY_KEY]);
  });

  it("counts an OpenRouter-served turn and links its coach-openrouter ai_calls row", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    vi.stubEnv("OPENROUTER_ATTESTED", "1");
    const generate = vi.fn(async () => {
      throw new Error("429 RESOURCE_EXHAUSTED: You exceeded your current quota");
    });
    const generateOpenRouter = vi.fn(async () => ({ kind: "final", text: "OpenRouter answered." }));
    const writes: { table: string; row: Row }[] = [];
    // An older Gemini row and this turn's OpenRouter row: the reply links the newest coach row
    // of either purpose, never the stale Gemini one.
    const adminTables = { ai_calls: [
      { id: "call-gemini-old", user_id: "u1", status: "ok", purpose: "coach",
        created_at: "2026-09-16T14:00:00.000Z" },
      { id: "call-openrouter", user_id: "u1", status: "ok", purpose: "coach-openrouter",
        created_at: "2026-09-16T15:00:01.000Z" },
      { id: "call-other", user_id: "u1", status: "ok", purpose: "weeklyReview",
        created_at: "2026-09-16T15:00:02.000Z" },
    ] };
    const res = await runTurn(db({}, writes), db(adminTables, writes), "u1", REQ,
      { generate: generate as never, generateOpenRouter: generateOpenRouter as never, ports,
        classifyIntent: noClassify(), newId: () => "3f1b1a2c-0000-4000-8000-0000000003b1" });
    expect(res.model).toMatchObject({ provider: "openrouter" });
    expect(store.keys).toEqual([HOUR_KEY, DAY_KEY]);
    const assistant = writes.filter((w) => w.table === "coach_messages")
      .map((w) => w.row).find((row) => row.role === "assistant");
    expect(assistant?.ai_call_id).toBe("call-openrouter");
  });

  it("refuses the eleventh turn of the hour before any model call or write", async () => {
    for (let i = 0; i < TURNS_PER_HOUR; i += 1) await reserveTurn("u1");
    const generate = vi.fn();
    const writes: { table: string; row: Row }[] = [];
    const error = await runTurn(db({}, writes), db({}, writes), "u1", REQ,
      { generate: generate as never, ports, classifyIntent: noClassify(), newId: () => "id-1" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CoachRateLimited);
    expect(generate).not.toHaveBeenCalled();
    expect(writes.filter((w) => w.table === "coach_messages")).toEqual([]);
  });

  it("spends no slot on a request for a thread that is not the caller's", async () => {
    const generate = vi.fn();
    const error = await runTurn(db({}, []), db({}, []), "u1",
      { ...REQ, threadId: "3f1b1a2c-0000-4000-8000-0000000003ff" },
      { generate: generate as never, ports, classifyIntent: noClassify(), newId: () => "id-1" })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 404 });
    expect(store.keys).toEqual([]);
  });

  it("replays a saved turn without spending a slot, even with the hour used up", async () => {
    for (let i = 0; i < TURNS_PER_HOUR; i += 1) await reserveTurn("u1");
    const spent = store.keys.length;
    const tables = { coach_threads: [{ id: "thread-1", kind: "chat" }], coach_messages: [
      { id: REQ.messageId, thread_id: "thread-1", user_id: "u1", role: "user",
        content: REQ.text, seq: 1, tool_calls: [] },
      { id: "assistant-1", thread_id: "thread-1", user_id: "u1", role: "assistant",
        content: "Eat rice.", seq: 2, tool_calls: [] },
    ] };
    const generate = vi.fn();
    const res = await runTurn(db(tables, []), db(tables, []), "u1", REQ,
      { generate: generate as never, ports, newId: () => "id-1" });
    expect(res.threadId).toBe("thread-1");
    expect(generate).not.toHaveBeenCalled();
    expect(store.keys).toHaveLength(spent);
  });
});
