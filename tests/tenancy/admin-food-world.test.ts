/**
 * Spec 3.5 canary for `POST /api/foods/world` and lib/server/food-world.ts (Phase 18 W2b), which
 * write `user_settings.food_world`, the condition confirmations and the review marker on the
 * service-role client. B's settings, conditions and confirmations are the canary: A's session,
 * with or without B's id claimed, must neither read nor change them, and A's own direct PostgREST
 * write to the switch is refused.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cookieJar, createRequestClient } from "@/lib/supabase/server";
import type { FoodWorldRequest } from "@/lib/server/food-world";
import { accountHeaderFromCookie } from "@/tests/helpers/account-header";
import { adminClient as testAdmin } from "@/tests/helpers/supabase";

const routeAdmin = vi.hoisted(() => ({ client: null as SupabaseClient | null }));
vi.mock("@/lib/server/admin", () => ({ adminClient: () => routeAdmin.client }));

import { GET } from "@/app/api/foods/world/route";
import { GET as GETInvitation } from "@/app/api/foods/world/invitation/route";
import { POST } from "@/app/api/foods/world/route";

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

function request(account: Account, body: FoodWorldRequest, claimedId?: string): Request {
  return new Request("https://app.test/api/foods/world", {
    method: "POST",
    headers: { cookie: account.cookie, ...accountHeaderFromCookie(account.cookie),
      ...(claimedId ? { "x-smc-account": claimedId } : {}), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function getRequest(account: Account, path: string, claimedId?: string): Request {
  return new Request(`https://app.test${path}`, {
    headers: { cookie: account.cookie, ...accountHeaderFromCookie(account.cookie),
      ...(claimedId ? { "x-smc-account": claimedId } : {}) },
  });
}

describe.skipIf(!LOCAL)("food world isolation (canary)", () => {
  let admin: SupabaseClient;
  let a: Account;
  let b: Account;
  const ids: string[] = [];

  async function createAccount(label: string): Promise<Account> {
    const email = `food-world-${label}-${crypto.randomUUID()}@example.test`;
    const password = `local-${crypto.randomUUID()}-A1!`;
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user) throw created.error ?? new Error("user create failed");
    ids.push(created.data.user.id);
    const client = createClient(url, anonKey, { auth: { persistSession: false } });
    const signed = await client.auth.signInWithPassword({ email, password });
    if (signed.error) throw signed.error;
    return { id: created.data.user.id, client, cookie: await cookieFor(client) };
  }

  async function state(id: string) {
    const [settings, profile, confirmed] = await Promise.all([
      admin.from("user_settings").select("food_world").eq("user_id", id).single(),
      admin.from("constraint_profiles").select("conditions,avoid_allergens,condition_review_required")
        .eq("user_id", id).single(),
      admin.from("food_world_condition_confirmations").select("condition_key,choice").eq("user_id", id),
    ]);
    return { world: settings.data?.food_world, profile: profile.data, confirmed: confirmed.data };
  }

  beforeAll(async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = url;
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = anonKey;
    admin = testAdmin();
    routeAdmin.client = admin;
    [a, b] = await Promise.all([createAccount("a"), createAccount("b")]);
    for (const account of [a, b]) {
      const settings = await admin.from("user_settings").insert({ user_id: account.id,
        first_opened_at: new Date().toISOString() });
      if (settings.error) throw settings.error;
    }
    const rows = await admin.from("constraint_profiles").insert([
      { user_id: a.id, conditions: ["Celiac"], avoid_allergens: [], banned_categories: [] },
      { user_id: b.id, conditions: ["Celiac", "Gout canary"], avoid_allergens: [], banned_categories: [] },
    ]);
    if (rows.error) throw rows.error;
  });

  beforeEach(() => {
    vi.stubEnv("OPEN_WORLD_ENABLED", "1");
    vi.stubEnv("CONDITION_PACKS_ENABLED", "1");
    vi.stubEnv("OPEN_WORLD_HOLD_USER_IDS", "");
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    for (const id of ids) await admin.auth.admin.deleteUser(id);
  });

  it("A's confirmations and switch reach only A's rows, even with B's id claimed", async () => {
    const before = await state(b.id);
    expect((await POST(request(a, { world: "open" }, b.id))).status).toBeGreaterThanOrEqual(400);
    const answer = await POST(request(a, { world: "open",
      confirmations: [{ condition: "Celiac", choice: "pack" }] }));
    expect(answer.status).toBe(200);
    expect(await state(a.id)).toMatchObject({ world: "open",
      profile: { avoid_allergens: ["gluten"], condition_review_required: false },
      confirmed: [{ condition_key: "celiac", choice: "pack" }] });
    expect(await state(b.id)).toEqual(before);
    expect(before).toMatchObject({ world: "closed", confirmed: [] });
  });

  it("refuses A's direct writes to the switch, the marker and the confirmations", async () => {
    const world = await a.client.from("user_settings").update({ food_world: "closed" }).eq("user_id", a.id);
    expect(world.error).not.toBeNull();
    const marker = await a.client.from("constraint_profiles").update({ condition_review_required: true })
      .eq("user_id", a.id);
    expect(marker.error).not.toBeNull();
    const confirm = await a.client.from("food_world_condition_confirmations")
      .insert({ user_id: b.id, condition_key: "gout canary", choice: "no_limit" });
    expect(confirm.error).not.toBeNull();
    const read = await a.client.from("food_world_condition_confirmations").select("user_id").eq("user_id", b.id);
    expect(read.data ?? []).toEqual([]);
    expect((await state(b.id)).confirmed).toEqual([]);
  });

  it("GET /api/foods/world answers each account's own row, and refuses the other's id claimed", async () => {
    await admin.from("user_settings").update({ food_world: "open" }).eq("user_id", a.id);
    try {
      // A claimed id that is not the session's subject is refused before any row is read.
      const aClaimsB = await GET(getRequest(a, "/api/foods/world", b.id));
      expect(aClaimsB.status).toBe(409);
      const refused = await aClaimsB.json();
      expect(refused).toMatchObject({ error: "account_mismatch" });
      expect(refused).not.toHaveProperty("world");
      const bClaimsA = await GET(getRequest(b, "/api/foods/world", a.id));
      expect(bClaimsA.status).toBe(409);
      expect(await bClaimsA.json()).not.toHaveProperty("world");

      const forA = await GET(getRequest(a, "/api/foods/world"));
      expect(await forA.json()).toEqual({ world: "open", openDefaultPending: false, starterSeed: false });
      const forB = await GET(getRequest(b, "/api/foods/world"));
      expect(await forB.json()).toEqual({ world: "closed", openDefaultPending: false, starterSeed: false });
    } finally {
      await admin.from("user_settings").update({ food_world: "closed" }).eq("user_id", a.id);
    }
  });

  it("invitation: eligible only while closed, released and not held — a held account never sees it (acceptance 4)", async () => {
    // The first case opened A; the invitation is for a closed account.
    await admin.from("user_settings").update({ food_world: "closed" }).eq("user_id", a.id);
    const eligible = await GETInvitation(getRequest(a, "/api/foods/world/invitation"));
    expect(await eligible.json()).toEqual({ eligible: true });

    vi.stubEnv("OPEN_WORLD_HOLD_USER_IDS", a.id);
    const held = await GETInvitation(getRequest(a, "/api/foods/world/invitation"));
    expect(await held.json()).toEqual({ eligible: false });
    // B's own eligibility is unaffected by A's id being held.
    const bStillEligible = await GETInvitation(getRequest(b, "/api/foods/world/invitation"));
    expect(await bStillEligible.json()).toEqual({ eligible: true });
    vi.stubEnv("OPEN_WORLD_HOLD_USER_IDS", "");

    await admin.from("user_settings").update({ food_world: "open" }).eq("user_id", a.id);
    const alreadyOpen = await GETInvitation(getRequest(a, "/api/foods/world/invitation"));
    expect(await alreadyOpen.json()).toEqual({ eligible: false });
    await admin.from("user_settings").update({ food_world: "closed" }).eq("user_id", a.id);

    vi.stubEnv("OPEN_WORLD_ENABLED", "");
    const unreleased = await GETInvitation(getRequest(a, "/api/foods/world/invitation"));
    expect(await unreleased.json()).toEqual({ eligible: false });
  });
});
