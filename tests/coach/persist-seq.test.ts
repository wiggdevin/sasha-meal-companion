/**
 * W035 (audit A151): two turns on one thread read the same next seq. The loser's save used to
 * answer a false 503 "in_progress" after its model call was billed, and the retry ran the whole
 * turn again. A seq conflict now saves the turn after the thread's new last seq; only the same
 * message id already saved is still "in progress".
 *
 * W018: every attempt writes the user's question with the session client and the reply with the
 * service role, and a landed question is removed with the session client, which migration
 * 20261231170000 still lets delete the caller's own rows.
 */
import { describe, expect, it } from "vitest";
import { persist, type MessageRow } from "@/lib/server/coach-threads";

type Row = Record<string, unknown>;

/**
 * coach_messages with its two unique keys (id, and thread_id + seq), as Postgres refuses them. The
 * session client and the service role share the one table; each write records which side ran it.
 */
function messagesDb(initial: Row[] = [], opts: { beforeInsert?: (row: Row) => void } = {}) {
  const rows: Row[] = [...initial];
  const deletes: unknown[][] = [];
  const writes: [side: string, op: string, id: unknown][] = [];
  const from = (side: string) => (table: string) => {
    const chain: Record<string, unknown> = {};
    let deleting = false;
    Object.assign(chain, {
      select: () => chain, order: () => chain, limit: () => chain,
      eq: () => chain,
      in: (_col: string, ids: unknown[]) => {
        if (deleting) {
          deletes.push(ids);
          for (const id of ids) writes.push([side, "delete", id]);
          for (const id of ids) rows.splice(rows.findIndex((r) => r.id === id), 1);
        }
        return chain;
      },
      delete: () => { deleting = true; return chain; },
      update: () => chain,
      // nextSeq: the thread's highest seq.
      maybeSingle: async () => ({ data: [...rows].sort((a, b) => Number(b.seq) - Number(a.seq))[0]
        ?? null, error: null }),
      insert: (row: Row) => {
        if (table !== "coach_messages") return Promise.resolve({ error: null });
        opts.beforeInsert?.(row);
        writes.push([side, "insert", row.id]);
        if (rows.some((r) => r.id === row.id)) {
          return Promise.resolve({ error: { code: "23505",
            message: "duplicate key value violates unique constraint \"coach_messages_pkey\"" } });
        }
        if (rows.some((r) => r.thread_id === row.thread_id && r.seq === row.seq)) {
          return Promise.resolve({ error: { code: "23505",
            message: "duplicate key value violates unique constraint \"coach_messages_thread_seq\"" } });
        }
        rows.push(row);
        return Promise.resolve({ error: null });
      },
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
    });
    return chain;
  };
  return { client: { from: from("session") } as never, admin: { from: from("admin") } as never,
    rows, deletes, writes };
}

const row = (id: string, role: "user" | "assistant", seq: number): MessageRow => ({
  id, thread_id: "t1", user_id: "u1", role, content: id, seq, tool_calls: [], policy_checks: [],
  deflected: false, model_id: null, ai_call_id: null,
});

describe("persist: a seq another turn took first (W035, A151)", () => {
  it("saves the turn after the other turn's rows instead of answering 503", async () => {
    // The other turn saved seq 5 and 6 between this turn's seq read (5) and its save.
    const { client, admin, rows } = messagesDb([row("other-user", "user", 5), row("other-reply", "assistant", 6)]);
    const saved = await persist(client, "t1", [row("mine", "user", 5), row("mine-reply", "assistant", 6)], null,
      undefined, "chat", admin);
    expect(saved.map((r) => [r.id, r.seq])).toEqual([["mine", 7], ["mine-reply", 8]]);
    expect(rows.map((r) => [r.id, r.seq])).toEqual([
      ["other-user", 5], ["other-reply", 6], ["mine", 7], ["mine-reply", 8]]);
  });

  it("removes its own user row when the reply's seq was taken, and saves the pair together", async () => {
    // The other turn's user row takes seq 6 just after this turn's user row lands at 5.
    const db = messagesDb([], { beforeInsert: (r) => {
      if (r.id === "mine-reply" && r.seq === 6) {
        db.rows.push(row("other-user", "user", 6));
      }
    } });
    const saved = await persist(db.client, "t1",
      [row("mine", "user", 5), row("mine-reply", "assistant", 6)], null, undefined, "chat", db.admin);
    expect(db.deletes).toEqual([["mine"]]);
    // A replay pairs the user row at N with the reply at N + 1, so they stay consecutive.
    expect(saved.map((r) => r.seq)).toEqual([7, 8]);
    expect(db.rows.map((r) => [r.id, r.seq])).toEqual([["other-user", 6], ["mine", 7], ["mine-reply", 8]]);
  });

  it("still answers 503 in_progress when the same message id is already saved", async () => {
    const { client, admin } = messagesDb([row("mine", "user", 5)]);
    await expect(persist(client, "t1", [row("mine", "user", 6), row("mine-reply", "assistant", 7)], null,
      undefined, "chat", admin))
      .rejects.toMatchObject({ status: 503, code: "in_progress" });
  });

  it("gives up with 503 in_progress after three seq conflicts in a row", async () => {
    const db = messagesDb([], { beforeInsert: (r) => {
      // Another turn always lands at exactly the seq this one tries.
      if (r.id === "mine") db.rows.push(row(`other-${String(r.seq)}`, "user", Number(r.seq)));
    } });
    await expect(persist(db.client, "t1", [row("mine", "user", 1), row("mine-reply", "assistant", 2)], null,
      undefined, "chat", db.admin))
      .rejects.toMatchObject({ status: 503, code: "in_progress" });
  });

  it("retries with the same writers: the question on the session client, the reply on the service role (W018)", async () => {
    const db = messagesDb([], { beforeInsert: (r) => {
      if (r.id === "mine-reply" && r.seq === 6) db.rows.push(row("other-user", "user", 6));
    } });
    await persist(db.client, "t1", [row("mine", "user", 5), row("mine-reply", "assistant", 6)], null,
      undefined, "chat", db.admin);
    expect(db.writes).toEqual([
      ["session", "insert", "mine"], ["admin", "insert", "mine-reply"],
      // The landed question is removed by the session client: the caller's own row in its own thread.
      ["session", "delete", "mine"],
      ["session", "insert", "mine"], ["admin", "insert", "mine-reply"],
    ]);
  });
});
