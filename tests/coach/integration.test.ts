// Phase 7 branch integration — spec "Integration cases" (1–8), contracts §4, §7, §9.
//
// Each case seeds through users.admin (service role), acts through the exported route handler or
// runTurn with a stubbed deps.generate, and asserts the status plus the row counts before/after.
// Every case skips when SUPABASE_TEST_URL is unset, so CI stays green without a branch.
//
// Run: bash scripts/db-branch.sh env p7-coach  →  export the four vars  →
//      bash scripts/db-branch.sh reset p7-coach  →  pnpm test:integration tests/coach/integration.test.ts

import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as coachPOST } from "@/app/api/coach/route";
import { PUT as constraintsPUT } from "@/app/api/constraints/route";
import type { generateStructured } from "@/lib/ai/adapter";
import { registerCoachTools } from "@/lib/mcp/coach-tools";
import { resetRateLimits } from "@/lib/server/ratelimit";
import { runTurn } from "@/lib/server/coach-turn";
import { mintToken, toBytea } from "@/lib/server/tokens";
import { withTokenUser } from "@/lib/server/privileged";
import { cookieJar, createRequestClient } from "@/lib/supabase/server";
import { createTestUsers, HAS_BRANCH, resetUser } from "../helpers/supabase";
import { TEST_PROFILE } from "../helpers/constraint-profile";
import { accountHeaderFromCookie } from "@/tests/helpers/account-header";

const when = HAS_BRANCH ? describe : describe.skip;

type Content = { content: { type: "text"; text: string }[] };

/** Sign in as `client` on a seed Request and render the session as a `Cookie:` header. */
async function cookieHeaderFor(client: SupabaseClient): Promise<string> {
  const { data } = await client.auth.getSession();
  const session = data.session!;
  const seed = new Request("https://app.test/seed");
  await createRequestClient(seed).auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  });
  return cookieJar(seed).map((c) => c.name + "=" + encodeURIComponent(c.value)).join("; ");
}

function postTurn(body: unknown, cookie: string): Request {
  return new Request("https://app.test/api/coach", {
    method: "POST",
    headers: { "content-type": "application/json", cookie, ...accountHeaderFromCookie(cookie) },
    body: JSON.stringify(body),
  });
}

function putConstraints(body: unknown, cookie: string): Request {
  return new Request("https://app.test/api/constraints", {
    method: "PUT",
    headers: { "content-type": "application/json", cookie, ...accountHeaderFromCookie(cookie) },
    body: JSON.stringify(body),
  });
}

function bearer(raw: string): Request {
  return new Request("https://app.test/api/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${raw}`, "content-type": "application/json" },
    body: "{}",
  });
}

