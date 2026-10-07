/**
 * Sol review r1 of the request-deadline follow-up (2026-09-23). A 503 sent while a save is still
 * running must be safe to retry: the phone retries with the SAME messageId, a turn saved halfway is
 * never replayed as complete, and a concurrent duplicate answers a retryable 503, not a 500.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialChatState, nextChatState } from "@/lib/coach/chat-state";
import { persist, storedTurn, type MessageRow } from "@/lib/server/coach-threads";
import { runTurn } from "@/tests/coach/fixtures/run-turn";
import { TURN_SAVE_DEADLINE_MS } from "@/lib/coach/turn";

const MESSAGE = "3f1b1a2c-0000-4000-8000-000000000050";
const THREAD = "3f1b1a2c-0000-4000-8000-000000000051";
const model = { provider: "gemini" as const, modelId: "" };

function db(tables: Record<string, unknown[]>, insertError: unknown = null,
  inserted: unknown[] = []) {
  const chain: Record<string, unknown> = {};
  let table = "";
  Object.assign(chain, {
    select: () => chain, eq: () => chain, gte: () => chain, order: () => chain,
    update: () => chain,
    insert: (row: unknown) => { inserted.push(row); return Promise.resolve({ error: insertError }); },
    maybeSingle: async () => ({ data: (tables[table] ?? [])[0] ?? null, error: null }),
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: tables[table] ?? [], error: null }).then(resolve),
  });
  return { from: (name: string) => { table = name; return chain; } } as never;
}

const userRow = (createdAt: string) => ({ id: MESSAGE, thread_id: THREAD, role: "user",
  content: "hi", seq: 1, created_at: createdAt, tool_calls: [] });

describe("replaying a turn that was only half saved", () => {
  it("answers a retryable 503 while the assistant row may still be landing", async () => {
    const now = new Date().toISOString();
    await expect(storedTurn(db({ coach_messages: [userRow(now)] }), "u1", MESSAGE, model))
      .rejects.toMatchObject({ status: 503, code: "in_progress" });
  });

  it("saves, then replays, an honest reply for a long-abandoned half turn", async () => {
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    const inserted: unknown[] = [];
    const replay = await storedTurn(db({ coach_messages: [userRow(old)] }, null, inserted),
      "u1", MESSAGE, model);
    expect(replay?.messages.at(-1)).toMatchObject({ role: "assistant", seq: 2 });
    expect(replay?.messages.at(-1)?.content).toContain("could not finish");
    expect(inserted).toEqual([expect.objectContaining({ role: "assistant", seq: 2,
      thread_id: THREAD, content: expect.stringContaining("could not finish") })]);
  });

  it("answers the abandoned turn without saving when a later message holds its seq (Sol r3)", async () => {
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    const inserted: unknown[] = [];
    const rows = [userRow(old),
      { id: "later-user", thread_id: THREAD, role: "user", content: "next", seq: 2, tool_calls: [] }];
    const replay = await storedTurn(db({ coach_messages: rows }, null, inserted), "u1", MESSAGE, model);
    expect(inserted).toEqual([]);
    expect(replay?.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "hi"], ["assistant", expect.stringContaining("could not finish")]]);
  });

  it("answers the abandoned turn without a retry loop when its seq is taken meanwhile", async () => {
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    const replay = await storedTurn(db({ coach_messages: [userRow(old)] },
      { code: "23505", message: "duplicate key" }), "u1", MESSAGE, model);
    expect(replay?.messages.at(-1)?.content).toContain("could not finish");
  });

  it("never replays a LATER turn's reply as this one's", async () => {
    const now = new Date().toISOString();
    const later = [userRow(now),
      { id: "later-user", thread_id: THREAD, role: "user", content: "next", seq: 3, tool_calls: [] },
      { id: "later-reply", thread_id: THREAD, role: "assistant", content: "Later.", seq: 4,
        tool_calls: [] }];
    await expect(storedTurn(db({ coach_messages: later }), "u1", MESSAGE, model))
      .rejects.toMatchObject({ status: 503, code: "in_progress" });
  });
});

describe("a concurrent attempt at the same message", () => {
  it("answers a retryable 503 instead of a 500 when the row already exists", async () => {
    const rows = [{ id: MESSAGE, thread_id: THREAD, user_id: "u1", role: "user", content: "hi",
      seq: 1, tool_calls: [], policy_checks: [], deflected: false, model_id: null,
      ai_call_id: null }] as MessageRow[];
    await expect(persist(db({}, { code: "23505", message: "duplicate key" }), THREAD, rows, null))
      .rejects.toMatchObject({ status: 503, code: "in_progress" });
  });
});

describe("the phone's Retry", () => {
  it("keeps the failed turn's messageId so the retry replays it", () => {
    const sent = nextChatState(initialChatState(null), { type: "send", messageId: MESSAGE, text: "hi" });
    const failed = nextChatState(sent, { type: "error", status: 503, code: "timeout",
      message: "Sasha did not answer in time. Try again.", messageId: MESSAGE });
    expect(failed.retryable).toBe(true);
    expect(failed.pendingMessageId).toBe(MESSAGE);
  });
});

describe("the attachment branch", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.stubEnv("COACH_ENABLED", "1"); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it("answers a retryable 503 by the save deadline when it stalls", async () => {
    const stalled = { from: () => { throw new Error("unused"); } } as never;
    const neverDb = {
      from: () => {
        const chain: Record<string, unknown> = {};
        Object.assign(chain, { select: () => chain, eq: () => chain, gte: () => chain,
          order: () => chain, then: () => new Promise(() => {}) });
        return chain;
      },
    } as never;
    let outcome: unknown = "pending";
    runTurn(stalled, neverDb, "u1", { threadId: null, messageId: MESSAGE, text: "",
      attachment: { kind: "photo", path: "u1/x.jpg" } } as never,
    { startedAt: Date.now(), newId: () => THREAD }).then(
      (value) => { outcome = { value }; }, (error) => { outcome = { error }; });
    await vi.advanceTimersByTimeAsync(TURN_SAVE_DEADLINE_MS);
    expect(outcome).toMatchObject({ error: { status: 503, code: "timeout" } });
  });
});
