/**
 * W088 (migration 20270104120000): `persist` saves a turn through one `coach_save_turn` call, so the
 * thread, the rows and the thread touch are one transaction. The seq retry (W035, audit A151) and
 * the "same message id already saved" refusal live in the function; this file holds how `persist`
 * calls it and answers its refusals. tests/migrations/coach-save-turn-db.test.ts runs the SQL.
 */
import { describe, expect, it } from "vitest";
import { persist, type MessageRow } from "@/lib/server/coach-threads";

const row = (id: string, role: "user" | "assistant", seq: number): MessageRow => ({
  id, thread_id: "t1", user_id: "u1", role, content: id, seq, tool_calls: [], policy_checks: [],
  deflected: false, model_id: null, ai_call_id: null,
});

function admin(answer: { data?: unknown; error?: { code?: string; message: string } | null }) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  return { calls, client: { rpc: async (fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args });
    return { data: answer.data ?? null, error: answer.error ?? null };
  } } as never };
}

/** A session client that fails the test if anything writes through it. */
const session = { from: () => { throw new Error("no session-client write"); } } as never;

describe("persist through coach_save_turn (W088)", () => {
  it("returns the rows at the seqs the function saved them at", async () => {
    // Another turn took 5 and 6 between this turn's seq read and its save.
    const db = admin({ data: [{ id: "mine", seq: 7 }, { id: "mine-reply", seq: 8 }] });
    const saved = await persist(session, "t1", [row("mine", "user", 5), row("mine-reply", "assistant", 6)],
      null, "a summary", "chat", db.client);
    expect(saved.map((r) => [r.id, r.seq])).toEqual([["mine", 7], ["mine-reply", 8]]);
    expect(db.calls).toEqual([{ fn: "coach_save_turn", args: {
      p_user_id: "u1", p_thread_id: "t1", p_kind: "chat", p_new_title: null,
      p_rows: [row("mine", "user", 5), row("mine-reply", "assistant", 6)], p_summary: "a summary",
    } }]);
  });

  it("creates a new thread in the same call, its title cut to 80 characters", async () => {
    const db = admin({ data: [{ id: "mine", seq: 1 }] });
    await persist(session, "t1", [row("mine", "user", 1)], "x".repeat(120), undefined, "chat", db.client);
    expect(db.calls[0].args.p_new_title).toBe("x".repeat(80));
    expect(db.calls[0].args.p_summary).toBeNull();
  });

  it("answers 503 in_progress when the same message id is already saved", async () => {
    const db = admin({ error: { code: "P0001", message: "coach_message_exists" } });
    await expect(persist(session, "t1", [row("mine", "user", 6)], null, undefined, "chat", db.client))
      .rejects.toMatchObject({ status: 503, code: "in_progress" });
  });

  it("answers 503 in_progress when the seqs stayed taken after the function's retries", async () => {
    const db = admin({ error: { code: "P0001", message: "coach_seq_busy" } });
    await expect(persist(session, "t1", [row("mine", "user", 1)], null, undefined, "chat", db.client))
      .rejects.toMatchObject({ status: 503, code: "in_progress" });
  });

  it("answers 500 when the thread cannot be started or the turn cannot be saved", async () => {
    const failed = admin({ error: { code: "XX000", message: "boom" } });
    await expect(persist(session, "t1", [row("mine", "user", 1)], "hi", undefined, "chat", failed.client))
      .rejects.toMatchObject({ status: 500, message: "Could not start a thread." });
    await expect(persist(session, "t1", [row("mine", "user", 1)], null, undefined, "chat", failed.client))
      .rejects.toMatchObject({ status: 500, message: "Could not save the turn." });
  });

  it("answers 500 when the function's answer does not name every row", async () => {
    const db = admin({ data: [{ id: "mine", seq: 1 }] });
    await expect(persist(session, "t1", [row("mine", "user", 1), row("mine-reply", "assistant", 2)],
      null, undefined, "chat", db.client)).rejects.toMatchObject({ status: 500 });
  });
});
