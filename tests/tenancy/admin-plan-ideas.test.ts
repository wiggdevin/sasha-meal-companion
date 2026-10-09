/**
 * Spec 3.5 canary for POST /api/plan/ideas and lib/server/plan-ideas.ts: the chip builder reads the
 * day, the foods and the food refs through the service-role client, always with the session
 * user's own id. B's Favored canary food must never reach A's ideas, whether A calls the route
 * (claiming B's id in the account header) or the builder directly, and B's rows stay unchanged.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cookieJar, createRequestClient } from "@/lib/supabase/server";
import { accountHeaderFromCookie } from "@/tests/helpers/account-header";
import { adminClient as testAdmin } from "@/tests/helpers/supabase";

const routeAdmin = vi.hoisted(() => ({ client: null as SupabaseClient | null }));
vi.mock("@/lib/server/admin", () => ({ adminClient: () => routeAdmin.client }));

import { POST } from "@/app/api/plan/ideas/route";
import { planIdeas } from "@/lib/server/plan-ideas";
import { resetRateLimits } from "@/lib/server/ratelimit";

const url = process.env.SUPABASE_TEST_URL ?? "";
const anonKey = process.env.SUPABASE_TEST_ANON_KEY ?? "";
const serviceKey = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY ?? "";
const LOCAL = url.startsWith("http://127.0.0.1") && Boolean(anonKey && serviceKey);
const CANARY = `Canary salmon ${crypto.randomUUID().slice(0, 8)}`;
const DATE = "2099-05-04";

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

describe.skipIf(!LOCAL)("plan ideas isolation (canary)", () => {
  let admin: SupabaseClient;
  let a: Account;
  let b: Account;
  const ids: string[] = [];

  async function createAccount(label: string): Promise<Account> {
    const email = `ideas-${label}-${crypto.randomUUID()}@example.test`;
    const password = `local-${crypto.randomUUID()}-A1!`;
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user) throw created.error ?? new Error("user create failed");
    ids.push(created.data.user.id);
    const client = createClient(url, anonKey, { auth: { persistSession: false } });
    const signed = await client.auth.signInWithPassword({ email, password });
    if (signed.error) throw signed.error;
    const userId = created.data.user.id;
    const settings = await admin.from("user_settings").upsert({ user_id: userId,
      first_opened_at: new Date().toISOString() });
    if (settings.error) throw settings.error;
    const target = await admin.from("target_profiles").insert({ user_id: userId, effective_from: DATE, rev: 1,
      kcal_train: 2000, kcal_rest: 2000, authored_by: "user", mode: "grams", protein_g_min: 120,
      protein_g: 120, fat_g: 70, carb_g: 200,
      training_macros: { kcal: 2000, protein: 120, fat: 70, carbs: 200 },
      rest_macros: { kcal: 2000, protein: 120, fat: 70, carbs: 200 } });
    if (target.error) throw target.error;
    return { id: userId, client, cookie: await cookieFor(client) };
  }

  /** A Favored food of `owner`: its user_foods row, its ref and an `eats` pref. */
  async function favored(owner: string, name: string, per100g: Record<string, number>) {
    const food = await admin.from("user_foods").insert({ user_id: owner, name, kind: "custom",
      per_100g: per100g }).select("id").single();
    if (food.error) throw food.error;
    const ref = await admin.rpc("get_or_create_food_ref", { p_user_id: owner, p_kind: "user",
      p_catalog_food_id: null, p_user_food_id: food.data.id });
    if (ref.error) throw ref.error;
    const pref = await admin.from("user_food_prefs").insert({ user_id: owner, food_ref_id: ref.data,
      status: "eats", role: "protein" });
    if (pref.error) throw pref.error;
  }

  async function rowsOf(id: string) {
    const [foods, prefs] = await Promise.all([
      admin.from("user_foods").select("id,name,rev,deleted_at").eq("user_id", id).order("id"),
      admin.from("user_food_prefs").select("food_ref_id,status").eq("user_id", id).order("food_ref_id"),
    ]);
    return { foods: foods.data, prefs: prefs.data };
  }

  const cardNames = (cards: { items: { name: string }[] }[]) => cards.flatMap((card) => card.items.map((item) => item.name));

  beforeAll(async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = url;
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = anonKey;
    admin = testAdmin();
    routeAdmin.client = admin;
    [a, b] = await Promise.all([createAccount("a"), createAccount("b")]);
    await favored(b.id, CANARY, { protein: 25, carbohydrate: 0, fat_total: 12, energy_kcal: 208 });
  });

  afterAll(async () => {
    for (const id of ids) await admin.auth.admin.deleteUser(id);
  });

  it("the route builds A's ideas from A's foods only, even with B's id claimed", async () => {
    const before = await rowsOf(b.id);
    resetRateLimits();
    const res = await POST(new Request("https://app.test/api/plan/ideas", {
      method: "POST",
      headers: { cookie: a.cookie, ...accountHeaderFromCookie(a.cookie), "x-smc-account": b.id,
        "content-type": "application/json" },
      body: JSON.stringify({ chip: "choose", slot: "meal-2", date: DATE, zone: "UTC" }),
    }));
    if (res.status === 200) expect(cardNames((await res.json()).cards)).not.toContain(CANARY);
    else expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await rowsOf(b.id)).toEqual(before);
  });

  it("the builder, called as A, never reads B's Favored canary", async () => {
    const before = await rowsOf(b.id);
    const answer = await planIdeas(a.client, admin, a.id,
      { chip: "on_hand", slot: "meal-2", date: DATE, zone: "UTC", stated: [CANARY] });
    expect(cardNames(answer.cards)).not.toContain(CANARY);
    expect(await rowsOf(b.id)).toEqual(before);
  });
});
