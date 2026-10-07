/**
 * 2026-10-02 DeepSeek audit: lib/server/coach-turn/history-recall.ts hard-coded the synthesis
 * reply's provider as "gemini" even though lib/server/coach-turn.ts (coachModel.synthesizeHistory)
 * already routes that same call to OpenRouter when COACH_PROVIDER=openrouter — the stored model
 * and the response's `model` field must say which provider actually answered, the same
 * isOpenRouterModelId expression lib/server/coach-turn/reply.ts already uses for the ordinary
 * model loop.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/lanes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/lanes")>();
  return { ...actual, OPENROUTER_PINS: { ...actual.OPENROUTER_PINS,
    coach: "openai/gpt-5-mini" } };
});

// Each case resets the module registry and re-imports the coach graph (~1.2 s alone); under the
// full suite's load that passed 5 s. A slow import is not a failure (2026-10-02).
vi.setConfig({ testTimeout: 20_000 });

const SOURCE = "3f1b1a2c-0000-4000-8000-000000000002";
const SOURCE_MESSAGE = "3f1b1a2c-0000-4000-8000-000000000003";
const MESSAGE = "3f1b1a2c-0000-4000-8000-000000000004";
const NEW_THREAD = "3f1b1a2c-0000-4000-8000-000000000005";
const REPLY = "3f1b1a2c-0000-4000-8000-000000000006";
const OPENROUTER_MODEL = "openai/gpt-5-mini";

/** Same shape as tests/coach/run-turn-history.test.ts's double: one saved thread with one
 *  searchable message, so a selected-conversation recall has something to synthesize over. */
function database() {
  const tables: Record<string, Record<string, unknown>[]> = {
    coach_threads: [{ id: SOURCE, user_id: "u1", title: "Food ideas", kind: "chat", deleted_at: null }],
    coach_messages: [{ id: SOURCE_MESSAGE, thread_id: SOURCE, user_id: "u1", role: "user",
      content: "I enjoy tofu for breakfast.", seq: 1, created_at: "2026-09-25T14:00:00Z",
      tool_calls: [] }],
  };
  const from = (table: string) => {
    const read = { table, filters: {} as Record<string, unknown> };
    let limit = 1000;
    let descending = false;
    let search: string | null = null;
    let minSeq = 0;
    let maxSeq = Infinity;
    const result = () => {
      let data = (tables[table] ?? []).filter((row) => Object.entries(read.filters)
        .every(([field, value]) => row[field] === value
          || (field === "deleted_at" && value === null && row[field] === undefined)))
        .filter((row) => typeof row.seq !== "number" || (row.seq >= minSeq && row.seq <= maxSeq))
        .filter((row) => !search || search.split(" OR ").some((term) =>
          String(row.content).toLowerCase().includes(term)));
      if (descending) data = [...data].reverse();
      return { data: data.slice(0, limit), count: null, error: null };
    };
    const chain = {
      select: () => chain,
      eq: (field: string, value: unknown) => { read.filters[field] = value; return chain; },
      in: () => chain,
      is: (field: string, value: unknown) => { read.filters[field] = value; return chain; },
      gte: (_field: string, value: number) => { minSeq = value; return chain; },
      lte: (_field: string, value: number) => { maxSeq = value; return chain; },
      textSearch: (_field: string, value: string) => { search = value; return chain; },
      order: (_field: string, opts: { ascending: boolean }) => {
        descending = !opts.ascending; return chain;
      },
      limit: (n: number) => { limit = n; return chain; },
      maybeSingle: async () => ({ data: result().data[0] ?? null, error: null }),
      insert: (row: Record<string, unknown>) => { (tables[table] ??= []).push(row); return chain; },
      update: (_patch: unknown) => chain,
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve),
    };
    return chain;
  };
  return { client: { from, rpc: async () => ({ data: [], error: null }) } as never, tables };
}

describe("history-recall synthesis records which provider actually answered (2026-10-02 DeepSeek audit)", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it("records \"openrouter\", not \"gemini\", when COACH_PROVIDER=openrouter synthesized the answer", async () => {
    vi.stubEnv("COACH_ENABLED", "1");
    vi.stubEnv("COACH_PROVIDER", "openrouter");
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    vi.stubEnv("OPENROUTER_ATTESTED", "1");
    vi.resetModules();
    const { runTurn } = await import("@/lib/server/coach-turn");

    const db = database();
    const generate = vi.fn();
    const generateOpenRouter = vi.fn().mockResolvedValue({
      answer: "You said you enjoy tofu for breakfast. [1]",
    });
    const ids = [NEW_THREAD, REPLY];
    const request = { threadId: null, messageId: MESSAGE,
      text: "What did I say about tofu in the other chat?", historySourceThreadId: SOURCE };

    const res = await runTurn(db.client, db.client, "u1", request, {
      generate: generate as never, generateOpenRouter: generateOpenRouter as never,
      newId: () => ids.shift()!, now: () => Date.now(),
    });

    expect(generateOpenRouter).toHaveBeenCalledTimes(1);
    expect(generate).not.toHaveBeenCalled();
    expect(res.messages[1].content).toContain("tofu for breakfast. [1]");
    expect(res.model).toMatchObject({ provider: "openrouter", modelId: OPENROUTER_MODEL });
  });
});
