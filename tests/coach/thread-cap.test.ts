import { describe, expect, it } from "vitest";
import { assertChatCapacity, persist, resolveThread, storedTurn, type MessageRow }
  from "@/lib/server/coach-threads";

const THREAD = "3f1b1a2c-0000-4000-8000-000000000001";
const rows: MessageRow[] = [{ id: "m1", thread_id: THREAD, user_id: "u1", role: "user",
  content: "hi", seq: 1, tool_calls: [], policy_checks: [], deflected: false,
  model_id: null, ai_call_id: null }];

describe("saved chat cap and private plan kind", () => {
  it("blocks a ninth chat before a model call; legacy 9+ remain intact", async () => {
    const filters: Record<string, unknown> = {};
    const chain = {
      select: () => chain,
      eq: (key: string, value: unknown) => { filters[key] = value; return chain; },
      is: (key: string, value: unknown) => { filters[key] = value; return chain; },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ count: 9, error: null }).then(resolve),
    };
    await expect(assertChatCapacity({ from: () => chain } as never, "u1"))
      .rejects.toMatchObject({ status: 409, code: "chat_limit" });
    expect(filters).toEqual({ user_id: "u1", kind: "chat", deleted_at: null });
  });

  it("maps the database's atomic-cap failure to an actionable 409 without saving messages", async () => {
    // W088: the thread and the turn are one transaction, so the cap's refusal saves neither.
    const calls: string[] = [];
    const admin = { rpc: async (fn: string) => { calls.push(fn); return { data: null, error: {
      code: "P0001", message: "coach_chat_limit",
    } }; } } as never;
    await expect(persist({} as never, THREAD, rows, "hi", undefined, "chat", admin))
      .rejects.toMatchObject({ status: 409, code: "chat_limit" });
    expect(calls).toEqual(["coach_save_turn"]);
  });

  it("creates a PlanSheet thread through the server client, outside the chat cap", async () => {
    const calls: { fn: string; args: Record<string, unknown> }[] = [];
    const admin = { rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return { data: [{ id: "m1", seq: 1 }], error: null };
    } } as never;
    await persist({} as never, THREAD, rows, "Meal ideas", null, "plan", admin);
    expect(calls).toEqual([{ fn: "coach_save_turn", args: { p_user_id: "u1", p_thread_id: THREAD,
      p_kind: "plan", p_new_title: "Meal ideas", p_rows: rows, p_summary: null } }]);
  });

  it("cannot continue a plan thread as an ordinary chat", async () => {
    const client = { from: () => {
      const chain = {
        select: () => chain, eq: () => chain, is: () => chain,
        maybeSingle: async () => ({ data: { id: THREAD, kind: "plan" }, error: null }),
      };
      return chain;
    } } as never;
    await expect(resolveThread(client, "u1", THREAD, () => "new", "chat"))
      .rejects.toMatchObject({ status: 404 });
    await expect(resolveThread(client, "u1", THREAD, () => "new", "plan"))
      .resolves.toBe(THREAD);
  });

  it("never replays a plan, deleted, or mismatched turn as an active chat", async () => {
    const client = (kind: string | null, role: "user" | "assistant" = "user") => ({ from: (table: string) => {
      const chain = {
        select: () => chain, eq: () => chain, is: () => chain,
        maybeSingle: async () => ({ data: table === "coach_messages"
          ? { id: "m1", thread_id: THREAD, role, content: "hi", seq: 1 }
          : kind ? { id: THREAD, kind } : null, error: null }),
      };
      return chain;
    } }) as never;
    const model = { provider: "gemini" as const, modelId: "" };
    for (const source of [client("plan"), client(null), client("chat", "assistant")]) {
      await expect(storedTurn(source, source, "u1", "m1", model,
        { threadId: null, kind: "chat" })).rejects.toMatchObject({ status: 404 });
    }
    await expect(storedTurn(client("chat"), client("chat"), "u1", "m1", model,
      { threadId: "3f1b1a2c-0000-4000-8000-000000000099", kind: "chat" }))
      .rejects.toMatchObject({ status: 404 });
  });

  it("continues the weekly-review thread like a chat, never as a plan thread", async () => {
    const client = { from: () => {
      const chain = {
        select: () => chain, eq: () => chain, is: () => chain,
        maybeSingle: async () => ({ data: { id: THREAD, kind: "weekly_review" }, error: null }),
      };
      return chain;
    } } as never;
    await expect(resolveThread(client, "u1", THREAD, () => "new", "chat")).resolves.toBe(THREAD);
    await expect(resolveThread(client, "u1", THREAD, () => "new")).resolves.toBe(THREAD);
    await expect(resolveThread(client, "u1", THREAD, () => "new", "plan"))
      .rejects.toMatchObject({ status: 404 });
  });

  it("replays a reply saved in the weekly-review thread as that same turn", async () => {
    const client = { from: (table: string) => {
      const chain = {
        select: () => chain, eq: () => chain, is: () => chain, gte: () => chain, order: () => chain,
        maybeSingle: async () => ({ data: table === "coach_messages"
          ? { id: "m1", thread_id: THREAD, role: "user", content: "why?", seq: 2 }
          : { id: THREAD, kind: "weekly_review" }, error: null }),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [
          { id: "m1", role: "user", content: "why?", seq: 2, tool_calls: [] },
          { id: "m2", role: "assistant", content: "Because…", seq: 3, tool_calls: [] },
        ], error: null }).then(resolve),
      };
      return chain;
    } } as never;
    const model = { provider: "gemini" as const, modelId: "" };
    const replay = await storedTurn(client, client, "u1", "m1", model, { threadId: THREAD, kind: "chat" });
    expect(replay?.threadId).toBe(THREAD);
    expect(replay?.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    await expect(storedTurn(client, client, "u1", "m1", model, { threadId: THREAD, kind: "plan" }))
      .rejects.toMatchObject({ status: 404 });
  });
});
