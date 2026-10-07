// tests/coach/threads-manage-db.test.ts
// Coach thread management (clear, rename, delete, search) against the real database: RLS, the
// chat-only kind restriction, and the ai_calls boundary (clear never touches it).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestUsers, HAS_BRANCH, resetUser } from "../helpers/supabase";
import {
  clearChatThread, deleteChatThread, renameChatThread, searchChatThreads,
} from "@/lib/server/coach-threads";

const run = HAS_BRANCH ? describe : describe.skip;

async function seedChat(client: SupabaseClient, userId: string, title: string): Promise<string> {
  const { data, error } = await client.from("coach_threads")
    .insert({ user_id: userId, title, kind: "chat" }).select("id").single();
  if (error) throw error;
  return (data as { id: string }).id;
}

async function seedMessage(
  client: SupabaseClient, userId: string, threadId: string, seq: number, content: string,
  aiCallId: string | null = null,
): Promise<string> {
  const { data, error } = await client.from("coach_messages").insert({
    thread_id: threadId, user_id: userId, role: "user", content, seq, ai_call_id: aiCallId,
  }).select("id").single();
  if (error) throw error;
  return (data as { id: string }).id;
}

run("coach thread management against the real database", () => {
  let clientA: SupabaseClient;
  let clientB: SupabaseClient;
  let admin: SupabaseClient;
  let userA = "";
  let userB = "";

  beforeAll(async () => {
    const users = await createTestUsers();
    clientA = users.a.client; userA = users.a.userId;
    clientB = users.b.client; userB = users.b.userId;
    admin = users.admin;
    await resetUser(userA);
    await resetUser(userB);
  });
  afterAll(async () => {
    if (userA) await resetUser(userA);
    if (userB) await resetUser(userB);
  });

  it("clear deletes every message and nulls the summary, and never touches ai_calls", async () => {
    const threadId = await seedChat(clientA, userA, "Tofu notes");
    const { data: callRow, error: callError } = await admin.from("ai_calls").insert({
      purpose: "coach-turn", user_id: userA, provider: "gemini", model_id: "gemini-3.8-flash",
      sdk_version: "test",
    }).select("id").single();
    expect(callError).toBeNull();
    const aiCallId = (callRow as { id: string }).id;
    await seedMessage(clientA, userA, threadId, 1, "I had tofu for lunch", aiCallId);
    await seedMessage(clientA, userA, threadId, 2, "Sounds great!");
    const patched = await admin.from("coach_threads").update({
      summary: "a running summary", last_message_at: new Date().toISOString(),
    }).eq("id", threadId);
    expect(patched.error).toBeNull();

    await clearChatThread(clientA, userA, threadId);

    const { data: messages } = await clientA.from("coach_messages").select("id")
      .eq("thread_id", threadId);
    expect(messages).toEqual([]);
    const { data: thread } = await clientA.from("coach_threads")
      .select("summary, last_message_at, title").eq("id", threadId).single();
    expect(thread).toMatchObject({ summary: null, last_message_at: null, title: "Tofu notes" });
    const { data: calls } = await admin.from("ai_calls").select("id").eq("id", aiCallId);
    expect(calls).toHaveLength(1);
  });

  it("rename updates an owned active chat; a plan thread and another user's chat 404", async () => {
    const threadId = await seedChat(clientA, userA, "Original title");
    const renamed = await renameChatThread(clientA, userA, threadId, "New title");
    expect(renamed).toMatchObject({ id: threadId, title: "New title", kind: "chat" });
    const { data: stored } = await clientA.from("coach_threads").select("title")
      .eq("id", threadId).single();
    expect(stored).toMatchObject({ title: "New title" });

    const { data: planRow, error: planError } = await admin.from("coach_threads")
      .insert({ user_id: userA, title: "Plan", kind: "plan" }).select("id").single();
    expect(planError).toBeNull();
    const planId = (planRow as { id: string }).id;
    await expect(renameChatThread(clientA, userA, planId, "Nope"))
      .rejects.toMatchObject({ status: 404 });

    const bThread = await seedChat(clientB, userB, "B's chat");
    await expect(renameChatThread(clientA, userA, bThread, "Nope"))
      .rejects.toMatchObject({ status: 404 });
  });

  it("delete soft-deletes an owned chat; a plan thread and another user's chat 404", async () => {
    const threadId = await seedChat(clientA, userA, "Deletable");
    await deleteChatThread(clientA, userA, threadId);
    const { data: thread } = await clientA.from("coach_threads").select("deleted_at")
      .eq("id", threadId).single();
    expect((thread as { deleted_at: string | null } | null)?.deleted_at).not.toBeNull();

    const { data: planRow, error: planError } = await admin.from("coach_threads")
      .insert({ user_id: userA, title: "Plan2", kind: "plan" }).select("id").single();
    expect(planError).toBeNull();
    const planId = (planRow as { id: string }).id;
    await expect(deleteChatThread(clientA, userA, planId)).rejects.toMatchObject({ status: 404 });

    const bThread = await seedChat(clientB, userB, "B's chat 2");
    await expect(deleteChatThread(clientA, userA, bThread)).rejects.toMatchObject({ status: 404 });
  });

  it("search finds title and message matches for the owner only", async () => {
    const mineId = await seedChat(clientA, userA, "Avocado toast ideas");
    await seedMessage(clientA, userA, mineId, 1,
      "I want avocado toast with chili flakes for brunch");
    const otherId = await seedChat(clientA, userA, "Weekly groceries");
    await seedMessage(clientA, userA, otherId, 1, "Buy milk and bread");
    const othersId = await seedChat(clientB, userB, "Avocado toast ideas");
    await seedMessage(clientB, userB, othersId, 1, "I want avocado toast too");

    const results = await searchChatThreads(clientA, userA, "avocado");
    const byThread = new Map(results.map((result) => [result.threadId, result]));
    expect(byThread.has(mineId)).toBe(true);
    expect(byThread.get(mineId)?.matches[0]?.snippet).toContain("avocado");
    expect(byThread.has(otherId)).toBe(false);
    expect(byThread.has(othersId)).toBe(false);
  });
});
