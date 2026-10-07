import { beforeEach, describe, expect, it, vi } from "vitest";
import { runTurn } from "@/tests/coach/fixtures/run-turn";

const SOURCE = "3f1b1a2c-0000-4000-8000-000000000002";
const SOURCE_MESSAGE = "3f1b1a2c-0000-4000-8000-000000000003";
const MESSAGE = "3f1b1a2c-0000-4000-8000-000000000004";
const NEW_THREAD = "3f1b1a2c-0000-4000-8000-000000000005";
const REPLY = "3f1b1a2c-0000-4000-8000-000000000006";

function database(messages?: Record<string, unknown>[]) {
  const tables: Record<string, Record<string, unknown>[]> = {
    coach_threads: [{ id: SOURCE, user_id: "u1", title: "Food ideas", kind: "chat", deleted_at: null }],
    coach_messages: messages ?? [{ id: SOURCE_MESSAGE, thread_id: SOURCE, user_id: "u1", role: "user",
      content: "I enjoy tofu for breakfast.", seq: 1, created_at: "2026-09-25T14:00:00Z",
      tool_calls: [] }],
  };
  const reads: { table: string; filters: Record<string, unknown> }[] = [];
  const from = (table: string) => {
    const read = { table, filters: {} as Record<string, unknown> };
    reads.push(read);
    let head = false;
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
      return { data: data.slice(0, limit), count: head ? data.length : null, error: null };
    };
    const chain = {
      select: (_columns: string, options?: { head?: boolean }) => {
        head = options?.head === true; return chain;
      },
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
      insert: (row: Record<string, unknown>) => {
        (tables[table] ??= []).push(row); return chain;
      },
      update: (_patch: unknown) => chain,
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve),
    };
    return chain;
  };
  return { client: { from, rpc: async () => ({ data: [], error: null }) } as never,
    tables, reads };
}

