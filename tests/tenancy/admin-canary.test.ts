/**
 * Spec 3.5 (Phase 9 slice 3): server code that holds the admin client (which bypasses RLS) must
 * still answer only for the account it serves. Each case seeds user B with canary strings, asks the
 * entry point on behalf of user A, and requires that no canary comes back and that B's rows do not
 * change. Every case also asks on behalf of B as a control, so a canary that never reaches any
 * output cannot make the check pass.
 */
// Refuses any non-local database before anything else runs (review r8).
import "./local-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HAS_BRANCH, HAS_DB, adminClient, ensureUser, userClient, type TestUser,
} from "../helpers/supabase";
import { buildCoachContext, renderCoachContext } from "@/lib/server/coach-context";
import { fetchOwnedObject } from "@/lib/server/media";
import { registerCoachTools } from "@/lib/mcp/coach-tools";
import { registerExpenditureTools } from "@/lib/mcp/expenditure-tools";
import { registerHealthTools } from "@/lib/mcp/health-tools";
import { accountSnapshot, purge } from "./seed";
import { assertLocalTargets } from "./target-guard";

const CANARY = `canary-${crypto.randomUUID()}`;
const STEPS = 424_242;
const DATE = "2041-03-14";

async function insert(table: string, row: Record<string, unknown>): Promise<void> {
  const { error } = await adminClient().from(table).insert(row);
  if (error) throw new Error(`seed ${table}: ${error.message}`);
}

async function seedB(b: string): Promise<void> {
  const foodId = crypto.randomUUID();
  const refId = crypto.randomUUID();
  await insert("user_foods", { id: foodId, user_id: b, name: `${CANARY} food`, kind: "custom" });
  await insert("food_refs", { id: refId, kind: "user", user_food_id: foodId });
  await insert("user_food_prefs", { user_id: b, food_ref_id: refId, status: "eats",
    note: CANARY });
  await insert("recipes", { user_id: b, name: `${CANARY} recipe`, servings: 1 });
  await insert("log_entries", { id: crypto.randomUUID(), user_id: b, title: CANARY, note: CANARY,
    eaten_at: `${DATE}T12:00:00Z`, tz: "UTC", local_date: DATE, slot: "meal-1", method: "text" });
  const cleared = await adminClient().from("constraint_profiles").delete().eq("user_id", b);
  if (cleared.error) throw new Error(cleared.error.message);
  await insert("constraint_profiles", { user_id: b, notes: CANARY });
  const threadId = crypto.randomUUID();
  await insert("coach_threads", { id: threadId, user_id: b, title: CANARY });
  await insert("coach_messages", { thread_id: threadId, user_id: b, role: "user", seq: 1,
    content: CANARY });
  const sourceId = crypto.randomUUID();
  await insert("health_sources", { id: sourceId, user_id: b, kind: "health_auto_export",
    device_label: CANARY });
  await insert("health_samples", { user_id: b, source_id: sourceId, type: "step_count",
    value: STEPS, unit: "count", start_time: `${DATE}T12:00:00Z`, end_time: `${DATE}T12:00:00Z`,
    tz: "UTC" });
}

type Handler = (args: never) => Promise<{ content: { text: string }[] }>;

/** Every MCP tool the route mounts, bound to `userId` exactly as app/api/mcp/route.ts binds them. */
function mcpTools(userId: string): Map<string, Handler> {
  const tools = new Map<string, Handler>();
  const server = { registerTool: (name: string, _config: unknown, handler: Handler) => {
    tools.set(name, handler);
  } };
  const ctx = { userId, admin: adminClient() };
  registerHealthTools(server as never, ctx);
  registerExpenditureTools(server as never, ctx);
  registerCoachTools(server as never, ctx);
  return tools;
}

async function readAllTools(userId: string): Promise<string> {
  const tools = mcpTools(userId);
  const args: Record<string, unknown> = { get_body_data: { from: DATE, to: DATE } };
  const reads = ["get_body_data", "get_expenditure_status", "get_targets", "get_constraints",
    "list_coach_messages"];
  expect([...tools.keys()].sort()).toEqual([...reads, "set_constraints"].sort());
  const out = await Promise.all(reads.map(async (name) =>
    (await tools.get(name)!((args[name] ?? {}) as never)).content.map((c) => c.text).join("\n")));
  return out.join("\n");
}

describe.skipIf(!HAS_BRANCH || !HAS_DB)("admin-client entry points answer only for their account", () => {
  let a: TestUser;
  let b: TestUser;
  let asA: SupabaseClient;
  let asB: SupabaseClient;

  beforeAll(async () => {
    assertLocalTargets();
    [a, b] = await Promise.all([ensureUser("a"), ensureUser("b")]);
    [asA, asB] = await Promise.all([userClient(a), userClient(b)]);
    await purge([a.id, b.id]);
    await seedB(b.id);
  });

  afterAll(async () => {
    await purge([a.id, b.id]);
  });

  it("coach context: no canary of B's reaches A's prompt block", async () => {
    const clock = { now: `${DATE}T13:00:00Z`, tz: "UTC", date: DATE };
    const intent = { intent: "update_profile" as const, message: "" };
    const before = accountSnapshot(b.id);
    const forA = renderCoachContext(await buildCoachContext(adminClient(), asA, a.id, clock,
      intent));
    const forB = renderCoachContext(await buildCoachContext(adminClient(), asB, b.id, clock,
      intent));
    expect(forB).toContain(CANARY);
    expect(forA).not.toContain(CANARY);
    expect(accountSnapshot(b.id)).toEqual(before);
  });

  it("MCP tools: no canary of B's in any read tool bound to A", async () => {
    const before = accountSnapshot(b.id);
    const forB = await readAllTools(b.id);
    expect(forB).toContain(CANARY);
    expect(forB).toContain(String(STEPS));
    const forA = await readAllTools(a.id);
    expect(forA).not.toContain(CANARY);
    expect(forA).not.toContain(String(STEPS));
    expect(accountSnapshot(b.id)).toEqual(before);
  });

  it("MCP set_constraints bound to A writes A's profile and leaves every row of B's", async () => {
    const tools = mcpTools(a.id);
    const current = JSON.parse((await tools.get("get_constraints")!({} as never))
      .content[0].text) as { rev: number };
    const before = accountSnapshot(b.id);
    const note = `a-note-${crypto.randomUUID()}`;
    const out = await tools.get("set_constraints")!({ baseRev: current.rev, notes: note } as never);
    expect(out.content[0].text).toContain('"ok"');
    const own = await adminClient().from("constraint_profiles").select("notes")
      .eq("user_id", a.id).single();
    expect(own.error).toBeNull();
    expect(own.data?.notes).toBe(note);
    expect(accountSnapshot(b.id)).toEqual(before);
  });

  it("media: A cannot fetch B's canary object through the server", async () => {
    const path = `${b.id}/${CANARY}.jpg`;
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    const up = await adminClient().storage.from("media")
      .upload(path, new Blob([bytes], { type: "image/jpeg" }), { contentType: "image/jpeg" });
    expect(up.error).toBeNull();
    expect((await fetchOwnedObject(adminClient(), b.id, path)).bytes).toEqual(bytes);
    await expect(fetchOwnedObject(adminClient(), a.id, path)).rejects.toMatchObject({
      status: 403 });
  });
});
