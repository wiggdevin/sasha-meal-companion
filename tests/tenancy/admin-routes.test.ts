/**
 * Spec 3.5 (Phase 9 slice 3), route level: each admin-client route runs for real as user A (a
 * session cookie through requireUser, or A's own source token) while user B holds canary rows.
 * Each case asserts that A's response carries no canary of B's, that what A writes carries A's
 * user id, and that every row B owns is unchanged afterwards (accountSnapshot compares values,
 * not counts). Every case calls the route handler itself; the coach route runs with the model
 * adapter stubbed so the exact prompt can be inspected, and the MCP route with real API tokens.
 */
// Refuses any non-local database before anything else runs (review r8).
import "./local-only";
import { accountHeaderFromCookie } from "@/tests/helpers/account-header";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HAS_BRANCH, HAS_DB, adminClient, ensureUser, userClient, type TestUser,
} from "../helpers/supabase";
import {
  dropCatalogFoods, pointRequestClientAtBranch, seedCatalogFood, sessionCookieFor,
} from "../log/fixtures";
import { applyLogEntry } from "@/lib/server/log";
import { issueSourceToken } from "@/lib/server/health-tokens";
import { resetRateLimits } from "@/lib/server/ratelimit";
import { mintToken, toBytea } from "@/lib/server/tokens";
import { accountSnapshot, purge } from "./seed";
import { assertLocalTargets } from "./target-guard";

/** Every model call the coach makes, as plain data, so the exact prompt can be inspected. */
const prompts: string[] = [];
vi.mock("@/lib/ai/adapter", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai/adapter")>()),
  generateStructured: vi.fn(async (...args: unknown[]) => {
    // Plain data only: the call also carries clients, which do not serialize.
    prompts.push(JSON.stringify(args, (_k, v: unknown) => (v !== null && typeof v === "object"
      && !Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype ? undefined : v)));
    return { kind: "final", text: "Eat rice.", suggestions: [] };
  }),
}));

const { POST: coachPOST } = await import("@/app/api/coach/route");
const { POST: mcpPOST } = await import("@/app/api/mcp/route");
const { POST: ingestPOST } = await import("@/app/api/health/ingest/route");
const { POST: tokensPOST } = await import("@/app/api/health/tokens/route");
const { DELETE: tokenDELETE } = await import("@/app/api/health/tokens/[id]/route");
const { POST: ouraDisconnect } = await import("@/app/api/health/oura/disconnect/route");
// Phase 9 slice 1: the start route is a POST answering `{ url }` (the navigation GET is removed).
const { POST: ouraStartPOST } = await import("@/app/api/health/oura/start/route");
const ouraStart = async (request: Request): Promise<Response> => {
  const res = await ouraStartPOST(new Request(request, { method: "POST" }));
  if (!res.ok) return res;
  const { url } = await res.json() as { url: string };
  return new Response(null, { status: 302, headers: { location: url } });
};
const { GET: ouraCallback } = await import("@/app/api/health/oura/callback/route");
const { POST: logCommitPOST } = await import("@/app/api/log/commit/route");
const { POST: weighInPOST, DELETE: weighInDELETE } = await import(
  "@/app/api/health/weigh-in/route");

const CANARY = `canary-${crypto.randomUUID()}`;
const B_DAY = "2020-02-02";
const B_KCAL_TRAIN = 3737;
const B_TDEE = 3939;

async function insert(table: string, row: Record<string, unknown>): Promise<string> {
  const { data, error } = await adminClient().from(table).insert(row).select("*").single();
  if (error) throw new Error(`seed ${table}: ${error.message}`);
  return (data as { id?: string }).id ?? "";
}

/** Phase 9 slice 1: account-data routes also need the `x-smc-account` header of the caller. */
function req(url: string, cookie: string, init: RequestInit = {}): Request {
  return new Request(`https://app.test${url}`, { ...init,
    headers: { "content-type": "application/json", cookie, ...accountHeaderFromCookie(cookie),
      ...(init.headers ?? {}) } });
}