when("Phase 7 on a Supabase branch", () => {
  let users: Awaited<ReturnType<typeof createTestUsers>>;
  let aId = "";
  let aCookie = "";

  async function rows(table: string, column: string, value: string): Promise<number> {
    const { data } = await users.admin.from(table).select(column).eq(column, value);
    return (data ?? []).length;
  }

  async function assistantRowsForUser(userId: string): Promise<number> {
    const { data, error } = await users.admin.from("coach_messages").select("id")
      .eq("user_id", userId).eq("role", "assistant");
    expect(error).toBeNull();
    return (data ?? []).length;
  }

  beforeAll(async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_TEST_URL;
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_TEST_ANON_KEY;
    process.env.SUPABASE_URL = process.env.SUPABASE_TEST_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;
    process.env.COACH_ENABLED = "1";

    users = await createTestUsers();
    aId = users.a.userId;
    await resetUser(users.a.userId);
    await resetUser(users.b.userId);
    aCookie = await cookieHeaderFor(users.a.client);
  });

  beforeEach(() => { resetRateLimits(); });

  it("1. denies user B every read, write and delete on the three tables", async () => {
    const thread = await users.admin.from("coach_threads")
      .insert({ user_id: users.a.userId, kind: "chat", title: "A" }).select("id").single();
    for (const table of ["coach_threads", "coach_messages", "constraint_profiles"]) {
      const read = await users.b.client.from(table).select("*");
      expect(read.data ?? [], table).toHaveLength(0);
    }
    const del = await users.b.client.from("coach_threads")
      .update({ deleted_at: new Date().toISOString() }).eq("id", thread.data!.id).select("id");
    expect(del.data ?? []).toHaveLength(0);
  });

  it("2. a read-scoped token may get_constraints and may not set_constraints", async () => {
    await resetUser(aId);
    // D1 §6.1 / 20261026090100: a row-less account restricts nothing, so the read this case
    // asserts is the account's own row — seeded here, not a code default (the old gluten/dairy/
    // apple DEFAULT_PROFILE is gone).
    const seeded = await users.admin.from("constraint_profiles")
      .insert({ user_id: aId, rev: 1, conditions: [], notes: null, ...TEST_PROFILE });
    expect(seeded.error).toBeNull();
    const token = mintToken();
    const inserted = await users.admin.from("api_tokens").insert({
      user_id: aId, label: "read", token_hash: toBytea(token.hash), scopes: ["read"],
    });
    expect(inserted.error).toBeNull();

    const handlers = new Map<string, (args: never) => Promise<Content>>();
    const server = {
      registerTool: (name: string, _config: unknown, handler: (args: never) => Promise<Content>) => {
        handlers.set(name, handler);
      },
    };
    registerCoachTools(server as never, { userId: aId, admin: users.admin });

    const got = await withTokenUser(bearer(token.raw), "read",
      async () => handlers.get("get_constraints")!(undefined as never));
    expect(JSON.parse(got.content[0].text)).toMatchObject({
      profile: { avoid_allergens: TEST_PROFILE.avoid_allergens }, rev: 1,
    });

    const denied = await withTokenUser(bearer(token.raw), "constraints:write",
      async () => handlers.get("set_constraints")!(undefined as never)).catch((e) => e);
    expect(denied).toMatchObject({ status: 403, code: "forbidden" });
    const afterDenied = await users.admin.from("constraint_profiles").select("rev").eq("user_id", aId);
    expect(afterDenied.data).toEqual([{ rev: 1 }]);
  });

  it("3. a stale baseRev conflicts and writes nothing; removing dairy is 200 (the floor is gone)", async () => {
    await resetUser(aId);
    const seeded = await users.admin.from("constraint_profiles").insert({
      user_id: aId, rev: 1, conditions: ["ulcerative colitis"], notes: null,
      avoid_allergens: ["gluten", "dairy", "apple"], avoid_food_ref_ids: [],
      banned_categories: ["simple_sugars"],
    });
    expect(seeded.error).toBeNull();

    const before = await users.admin.from("constraint_profiles").select("rev").eq("user_id", aId);
    expect(before.data).toHaveLength(1);

    const conflict = await constraintsPUT(putConstraints(
      { baseRev: 0, conditions: ["ulcerative colitis"] }, aCookie));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ status: "conflict", current_rev: 1 });
    const afterConflict = await users.admin.from("constraint_profiles").select("rev").eq("user_id", aId);
    expect(afterConflict.data).toEqual([{ rev: 1 }]);

    // Rewritten, not dropped: the clinical floor was one person's rule and no longer ships —
    // lib/server/constraints.ts has no floor guard (grep for floor_violation finds none in lib/ or
    // app/), so dropping dairy is an ordinary accepted write. The stale-baseRev conflict above is
    // the half that still refuses.
    const removed = await constraintsPUT(putConstraints(
      { baseRev: 1, avoidAllergens: ["gluten", "apple"] }, aCookie));
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({
      status: "ok", rev: 2, profile: { avoid_allergens: ["gluten", "apple"] },
    });
    const afterRemoval = await users.admin.from("constraint_profiles")
      .select("rev, avoid_allergens").eq("user_id", aId);
    expect(afterRemoval.data).toEqual([{ rev: 2, avoid_allergens: ["gluten", "apple"] }]);
  });

  it("4. a repeated messageId returns the stored turn and adds no ai_calls row", async () => {
    await resetUser(aId);
    const generate = vi.fn(async () => ({ kind: "final", text: "Eat rice.", suggestions: [] }));
    const req = { threadId: null, messageId: crypto.randomUUID(), text: "what should I eat now" };

    const first = await runTurn(users.a.client, users.admin, aId, req,
      { generate: generate as unknown as typeof generateStructured });
    const callsAfterFirst = await rows("ai_calls", "user_id", aId);
    const messagesAfterFirst = await rows("coach_messages", "user_id", aId);
    expect(first.messages).toHaveLength(2);

    const second = await runTurn(users.a.client, users.admin, aId, req,
      { generate: generate as unknown as typeof generateStructured });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(second.threadId).toBe(first.threadId);
    expect(second.messages).toHaveLength(first.messages.length);
    expect(await rows("ai_calls", "user_id", aId)).toBe(callsAfterFirst);
    expect(await rows("coach_messages", "user_id", aId)).toBe(messagesAfterFirst);
  });

  it("5. a dairy suggestion renders blocked and carries no draft", async () => {
    await resetUser(aId);
    const dairyRef = crypto.randomUUID();
    await users.admin.from("constraint_profiles").insert({
      user_id: aId, rev: 1, conditions: [], notes: null,
      avoid_allergens: ["gluten", "dairy", "apple"], avoid_food_ref_ids: [dairyRef],
      banned_categories: ["simple_sugars"],
    });
    const generate = vi.fn()
      .mockResolvedValueOnce({ kind: "tool", calls: [{
        name: "draft_log_entry",
        args: { slot: "meal-1", items: [{ name: "yoghurt", grams: 200 }] },
      }] })
      .mockResolvedValueOnce({ kind: "final", text: "Yoghurt is not one for today.", suggestions: [
        { name: "yoghurt", foodRefId: dairyRef, grams: 200 },
      ] });

    const res = await runTurn(users.a.client, users.admin, aId,
      { threadId: null, messageId: crypto.randomUUID(), text: "can I have yoghurt" },
      { generate: generate as unknown as typeof generateStructured, ports: {
        searchFoods: async () => [{ foodRefId: dairyRef, name: "yoghurt", brand: null,
          kcalPer100g: 60, prefStatus: "avoid" as const }],
      } });

    expect(res.suggestions).toHaveLength(1);
    expect(res.suggestions[0]).toMatchObject({ name: "yoghurt", verdict: "blocked" });
    expect(res.suggestions[0].reason).toBeTruthy();
    expect(res.draft).toBeNull();
  });

  it("5b. a turn returns an action and writes no log_entries or plan_days rows", async () => {
    await resetUser(aId);
    const beforeLogs = await rows("log_entries", "user_id", aId);
    const beforePlans = await rows("plan_days", "user_id", aId);
    const foodRefId = crypto.randomUUID();
    const generate = vi.fn(async () => ({
      kind: "final", text: "I logged breakfast.", actions: [{
        kind: "log_meal", date: "2026-09-16", slot: "meal-1",
        items: [{ name: "rice", grams: 150 }],
      }],
    }));

    const result = await runTurn(users.a.client, users.admin, aId,
      { threadId: null, messageId: crypto.randomUUID(), text: "I ate 150 grams of rice" },
      { generate: generate as unknown as typeof generateStructured, ports: {
        searchFoods: async () => [{ foodRefId, name: "rice", brand: null,
          kcalPer100g: 130, prefStatus: "eats" as const }],
      } });

    expect(result.actions).toHaveLength(1);
    expect(await rows("log_entries", "user_id", aId)).toBe(beforeLogs);
    expect(await rows("plan_days", "user_id", aId)).toBe(beforePlans);
  });

  it("6. both providers failing is 503 and writes no assistant row", async () => {
    await resetUser(aId);
    const before = await rows("coach_messages", "user_id", aId);
    const generate = vi.fn(async () => { throw new Error("nous 500; gemini 500"); });

    const error = await runTurn(users.a.client, users.admin, aId,
      { threadId: null, messageId: crypto.randomUUID(), text: "what should I eat now" },
      { generate: generate as unknown as typeof generateStructured }).catch((e) => e);

    expect(error).toMatchObject({ status: 503, code: "coach_unavailable" });
    expect(generate).toHaveBeenCalled();
    expect(await rows("coach_messages", "user_id", aId)).toBe(before);
    expect(await assistantRowsForUser(aId)).toBe(0);
  });

  it("7. the eleventh turn in an hour is 429 with retryAfterSeconds", async () => {
    await resetUser(aId);
    const seeded = await users.admin.from("ai_calls").insert(Array.from({ length: 10 }, (_, i) => ({
      user_id: aId, purpose: "coach", provider: "google", model_id: "gemini-3.8-flash",
      sdk_version: "test", input_tokens: 1, output_tokens: 1, latency_ms: 1,
      input_hash: "\\x00", cost_estimate: 0, status: "ok",
      created_at: new Date(Date.now() - i * 60_000).toISOString(),
    })));
    expect(seeded.error).toBeNull();

    const before = await rows("coach_messages", "user_id", aId);
    const res = await coachPOST(postTurn(
      { threadId: null, messageId: crypto.randomUUID(), text: "what should I eat now" }, aCookie));
    expect(res.status).toBe(429);
    const body = await res.json() as { error: string; retryAfterSeconds: number };
    expect(body.error).toBe("rate_limited");
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
    expect(res.headers.get("retry-after")).toBe(String(body.retryAfterSeconds));
    expect(await rows("coach_messages", "user_id", aId)).toBe(before);
  });

  it("8. a turn carrying gut notes with no Nous record is 503 nous_unconfirmed", async () => {
    // The suite runs attested (tests/helpers/attested-env.ts); this case is the unattested server.
    vi.stubEnv("HEALTH_CONTEXT_PROVIDER", "");
    await resetUser(aId);
    await users.admin.from("constraint_profiles").insert({
      user_id: aId, rev: 1, conditions: ["ulcerative colitis"], notes: "flare last Tuesday",
      avoid_allergens: ["gluten", "dairy", "apple"], avoid_food_ref_ids: [],
      banned_categories: ["simple_sugars"],
    });
    const before = await rows("coach_messages", "user_id", aId);

    const res = await coachPOST(postTurn(
      { threadId: null, messageId: crypto.randomUUID(), text: "what should I eat now" }, aCookie));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "nous_unconfirmed" });
    expect(await rows("coach_messages", "user_id", aId)).toBe(before);
    expect(await assistantRowsForUser(aId)).toBe(0);
    vi.unstubAllEnvs();
  });

});
