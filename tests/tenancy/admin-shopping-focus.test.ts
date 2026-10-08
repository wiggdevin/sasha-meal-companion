/**
 * Spec 3.5 canary for lib/server/shopping-focus.ts (Phase 18 W11, migration 20261227090000), the
 * service-role write and Undo of `user_settings.shopping_focus_*`, reached through
 * `POST /api/shopping/focus` and `POST /api/shopping/focus/undo`. B's focus is the canary: A's
 * write lands on A's row only, A's Undo of B's action id is `superseded` and leaves B unchanged,
 * and neither A's session client nor A's request body can set a focus column directly.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cookieJar, createRequestClient } from "@/lib/supabase/server";
import { accountHeaderFromCookie } from "@/tests/helpers/account-header";
import { adminClient as testAdmin } from "@/tests/helpers/supabase";

const routeAdmin = vi.hoisted(() => ({ client: null as SupabaseClient | null }));
vi.mock("@/lib/server/admin", () => ({ adminClient: () => routeAdmin.client }));

import { POST } from "@/app/api/shopping/focus/route";
import { POST as UNDO } from "@/app/api/shopping/focus/undo/route";
import { resetRateLimits } from "@/lib/server/ratelimit";

const url = process.env.SUPABASE_TEST_URL ?? "";
const anonKey = process.env.SUPABASE_TEST_ANON_KEY ?? "";
const serviceKey = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY ?? "";
const LOCAL = url.startsWith("http://127.0.0.1") && Boolean(anonKey && serviceKey);

type Account = { id: string; client: SupabaseClient; cookie: string };

async function cookieFor(client: SupabaseClient): Promise<string> {
  const { data } = await client.auth.getSession();
  const session = data.session!;
  const seed = new Request("https://app.test/seed");
  await createRequestClient(seed).auth.setSession({
    access_token: session.access_token, refresh_token: session.refresh_token,
  });
  return cookieJar(seed).map((c) => `${c.name}=${encodeURIComponent(c.value)}`).join("; ");
}

function request(account: Account, path: string, body: unknown, claimedId?: string): Request {
  return new Request(`https://app.test${path}`, {
    method: "POST",
    headers: { cookie: account.cookie, ...accountHeaderFromCookie(account.cookie),
      ...(claimedId ? { "x-smc-account": claimedId } : {}), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe.skipIf(!LOCAL)("shopping focus isolation (canary)", () => {
  let admin: SupabaseClient;
  let a: Account;
  let b: Account;
  let bAction = "";
  const ids: string[] = [];
  const previousAccess = process.env.RECIPE_PLANNING_USER_IDS;

  async function createAccount(label: string): Promise<Account> {
    const email = `focus-${label}-${crypto.randomUUID()}@example.test`;
    const password = `local-${crypto.randomUUID()}-A1!`;
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user) throw created.error ?? new Error("user create failed");
    ids.push(created.data.user.id);
    const client = createClient(url, anonKey, { auth: { persistSession: false } });
    const signed = await client.auth.signInWithPassword({ email, password });
    if (signed.error) throw signed.error;
    const settings = await admin.from("user_settings").upsert({ user_id: created.data.user.id,
      first_opened_at: new Date().toISOString() });
    if (settings.error) throw settings.error;
    return { id: created.data.user.id, client, cookie: await cookieFor(client) };
  }

  async function focusOf(id: string) {
    const { data, error } = await admin.from("user_settings")
      .select("shopping_focus_until,shopping_focus_action,shopping_focus_previous").eq("user_id", id).single();
    if (error) throw error;
    return data;
  }

  beforeAll(async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = url;
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = anonKey;
    admin = testAdmin();
    routeAdmin.client = admin;
    [a, b] = await Promise.all([createAccount("a"), createAccount("b")]);
    process.env.RECIPE_PLANNING_USER_IDS = `${a.id},${b.id}`;
    const set = await admin.rpc("shopping_focus_set", { p_user_id: b.id,
      p_until: new Date(Date.now() + 3 * 86_400_000).toISOString() });
    if (set.error) throw set.error;
    bAction = (set.data as { actionId: string }).actionId;
  });

  afterAll(async () => {
    process.env.RECIPE_PLANNING_USER_IDS = previousAccess;
    for (const id of ids) await admin.auth.admin.deleteUser(id);
  });

  it("A's write lands on A's row only, even with B's id claimed", async () => {
    const before = await focusOf(b.id);
    resetRateLimits();
    const res = await POST(request(a, "/api/shopping/focus", { on: true, days: 2 }));
    expect(res.status).toBe(200);
    expect((await focusOf(a.id)).shopping_focus_until).not.toBeNull();
    expect((await POST(request(a, "/api/shopping/focus", { on: false }, b.id))).status).toBeGreaterThanOrEqual(400);
    expect(await focusOf(b.id)).toEqual(before);
  });

  it("A's Undo of B's action id is superseded and B is unchanged", async () => {
    const before = await focusOf(b.id);
    resetRateLimits();
    const res = await UNDO(request(a, "/api/shopping/focus/undo", { actionId: bAction }));
    expect(await res.json()).toMatchObject({ status: "superseded" });
    expect(await focusOf(b.id)).toEqual(before);
  });

  it("A's session client cannot write a focus column, its own or B's", async () => {
    const before = { a: await focusOf(a.id), b: await focusOf(b.id) };
    const own = await a.client.from("user_settings").update({ shopping_focus_until: "2099-01-01T00:00:00Z" })
      .eq("user_id", a.id);
    expect(own.error?.code).toBe("42501");
    await a.client.from("user_settings").update({ shopping_focus_until: null }).eq("user_id", b.id);
    expect(await a.client.rpc("shopping_focus_set", { p_user_id: b.id, p_until: null }).then((r) => r.error))
      .not.toBeNull();
    expect({ a: await focusOf(a.id), b: await focusOf(b.id) }).toEqual(before);
  });
});