describe("selected same-account conversation recall", () => {
  beforeEach(() => vi.stubEnv("COACH_ENABLED", "1"));

  it("synthesizes over selected saved evidence, saves citations, and replays without a second model", async () => {
    const db = database();
    const generate = vi.fn().mockResolvedValue({
      answer: "You said you enjoy tofu for breakfast. [1]",
    });
    const ids = [NEW_THREAD, REPLY];
    const request = { threadId: null, messageId: MESSAGE,
      text: "What did I say about tofu in the other chat?", historySourceThreadId: SOURCE };
    const first = await runTurn(db.client, db.client, "u1", request, {
      generate: generate as never, newId: () => ids.shift()!, now: () => Date.now(),
    });
    expect(first.messages[1].content).toContain("tofu for breakfast. [1]");
    expect(first.actions).toEqual([]);
    expect(first.messages[1].historySources).toMatchObject([{ id: SOURCE_MESSAGE,
      threadId: SOURCE, seq: 1 }]);
    expect(db.tables.coach_threads.at(-1)).toMatchObject({ id: NEW_THREAD, kind: "chat" });
    expect(db.reads.find((read) => read.table === "coach_messages"
      && read.filters.thread_id === SOURCE)?.filters.user_id).toBe("u1");
    const replay = await runTurn(db.client, db.client, "u1", request, {
      generate: generate as never, newId: () => "unused", now: () => Date.now(),
    });
    expect(replay.messages[1].historySources).toMatchObject([{ id: SOURCE_MESSAGE }]);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("returns 404 for an unowned selected source before a model or saved turn", async () => {
    const db = database();
    const generate = vi.fn();
    await expect(runTurn(db.client, db.client, "u1", {
      threadId: null, messageId: MESSAGE, text: "What did we discuss?",
      historySourceThreadId: "3f1b1a2c-0000-4000-8000-000000000099",
    }, { generate: generate as never, newId: () => NEW_THREAD }))
      .rejects.toMatchObject({ status: 404 });
    expect(generate).not.toHaveBeenCalled();
    expect(db.tables.coach_messages).toHaveLength(1);
  });

  it("answers a past question from adjacent saved turns before food advice policy, without rerouting an action", async () => {
    const texts = ["I am planning a simple breakfast.", "What foods work for you?",
      "Oats with berries sound good tomorrow.", "We can keep breakfast simple."];
    const rows = texts.map((content, index) => ({ id: `${SOURCE_MESSAGE}-${index}`,
      thread_id: SOURCE, user_id: "u1", role: index % 2 ? "assistant" : "user",
      content, seq: index + 1, created_at: "2026-09-25T14:00:00Z", tool_calls: [] }));
    rows.push({ id: "prior-question", thread_id: SOURCE, user_id: "u1", role: "user",
      content: "What was my breakfast idea?", seq: 5,
      created_at: "2026-09-25T14:05:00Z", tool_calls: [] });
    rows.push({ id: "prior-failure", thread_id: SOURCE, user_id: "u1", role: "assistant",
      content: "I couldn’t work that one out. Try naming the meal or food you mean.", seq: 6,
      created_at: "2026-09-25T14:06:00Z", tool_calls: [] });
    const db = database(rows);
    // The normal response would be unsafe food prose. A past-chat read must not pass it
    // through the recommendation-policy lane or replace the saved quote with a generic re-ask.
    const generate = vi.fn().mockResolvedValue({ kind: "final",
      text: "Your idea was oats with berries.", suggestions: [{ name: "oats" }, { name: "berries" }] });
    const ids = ["question-reply", "action-reply"];
    const first = await runTurn(db.client, db.client, "u1", {
      threadId: SOURCE, messageId: MESSAGE, text: "What was my breakfast idea?",
    }, { generate: generate as never, classifyIntent: vi.fn().mockResolvedValue(null) as never,
      newId: () => ids.shift()!, now: () => Date.now() });
    expect(first.messages[1].content).toContain("Oats with berries sound good tomorrow.");
    expect(first.messages[1].historySources?.some((source) => source.seq === 3)).toBe(true);
    expect(first.actions).toEqual([]);
    expect(first.suggestions).toEqual([]);
    generate.mockResolvedValue({ kind: "abort", reason: "cannot answer" });
    const second = await runTurn(db.client, db.client, "u1", {
      threadId: SOURCE, messageId: "action-request", text: "Change my breakfast plan to toast.",
    }, { generate: generate as never, classifyIntent: vi.fn().mockResolvedValue(null) as never,
      newId: () => ids.shift()!, now: () => Date.now() });
    expect(second.messages[1].content).toBe("I couldn’t work that one out. Try naming the meal or food you mean.");
    expect(second.messages[1].historySources).toBeUndefined();
    const mixed = await runTurn(db.client, db.client, "u1", {
      threadId: SOURCE, messageId: "mixed-request",
      text: "What did I say about breakfast? Change my plan to toast.",
    }, { generate: generate as never, classifyIntent: vi.fn().mockResolvedValue(null) as never,
      newId: () => "mixed-reply", now: () => Date.now() });
    expect(mixed.messages[1].historySources).toBeUndefined();
  });

  it("does not attach a dietary confirmation card to a quoted past statement", async () => {
    const db = database([{ id: SOURCE_MESSAGE, thread_id: SOURCE, user_id: "u1", role: "user",
      content: "I was vegan last year.", seq: 1, created_at: "2026-09-25T14:00:00Z",
      tool_calls: [] }]);
    const result = await runTurn(db.client, db.client, "u1", {
      threadId: SOURCE, messageId: MESSAGE, text: "What did I say about being vegan?",
    }, { generate: vi.fn().mockResolvedValue({ kind: "abort", reason: "cannot answer" }) as never,
      classifyIntent: vi.fn().mockResolvedValue(null) as never,
      newId: () => REPLY, now: () => Date.now() });
    expect(result.messages[1].content).toContain("I was vegan last year.");
    expect(result.messages[1].historySources).toHaveLength(1);
    expect(result.messages[1].blocks).toBeUndefined();
  });
});
