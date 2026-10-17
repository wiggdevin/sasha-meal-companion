/**
 * W018 + W035 on a real local stack. After migration 20261231170000 a signed-in user may insert
 * only the caller's own question, so `persist` writes the question with the session client and the
 * reply with the service role on every attempt. When another turn took the reply's seq, the
 * question that already landed is removed with the session client (`coach_messages_delete` still
 * lets the caller delete its own rows) and the pair is saved after the thread's new last seq.
 * Local-only real Postgres/RLS proof; never points at a hosted branch or a real account.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { persist, type MessageRow } from "@/lib/server/coach-threads";
import { adminClient, ensureUser, resetUser, userClient, type TestUser }
  from "@/tests/helpers/supabase";

function localStack(): boolean {
  try {
    const api = new URL(process.env.SUPABASE_TEST_URL ?? "");
    const db = new URL(process.env.SUPABASE_TEST_DB_URL ?? "");
    return [api.hostname, db.hostname].every((host) => host === "127.0.0.1" || host === "localhost")
      && api.port === "54321" && db.port === "54322";
  } catch { return false; }
}

describe.skipIf(!localStack())("persist's seq retry under the server-owned grants (W018, W035)", () => {
  let a: TestUser;

  beforeAll(async () => {
    a = await ensureUser("a");
    await resetUser(a.id);
  });
  afterAll(async () => {
    if (a) await resetUser(a.id);
  });

  it("removes the landed question with the session client and saves the pair after the new last seq", async () => {
    const session = await userClient(a);
    const admin = adminClient();
    const thread = randomUUID();
    const created = await session.from("coach_threads").insert({ id: thread, user_id: a.id,
      kind: "chat", title: "Synthetic seq race" });
    expect(created.error).toBeNull();
    // Another turn's reply already holds seq 2: this turn's question lands at 1, its reply is refused.
    const other = await admin.from("coach_messages").insert({ id: randomUUID(), thread_id: thread,
      user_id: a.id, role: "assistant", content: "Another turn's reply", seq: 2 });
    expect(other.error).toBeNull();

    const row = (id: string, role: "user" | "assistant", seq: number): MessageRow => ({
      id, thread_id: thread, user_id: a.id, role, content: `Synthetic ${role}`, seq,
      tool_calls: role === "user" ? [] : { provenance: { ai: false, source: "app" } },
      policy_checks: [], deflected: false, model_id: null, ai_call_id: null,
    });
    const question = randomUUID();
    const reply = randomUUID();
    const saved = await persist(session, thread, [row(question, "user", 1), row(reply, "assistant", 2)],
      null, undefined, "chat", admin);

    expect(saved.map((r) => [r.id, r.seq])).toEqual([[question, 3], [reply, 4]]);
    const { data } = await admin.from("coach_messages").select("id, role, seq")
      .eq("thread_id", thread).order("seq", { ascending: true });
    expect((data ?? []).map((r) => [r.seq, r.role])).toEqual([[2, "assistant"], [3, "user"], [4, "assistant"]]);
    expect((data ?? []).find((r) => r.id === question)?.seq).toBe(3);
  });
});
