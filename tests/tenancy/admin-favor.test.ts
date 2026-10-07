/**
 * Spec 3.5 canary for `POST /api/foods/favor` and lib/server/membership-revisions.ts (Phase 18 D6),
 * the declared service-role read of `food_membership_revisions`. B's membership marks are the
 * canary: the owner-filtered read for A never returns them, A's session client cannot read even its
 * own marks (RLS, no client read policy, which is why the declared read exists), and A's favor of a
 * crafted key naming B's food answers 404 and leaves every B row unchanged.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cookieJar, createRequestClient } from "@/lib/supabase/server";
import { accountHeaderFromCookie } from "@/tests/helpers/account-header";
import { adminClient as testAdmin } from "@/tests/helpers/supabase";

const routeAdmin = vi.hoisted(() => ({ client: null as SupabaseClient | null }));
vi.mock("@/lib/server/admin", () => ({ adminClient: () => routeAdmin.client }));

import { POST } from "@/app/api/foods/favor/route";
import { GET as tasteGET } from "@/app/api/foods/taste/route";
import { foodKey, inputHash } from "@/lib/foods/facet-keys";
import { facetRubricVersion } from "@/lib/foods/facet-vocabulary";
import { applyLogEntry } from "@/lib/server/log";
import { readMembershipRevisions } from "@/lib/server/membership-revisions";
import { resetRateLimits } from "@/lib/server/ratelimit";

const url = process.env.SUPABASE_TEST_URL ?? "";
const anonKey = process.env.SUPABASE_TEST_ANON_KEY ?? "";
const serviceKey = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY ?? "";
const LOCAL = url.startsWith("http://127.0.0.1") && Boolean(anonKey && serviceKey);
const CANARY = "favor canary stew";

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

const TODAY = new Date().toISOString().slice(0, 10);
const KIWI = "favor canary kiwi";

function tasteRequest(account: Account): Request {
  return new Request(`https://app.test/api/foods/taste?date=${TODAY}`, {
    headers: { cookie: account.cookie, ...accountHeaderFromCookie(account.cookie) } });
}

function request(account: Account, key: string, claimedId?: string): Request {
  return new Request("https://app.test/api/foods/favor", {
    method: "POST",
    headers: { cookie: account.cookie, ...accountHeaderFromCookie(account.cookie),
      ...(claimedId ? { "x-smc-account": claimedId } : {}), "content-type": "application/json" },
    body: JSON.stringify({ key }),
  });
}

describe.skipIf(!LOCAL)("favor isolation (canary)", () => {
  let admin: SupabaseClient;
  let a: Account;
  let b: Account;
  const ids: string[] = [];

  async function createAccount(label: string): Promise<Account> {
    const email = `favor-${label}-${crypto.randomUUID()}@example.test`;
    const password = `local-${crypto.randomUUID()}-A1!`;
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user) throw created.error ?? new Error("user create failed");
    ids.push(created.data.user.id);
    const client = createClient(url, anonKey, { auth: { persistSession: false } });
    const signed = await client.auth.signInWithPassword({ email, password });
    if (signed.error) throw signed.error;
    return { id: created.data.user.id, client, cookie: await cookieFor(client) };
  }

  async function marksOf(id: string) {
    const { data, error } = await admin.from("food_membership_revisions").select("name_norm,status,rev")
      .eq("user_id", id).order("name_norm");
    if (error) throw error;
    return data;
  }

  beforeAll(async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = url;
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = anonKey;
    admin = testAdmin();
    routeAdmin.client = admin;
    [a, b] = await Promise.all([createAccount("a"), createAccount("b")]);
    for (const [account, status, rev] of [[b, "eats", 100], [b, "avoid", 7], [a, "eats", 3]] as const) {
      const name = status === "avoid" ? `${CANARY} avoid` : CANARY;
      const { error } = await account.client.rpc("set_food_membership", {
        p_user: account.id, p_name_norm: account === a ? "favor a own" : name, p_status: status, p_note: null, p_rev: rev,
      });
      if (error) throw error;
    }
    // A's own food, eaten today, so it is a taste item.
    const food = await admin.from("user_foods").insert({ user_id: a.id, name: "Favor canary kiwi", kind: "custom",
      per_100g: { protein: 1, carbohydrate: 15, fat_total: 0.5 } }).select("id").single();
    if (food.error) throw food.error;
    // A judged whole food (the `human_food` facet), as the Eats facet warm would leave it.
    const facet = await admin.from("food_facets").insert({ facet: "human_food", rubric_version: facetRubricVersion("human_food"),
      p: 0.99, model: "canary", food_key: foodKey({ kind: "user_food", id: food.data.id, rev: 1 }),
      input_hash: inputHash({ name: "Favor canary kiwi", brand: null, ingredientsText: null }) });
    if (facet.error) throw facet.error;
    const ref = await a.client.rpc("get_or_create_food_ref", { p_user_id: a.id, p_kind: "user",
      p_catalog_food_id: null, p_user_food_id: food.data.id });
    if (ref.error) throw ref.error;
    const logged = await applyLogEntry(a.client, a.id, { entry_id: crypto.randomUUID(), eaten_at: `${TODAY}T12:00:00.000Z`,
      tz: "UTC", local_date: TODAY, slot: "meal-1", method: "search",
      items: [{ id: crypto.randomUUID(), seq: 1, food_ref_id: ref.data, qty: 1, unit: "g", grams: 120 }] });
    if ("status" in logged && logged.status !== "ok") throw new Error(`log seed: ${logged.status}`);
  });

  async function kiwiItem() {
    resetRateLimits();
    const res = await tasteGET(tasteRequest(a));
    expect(res.status).toBe(200);
    const body = await res.json() as { items: { key: string; favorable: boolean }[] };
    return body.items.find((item) => item.key === `f:${KIWI}`);
  }

  afterAll(async () => {
    for (const id of ids) await admin.auth.admin.deleteUser(id);
  });

  it("the owner-filtered read returns A's marks only; A's session client sees none of them", async () => {
    const mine = await readMembershipRevisions(a.id, ["favor a own", CANARY, `${CANARY} avoid`]);
    expect([...mine.keys()]).toEqual(["favor a own"]);
    expect(mine.get("favor a own")).toMatchObject({ status: "eats", rev: 3 });
    const direct = await a.client.from("food_membership_revisions").select("name_norm");
    expect(direct.data ?? []).toEqual([]);
  });

  it("A cannot favor B's food by a crafted key, even with B's id claimed; B's marks are unchanged", async () => {
    const before = await marksOf(b.id);
    const res = await POST(request(a, `f:${CANARY}`));
    expect(res.status).toBe(404);
    expect((await POST(request(a, `f:${CANARY}`, b.id))).status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(await res.json().catch(() => ({})))).not.toContain(b.id);
    expect(await marksOf(b.id)).toEqual(before);
    expect(before).toHaveLength(2);
  });

  it("a hidden Avoid family mark: favorable false, POST 422, and B untouched", async () => {
    expect(await kiwiItem()).toMatchObject({ favorable: true });
    const { error } = await admin.from("food_membership_revisions").insert({ user_id: a.id, name_norm: KIWI,
      status: "avoid", rev: 1 });
    if (error) throw error;
    // The session client cannot see the mark; the Favor plan reads it owner-scoped.
    expect((await a.client.from("food_membership_revisions").select("name_norm")).data ?? []).toEqual([]);
    const before = { a: await marksOf(a.id), b: await marksOf(b.id) };
    expect(await kiwiItem()).toMatchObject({ favorable: false });
    resetRateLimits();
    const res = await POST(request(a, `f:${KIWI}`));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("nothing_to_favor");
    expect(await marksOf(a.id)).toEqual(before.a);
    expect(await marksOf(b.id)).toEqual(before.b);
  });
});
