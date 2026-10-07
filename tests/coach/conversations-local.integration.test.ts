/** Local-only real Postgres/RLS proof; never points at a hosted branch or a real account. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recallSavedMessages } from "@/lib/server/coach-history-recall";
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

describe.skipIf(!localStack())("saved Coach chats in existing local Supabase", () => {
  let a: TestUser;
  let b: TestUser;

  beforeAll(async () => {
    [a, b] = await Promise.all([ensureUser("a"), ensureUser("b")]);
    await resetUser(a.id);
    await resetUser(b.id);
  });
  afterAll(async () => {
    if (a) await resetUser(a.id);
    if (b) await resetUser(b.id);
  });

  it("atomically caps concurrent chat inserts at eight without deleting any transcript", async () => {
    const client = await userClient(a);
    const writes = await Promise.all(Array.from({ length: 10 }, (_, index) =>
      client.from("coach_threads").insert({ user_id: a.id, kind: "chat",
        title: `Synthetic conversation ${index}` }).select("id").single()));
    expect(writes.filter((write) => !write.error)).toHaveLength(8);
    expect(writes.filter((write) => write.error).every((write) =>
      write.error?.message.includes("coach_chat_limit"))).toBe(true);
    const { data: chats } = await client.from("coach_threads").select("id")
      .eq("kind", "chat").is("deleted_at", null);
    expect(chats).toHaveLength(8);

    const first = writes.find((write) => write.data)?.data?.id as string;
    const saved = await client.from("coach_messages").insert({ user_id: a.id,
      thread_id: first, role: "user", content: "My breakfast includes tofu", seq: 1 });
    expect(saved.error).toBeNull();
    const ninth = await client.from("coach_threads").insert({ user_id: a.id,
      kind: "chat", title: "Ninth" });
    expect(ninth.error?.message).toContain("coach_chat_limit");
    const { data: transcript } = await client.from("coach_messages").select("content")
      .eq("thread_id", first);
    expect(transcript?.map((row) => row.content)).toEqual(["My breakfast includes tofu"]);
  });

  it("keeps plan threads outside the cap and denies direct client plan forgery", async () => {
    const client = await userClient(a);
    const forged = await client.from("coach_threads").insert({ user_id: a.id,
      kind: "plan", title: "Forged plan" });
    expect(forged.error).not.toBeNull();
    const created = await adminClient().from("coach_threads").insert({ user_id: a.id,
      kind: "plan", title: "Synthetic Plan sheet" }).select("id").single();
    expect(created.error).toBeNull();
    const { data: plans } = await client.from("coach_threads").select("id")
      .eq("kind", "plan");
    expect(plans?.map((row) => row.id)).toContain(created.data!.id);
  });

  it("searches an old message in the same account and refuses another account", async () => {
    const aClient = await userClient(a);
    const bClient = await userClient(b);
    const { data: source } = await aClient.from("coach_threads").select("id")
      .eq("kind", "chat").order("created_at", { ascending: true }).limit(1).single();
    expect(source?.id).toBeTruthy();
    const rows = Array.from({ length: 130 }, (_, index) => ({ user_id: a.id,
      thread_id: source!.id, role: "user", seq: index + 2,
      content: index === 0 ? "I prefer tempeh at breakfast" : `Synthetic note ${index + 2}` }));
    const inserted = await adminClient().from("coach_messages").insert(rows);
    expect(inserted.error).toBeNull();
    const found = await recallSavedMessages(aClient, a.id, source!.id,
      "What did I say about tempeh?");
    expect(found.sources[0]).toMatchObject({ seq: 2,
      content: "I prefer tempeh at breakfast" });
    await expect(recallSavedMessages(bClient, b.id, source!.id, "tempeh"))
      .rejects.toMatchObject({ status: 404 });
  });
});
