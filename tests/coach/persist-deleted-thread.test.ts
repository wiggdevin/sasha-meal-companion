/**
 * W126 (migration 20270106090200): `coach_save_turn` refuses a thread deleted after the turn's
 * pre-read as coach_thread_deleted, and `persist` answers it as the pre-read answers a deleted
 * thread: 404 not_found. tests/migrations/fk-indexes-db.test.ts runs the SQL.
 */
import { describe, expect, it } from "vitest";
import { persist, type MessageRow } from "@/lib/server/coach-threads";

const row: MessageRow = {
  id: "mine", thread_id: "t1", user_id: "u1", role: "user", content: "hi", seq: 1, tool_calls: [],
  policy_checks: [], deflected: false, model_id: null, ai_call_id: null,
};

describe("persist on a thread deleted mid-turn (W126)", () => {
  it("answers 404 not_found", async () => {
    const admin = { rpc: async () => ({ data: null,
      error: { code: "P0001", message: "coach_thread_deleted" } }) } as never;
    const session = { from: () => { throw new Error("no session-client write"); } } as never;
    await expect(persist(session, "t1", [row], null, undefined, "chat", admin))
      .rejects.toMatchObject({ status: 404, code: "not_found" });
  });
});