describe.skipIf(!HAS_BRANCH || !HAS_DB)("admin-client routes answer only for their caller", () => {
  let a: TestUser;
  let b: TestUser;
  let asA: SupabaseClient;
  let asB: SupabaseClient;
  let aCookie = "";
  let bCookie = "";
  let bSource = "";
  let bThread = "";

  beforeAll(async () => {
    assertLocalTargets();
    pointRequestClientAtBranch();
    [a, b] = await Promise.all([ensureUser("a"), ensureUser("b")]);
    await purge([a.id, b.id]);
    [asA, asB] = await Promise.all([userClient(a), userClient(b)]);
    [aCookie, bCookie] = await Promise.all([sessionCookieFor(asA), sessionCookieFor(asB)]);

    const foodId = await insert("user_foods", { user_id: b.id, name: `${CANARY} food`,
      kind: "custom" });
    const refId = await insert("food_refs", { kind: "user", user_food_id: foodId });
    await insert("user_food_prefs", { user_id: b.id, food_ref_id: refId, status: "eats",
      note: CANARY });
    bSource = await insert("health_sources", { user_id: b.id, kind: "oura",
      device_label: CANARY, oauth: CANARY });
    await insert("health_samples", { user_id: b.id, source_id: bSource, type: "body_mass",
      value: 91.234, unit: "kg", start_time: `${B_DAY}T08:00:00Z`, end_time: `${B_DAY}T08:00:00Z`,
      tz: "UTC", device_label: "manual", vendor_sample_id: `manual:${B_DAY}` });
    bThread = await insert("coach_threads", { user_id: b.id, title: CANARY });
    await insert("coach_messages", { thread_id: bThread, user_id: b.id, role: "user", seq: 1,
      content: CANARY });
  });

  beforeEach(() => {
    resetRateLimits();
    vi.stubEnv("HEALTH_INGEST_ENABLED", "1");
    vi.stubEnv("COACH_ENABLED", "1");
    vi.stubEnv("OURA_CLIENT_ID", "cid");
    vi.stubEnv("OURA_CLIENT_SECRET", "secret");
    vi.stubEnv("OURA_REDIRECT_URI", "https://app.test/api/health/oura/callback");
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await purge([a.id, b.id]);
  });

  it("coach route: A's turn carries no canary of B's, and B's thread id gets A nothing", async () => {
    const turn = async (cookie: string, threadId: string | null) => {
      const res = await coachPOST(req("/api/coach", cookie, { method: "POST",
        body: JSON.stringify({ threadId, messageId: crypto.randomUUID(),
          text: "what is on my eats list" }) }));
      return { status: res.status, body: await res.text() };
    };

    const forB = await turn(bCookie, null);
    expect(forB.status).toBe(200);
    expect(prompts.join("\n")).toContain(CANARY);
    prompts.length = 0;

    const before = accountSnapshot(b.id);
    const fresh = await turn(aCookie, null);
    const stolen = await turn(aCookie, bThread);
    expect(fresh.status).toBe(200);
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts.join("\n")).not.toContain(CANARY);
    expect(fresh.body + stolen.body).not.toContain(CANARY);
    expect(accountSnapshot(b.id)).toEqual(before);
  });

  it("MCP route: A's token reads and writes only A's account", async () => {
    const tokenFor = async (userId: string) => {
      const { raw, hash } = mintToken();
      await insert("api_tokens", { user_id: userId, label: "tenancy", token_hash: toBytea(hash),
        scopes: ["read", "constraints:write"] });
      return raw;
    };
    const [aToken, bToken] = [await tokenFor(a.id), await tokenFor(b.id)];
    let id = 0;
    const call = async (token: string, name: string, args: Record<string, unknown> = {}) => {
      const res = await mcpPOST(new Request("https://app.test/api/mcp", { method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json",
          accept: "application/json, text/event-stream", "x-real-ip": "10.0.0.2" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call",
          params: { name, arguments: args } }) }));
      expect(res.status).toBe(200);
      return res.text();
    };

    // B's distinct values for every read tool (review r4 finding 1): each tool must return them
    // through B's token, so the A-side check below can only pass on real isolation.
    await insert("target_profiles", { user_id: b.id, effective_from: "2020-01-01",
      kcal_train: B_KCAL_TRAIN, kcal_rest: 1800, authored_by: "user", mode: "grams",
      protein_g: 100, fat_g: 60, carb_g: 200, protein_g_min: 100 });
    await insert("expenditure_estimates", { user_id: b.id, local_date: "2020-01-02",
      engine_version: "tenancy", status: "estimating", tdee_kcal: B_TDEE, reason: CANARY });
    await adminClient().from("constraint_profiles").delete().eq("user_id", b.id);
    await insert("constraint_profiles", { user_id: b.id, notes: CANARY });

    const bSees: Record<string, string> = {
      list_coach_messages: CANARY, get_constraints: CANARY,
      get_targets: String(B_KCAL_TRAIN), get_expenditure_status: String(B_TDEE),
      get_body_data: "91.234",
    };
    const argsFor = (name: string) => (name === "get_body_data" ? { from: B_DAY, to: B_DAY } : {});
    for (const [name, value] of Object.entries(bSees)) {
      expect(await call(bToken, name, argsFor(name))).toContain(value);
    }
    const before = accountSnapshot(b.id);
    for (const [name, value] of Object.entries(bSees)) {
      const forA = await call(aToken, name, argsFor(name));
      expect(forA).not.toContain(value);
      expect(forA).not.toContain(CANARY);
    }

    const note = `a-note-${crypto.randomUUID()}`;
    expect(await call(aToken, "set_constraints", { baseRev: 0, notes: note })).toContain("ok");
    const own = await adminClient().from("constraint_profiles").select("notes")
      .eq("user_id", a.id).single();
    expect(own.error).toBeNull();
    expect(own.data?.notes).toBe(note);
    expect(accountSnapshot(b.id)).toEqual(before);
  });

  it("health ingest: A's token writes samples under A only", async () => {
    const { raw, hash } = issueSourceToken();
    const aSource = await insert("health_sources", { user_id: a.id, kind: "apple_health_shortcut",
      device_label: "tenancy", token_hash: toBytea(hash) });
    const before = accountSnapshot(b.id);
    const res = await ingestPOST(new Request("https://app.test/api/health/ingest", {
      method: "POST", headers: { authorization: `Bearer ${raw}`,
        "content-type": "application/json", "x-real-ip": "10.0.0.1" },
      body: JSON.stringify({ source_kind: "apple_health_shortcut", sent_at: new Date().toISOString(),
        tz: "UTC", samples: [{ type: "step_count", value: 777, unit: "count",
          start_time: "2020-03-03T10:00:00Z", end_time: "2020-03-03T11:00:00Z",
          vendor_sample_id: `tenancy-${crypto.randomUUID()}` }] }) }));
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain(CANARY);
    const written = await adminClient().from("health_samples").select("user_id, source_id")
      .eq("source_id", aSource);
    expect(written.error).toBeNull();
    expect(written.data).toEqual([{ user_id: a.id, source_id: aSource }]);
    expect(accountSnapshot(b.id)).toEqual(before);
  });

  it("health tokens: A's new source is hers, and A cannot revoke B's source by id", async () => {
    const before = accountSnapshot(b.id);
    const issued = await tokensPOST(req("/api/health/tokens", aCookie, { method: "POST",
      body: JSON.stringify({ kind: "health_auto_export", device_label: "tenancy" }) }));
    expect(issued.status).toBe(200);
    const { source } = await issued.json() as { source: { id: string } };
    const row = await adminClient().from("health_sources").select("user_id")
      .eq("id", source.id).single();
    expect(row.data?.user_id).toBe(a.id);

    const revoke = await tokenDELETE(req(`/api/health/tokens/${bSource}`, aCookie,
      { method: "DELETE" }), { params: Promise.resolve({ id: bSource }) });
    expect(revoke.status).toBe(404);
    expect(await revoke.text()).not.toContain(CANARY);
    expect(accountSnapshot(b.id)).toEqual(before);
  });

  it("oura disconnect: A's call leaves B's Oura source and tokens alone", async () => {
    const before = accountSnapshot(b.id);
    const res = await ouraDisconnect(req("/api/health/oura/disconnect", aCookie,
      { method: "POST" }));
    expect(res.status).toBe(404);
    expect(accountSnapshot(b.id)).toEqual(before);
  });

  it("oura start: the state it issues belongs to A", async () => {
    const before = accountSnapshot(b.id);
    const res = await ouraStart(req("/api/health/oura/start", aCookie));
    expect(res.status).toBe(302);
    const states = await adminClient().from("oauth_states").select("user_id")
      .in("user_id", [a.id, b.id]);
    expect(states.error).toBeNull();
    expect(states.data).toEqual([{ user_id: a.id }]);
    expect(accountSnapshot(b.id)).toEqual(before);
  });

  it("oura callback: A's state stores one Oura source under A, twice over, and B's is untouched",
    async () => {
      vi.stubEnv("HEALTH_TOKEN_KEY", Buffer.alloc(32, 7).toString("base64"));
      const real = globalThis.fetch;
      // Oura's token endpoint and API are stubbed; Supabase's requests go to the real fetch.
      vi.stubGlobal("fetch", (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url === "https://api.ouraring.com/oauth/token") {
          return new Response(JSON.stringify({ access_token: "at-a", refresh_token: "rt-a",
            expires_in: 86400, scope: "daily personal" }), { status: 200 });
        }
        if (url.startsWith("https://api.ouraring.com/")) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        return real(input, init);
      }) as typeof fetch);
      const connect = async () => {
        const started = await ouraStart(req("/api/health/oura/start", aCookie));
        const state = new URL(started.headers.get("location") ?? "").searchParams.get("state");
        const res = await ouraCallback(new Request(
          `https://app.test/api/health/oura/callback?state=${state}&code=code-a`));
        return res.headers.get("location");
      };
      try {
        const before = accountSnapshot(b.id);
        // A reconnect updates A's source in place instead of adding a second one.
        expect(await connect()).toBe("https://app.test/settings?oura=connected");
        expect(await connect()).toBe("https://app.test/settings?oura=connected");

        const sources = await adminClient().from("health_sources")
          .select("user_id, oauth, revoked_at").eq("kind", "oura").in("user_id", [a.id, b.id]);
        expect(sources.error).toBeNull();
        const mine = (sources.data ?? []).filter((s) => s.user_id === a.id);
        expect(mine).toHaveLength(1);
        expect(mine[0].revoked_at).toBeNull();
        expect(mine[0].oauth).toEqual(expect.any(String));
        expect(mine[0].oauth).not.toContain("at-a");
        expect(accountSnapshot(b.id)).toEqual(before);
      } finally {
        vi.unstubAllGlobals();
      }
    });

  it("log commit: A's commit on B's entry id changes nothing of B's and returns no canary",
    async () => {
      const food = await seedCatalogFood(adminClient(), a.id, {
        sourceId: `tenancy-log-${crypto.randomUUID()}`, description: "Tenancy log food",
        per100g: { energy_kcal: 100 } });
      const entryId = crypto.randomUUID();
      const itemId = crypto.randomUUID();
      const day = "2020-05-05";
      await applyLogEntry(asB, b.id, { entry_id: entryId, eaten_at: `${day}T12:00:00.000Z`,
        tz: "UTC", local_date: day, slot: "meal-1", method: "search", note: CANARY,
        items: [{ id: itemId, seq: 1, food_ref_id: food.foodRefId, qty: 1, unit: "g", grams: 50 }],
      });
      const before = accountSnapshot(b.id);
      expect(JSON.stringify(before)).toContain(CANARY);
      const res = await logCommitPOST(req("/api/log/commit", aCookie, { method: "POST",
        body: JSON.stringify({ entry_id: entryId, base_rev: 1, eaten_at: `${day}T12:00:00.000Z`,
          tz: "UTC", local_date: day, slot: "meal-1", method: "search", note: "overwrite",
          items: [{ id: itemId, seq: 1, food_ref_id: food.foodRefId, qty: 1, unit: "g",
            grams: 999 }] }) }));
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await res.text()).not.toContain(CANARY);
      expect(accountSnapshot(b.id)).toEqual(before);
      await dropCatalogFoods(adminClient(), "tenancy-log-");
    });

  it("weigh-in: A's save and A's delete on B's day leave B's weigh-in", async () => {
    const before = accountSnapshot(b.id);
    const saved = await weighInPOST(req("/api/health/weigh-in", aCookie, { method: "POST",
      body: JSON.stringify({ localDate: B_DAY, tz: "UTC", lb: 150 }) }));
    expect(saved.status).toBe(200);
    const removed = await weighInDELETE(req(`/api/health/weigh-in?date=${B_DAY}`, aCookie,
      { method: "DELETE" }));
    expect(removed.status).toBe(204);
    expect(accountSnapshot(b.id)).toEqual(before);
    const own = await adminClient().from("health_samples").select("id")
      .eq("user_id", a.id).eq("vendor_sample_id", `manual:${B_DAY}`);
    expect(own.data).toEqual([]);
  });
});
