import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cookieJar, createRequestClient } from "@/lib/supabase/server";
import { accountHeaderFromCookie } from "@/tests/helpers/account-header";
import { adminClient as testAdmin } from "@/tests/helpers/supabase";

const routeAdmin = vi.hoisted(() => ({ client: null as SupabaseClient | null }));
vi.mock("@/lib/server/admin", () => ({ adminClient: () => routeAdmin.client }));

import { GET, POST } from "@/app/api/constraints/review/route";

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

function request(account: Account, body?: unknown, claimedId?: string): Request {
  return new Request("https://app.test/api/constraints/review", {
    method: body ? "POST" : "GET",
    headers: { cookie: account.cookie,
      ...accountHeaderFromCookie(account.cookie),
      ...(claimedId ? { "x-smc-account": claimedId } : {}),
      ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

// B's rule category is the canary: A's session must neither see nor change it.
describe.skipIf(!LOCAL)("historical rule review isolation", () => {
  let admin: SupabaseClient;
  let a: Account;
  let b: Account;
  const ids: string[] = [];

  async function createAccount(label: string): Promise<Account> {
    const email = `rule-review-${label}-${crypto.randomUUID()}@example.test`;
    const password = `local-${crypto.randomUUID()}-A1!`;
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user) throw created.error ?? new Error("user create failed");
    ids.push(created.data.user.id);
    const client = createClient(url, anonKey, { auth: { persistSession: false } });
    const signed = await client.auth.signInWithPassword({ email, password });
    if (signed.error) throw signed.error;
    return { id: created.data.user.id, client, cookie: await cookieFor(client) };
  }

  beforeAll(async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = url;
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = anonKey;
    admin = testAdmin();
    routeAdmin.client = admin;
    [a, b] = await Promise.all([createAccount("a"), createAccount("b")]);
    const rows = await admin.from("constraint_profiles").insert([
      { user_id: a.id, avoid_allergens: ["gluten", "dairy"],
        banned_categories: [], rule_review_required: true },
      { user_id: b.id, avoid_allergens: [],
        banned_categories: ["beans"], rule_review_required: true },
    ]);
    if (rows.error) throw rows.error;
  });

  afterAll(async () => {
    for (const id of ids) await admin.auth.admin.deleteUser(id);
  });

  it("shows each account only its own candidates and denies direct marker edits", async () => {
    const [aResponse, bResponse] = await Promise.all([GET(request(a)), GET(request(b))]);
    expect(aResponse.status).toBe(200);
    expect(bResponse.status).toBe(200);
    expect(await aResponse.json()).toMatchObject({ required: true,
      candidateAllergens: ["gluten", "dairy"], candidateCategories: [] });
    expect(await bResponse.json()).toMatchObject({ required: true,
      candidateAllergens: [], candidateCategories: ["beans"] });

    const marker = await a.client.from("constraint_profiles")
      .update({ rule_review_required: false, rule_reviewed_at: new Date().toISOString() })
      .eq("user_id", a.id);
    expect(marker.error).not.toBeNull();
    const removed = await a.client.from("constraint_profiles").delete().eq("user_id", a.id);
    expect(removed.error).not.toBeNull();
    const cross = await a.client.from("constraint_profiles")
      .update({ notes: "other account" }).eq("user_id", b.id).select("user_id");
    expect(cross.error).toBeNull();
    expect(cross.data).toEqual([]);
  });

  it("requires the matching account and a current revision for atomic review", async () => {
    const choices = { baseRev: 1, choices: {
      allergens: { gluten: "keep", dairy: "remove" }, categories: {},
    } };
    expect((await POST(request(b, choices, a.id))).status).toBe(409);
    const done = await POST(request(a, choices));
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ status: "ok", review: { required: false, rev: 2 } });
    expect((await POST(request(a, choices))).status).toBe(409);
    const [aRow, bRow] = await Promise.all([
      admin.from("constraint_profiles").select("avoid_allergens,rule_review_required,rule_reviewed_at")
        .eq("user_id", a.id).single(),
      admin.from("constraint_profiles").select("banned_categories,rule_review_required,rule_reviewed_at")
        .eq("user_id", b.id).single(),
    ]);
    expect(aRow.data).toMatchObject({ avoid_allergens: ["gluten"], rule_review_required: false });
    expect(aRow.data?.rule_reviewed_at).toEqual(expect.any(String));
    expect(bRow.data).toMatchObject({ banned_categories: ["beans"],
      rule_review_required: true, rule_reviewed_at: null });
  });
});
