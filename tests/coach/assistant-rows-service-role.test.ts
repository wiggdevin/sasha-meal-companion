/**
 * W018 (audit 2026-10-10 P16): migration 20261231170000 lets a signed-in user insert only the caller's own
 * `role = 'user'` coach rows and never update one. So the code must write every assistant row, and
 * the sanity write-back that patches one, with the service-role client; the user's own question
 * stays on the caller's session client, where RLS proves the thread is that account's.
 */
import { describe, expect, it } from "vitest";
import { persist, storedTurn, type MessageRow } from "@/lib/server/coach-threads";
import { startPersistedCoachSanity } from "@/lib/server/coach-sanity";

const THREAD = "3f1b1a2c-0000-4000-8000-000000000071";
type Write = { side: string; table: string; op: string; row: unknown };

function recorder(side: string, writes: Write[], tables: Record<string, unknown[]> = {}) {
  let table = "";
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    select: () => chain, eq: () => chain, is: () => chain, gte: () => chain, order: () => chain,
    insert: (row: unknown) => {
      writes.push({ side, table, op: "insert", row });
      return Promise.resolve({ error: null });
    },
    update: (row: unknown) => { writes.push({ side, table, op: "update", row }); return chain; },
    maybeSingle: async () => ({ data: (tables[table] ?? [])[0] ?? null, error: null }),
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: tables[table] ?? [], error: null }).then(resolve),
  });
  return { from: (name: string) => { table = name; return chain; } } as never;
}

const row = (role: "user" | "assistant", id: string, seq: number, user = "u1"): MessageRow => ({
  id, thread_id: THREAD, user_id: user, role, content: role, seq, tool_calls: [],
  policy_checks: [], deflected: false, model_id: null, ai_call_id: null,
});

describe("assistant coach rows go through the service role (W018)", () => {
  it("persist writes the question with the session client and the reply with the admin client", async () => {
    const writes: Write[] = [];
    await persist(recorder("user", writes), THREAD, [row("user", "q", 1), row("assistant", "a", 2)],
      null, undefined, "chat", recorder("admin", writes));
    expect(writes.filter((w) => w.table === "coach_messages").map((w) => [w.side, (w.row as MessageRow).role]))
      .toEqual([["user", "user"], ["admin", "assistant"]]);
  });

  it("persist saves no reply that is not anchored by an earlier question of the same thread and account", async () => {
    for (const rows of [[row("assistant", "a", 2)], [row("assistant", "a", 2), row("user", "q", 1)],
      [row("user", "q", 1, "u2"), row("assistant", "a", 2)]]) {
      const writes: Write[] = [];
      await expect(persist(recorder("user", writes), THREAD, rows, null, undefined, "chat",
        recorder("admin", writes))).rejects.toMatchObject({ status: 500 });
      expect(writes).toEqual([]);
    }
  });

  it("storedTurn saves an abandoned turn's reply with the admin client only", async () => {
    const writes: Write[] = [];
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    const session = recorder("user", writes, { coach_messages: [
      { id: "q", thread_id: THREAD, role: "user", content: "hi", seq: 1, created_at: old }] });
    const replay = await storedTurn(session, recorder("admin", writes), "u1", "q",
      { provider: "gemini", modelId: "" });
    expect(replay?.messages.at(-1)).toMatchObject({ role: "assistant", seq: 2 });
    expect(writes.map((w) => [w.side, w.table, w.op])).toEqual([["admin", "coach_messages", "insert"]]);
  });

  it("the sanity write-back patches the assistant row through the client it is given (the admin)", async () => {
    const writes: Write[] = [];
    const run = startPersistedCoachSanity(recorder("admin", writes), "u1", "a", {
      actions: [{ kind: "log_meal", items: [{ sanity: { status: "pending", warnings: [] } }] }],
    }, AbortSignal.timeout(1_000), {
      check: async () => ({ status: "ok", warnings: [] }) as never,
      schedule: (task) => { void task(); },
    });
    await run.settled;
    expect(writes.map((w) => [w.side, w.table, w.op])).toEqual([["admin", "coach_messages", "update"]]);
  });
});
