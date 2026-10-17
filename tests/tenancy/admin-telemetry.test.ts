/**
 * Spec 3.5 canary for the W070 telemetry stores, the service-role writers behind three routes:
 * lib/server/client-timings.ts (`POST /api/timings`), lib/server/food-signals.ts
 * (`POST /api/foods/signals`, `record_food_signals_for`) and lib/server/onboarding-events.ts
 * (`POST /api/onboarding/events`, `record_onboarding_events_for`). Each stamps the session user's
 * id, so B's rows are the canary: A's posts land under A only, even when A sends B's user id or B's
 * own client event ids, and B's rows stay exactly as they were.
 */
// Refuses any non-local database before anything else runs (review r8).
import "./local-only";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cookieJar, createRequestClient } from "@/lib/supabase/server";
import { accountHeaderFromCookie } from "@/tests/helpers/account-header";
import { adminClient as testAdmin } from "@/tests/helpers/supabase";

const routeAdmin = vi.hoisted(() => ({ client: null as SupabaseClient | null }));
vi.mock("@/lib/server/admin", () => ({ adminClient: () => routeAdmin.client }));

import { POST as TIMINGS } from "@/app/api/timings/route";
import { POST as SIGNALS } from "@/app/api/foods/signals/route";
import { POST as ONBOARDING } from "@/app/api/onboarding/events/route";
import { resetRateLimits } from "@/lib/server/ratelimit";

const url = process.env.SUPABASE_TEST_URL ?? "";
const anonKey = process.env.SUPABASE_TEST_ANON_KEY ?? "";
const serviceKey = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY ?? "";
const LOCAL = url.startsWith("http://127.0.0.1") && Boolean(anonKey && serviceKey);

type Account = { id: string; client: SupabaseClient; cookie: string };
const TABLES = ["client_timings", "food_signal_events", "onboarding_events"] as const;

async function cookieFor(client: SupabaseClient): Promise<string> {
  const { data } = await client.auth.getSession();
  const session = data.session!;
  const seed = new Request("https://app.test/seed");
  await createRequestClient(seed).auth.setSession({
    access_token: session.access_token, refresh_token: session.refresh_token,
  });
  return cookieJar(seed).map((c) => `${c.name}=${encodeURIComponent(c.value)}`).join("; ");
}

function request(account: Account, path: string, body: unknown): Request {
  return new Request(`https://app.test${path}`, {
    method: "POST",
    headers: { cookie: account.cookie, ...accountHeaderFromCookie(account.cookie),
      "content-type": "application/json", "x-real-ip": "10.0.0.7" },
    body: JSON.stringify(body),
  });
}

describe.skipIf(!LOCAL)("telemetry stores (canary)", () => {
  let admin: SupabaseClient;
  let a: Account;
  let b: Account;
  const ids: string[] = [];
  const canary = { run: crypto.randomUUID(), signal: crypto.randomUUID(), step: crypto.randomUUID() };

  async function createAccount(label: string): Promise<Account> {
    const email = `telemetry-${label}-${crypto.randomUUID()}@example.test`;
    const password = `local-${crypto.randomUUID()}-A1!`;
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user) throw created.error ?? new Error("user create failed");
    ids.push(created.data.user.id);
    const client = createClient(url, anonKey, { auth: { persistSession: false } });
    const signed = await client.auth.signInWithPassword({ email, password });
    if (signed.error) throw signed.error;
    return { id: created.data.user.id, client, cookie: await cookieFor(client) };
  }

  async function rowsOf(table: (typeof TABLES)[number], owner: string): Promise<string[]> {
    const { data, error } = await admin.from(table).select("*").eq("user_id", owner);
    if (error) throw error;
    return (data ?? []).map((row) => JSON.stringify(row)).sort();
  }
  const allOf = async (owner: string) => Promise.all(TABLES.map((t) => rowsOf(t, owner)));

  beforeAll(async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = url;
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = anonKey;
    admin = testAdmin();
    routeAdmin.client = admin;
    [a, b] = await Promise.all([createAccount("a"), createAccount("b")]);
    const now = new Date().toISOString();
    for (const [table, row] of [
      ["client_timings", { user_id: b.id, run_id: canary.run, path: "barcode", step: "decode", ms: 7 }],
      ["food_signal_events", { user_id: b.id, client_event_id: canary.signal,
        slate_id: crypto.randomUUID(), at: now, local_date: now.slice(0, 10), surface: "plan_sheet",
        kind: "not_this", occasion: "lunch", chosen_key: "catalog:42", offered_keys: ["catalog:42"],
        ranking_version: "o2.1" }],
      ["onboarding_events", { user_id: b.id, client_event_id: canary.step, at: now,
        flow_version: "onboarding_v2", kind: "step_entered", step: "facts" }],
    ] as const) {
      const { error } = await admin.from(table).insert(row);
      if (error) throw error;
    }
  });

  afterAll(async () => {
    for (const id of ids) await admin.auth.admin.deleteUser(id);
  });

  it("A's posts land under A only, and B's canary rows are unchanged", async () => {
    const before = await allOf(b.id);
    resetRateLimits();
    const at = new Date().toISOString();
    const timings = await TIMINGS(request(a, "/api/timings", { rows: [{ run_id: canary.run,
      path: "barcode", step: "lookup", ms: 11, at, user_id: b.id }] }));
    expect(timings.status).toBe(202);
    const signals = await SIGNALS(request(a, "/api/foods/signals", { events: [{
      clientEventId: canary.signal, slateId: crypto.randomUUID(), at, localDate: at.slice(0, 10),
      surface: "swap_sheet", kind: "picked", occasion: "lunch", chosenKey: "catalog:42",
      offeredKeys: ["catalog:42"], rankingVersion: "o2.1" }] }));
    expect(signals.status).toBe(202);
    const onboarding = await ONBOARDING(request(a, "/api/onboarding/events", { events: [{
      clientEventId: canary.step, at, flowVersion: "onboarding_v2", kind: "step_entered",
      step: "allergy" }] }));
    expect(onboarding.status).toBe(202);
    expect(await onboarding.json()).toEqual({ accepted: 1, rejected: 0 });

    expect(await allOf(b.id)).toEqual(before);
    const mine = (await allOf(a.id)).map((rows) => rows.map((r) => JSON.parse(r) as Record<string, unknown>));
    expect(mine[0]).toEqual([expect.objectContaining({ user_id: a.id, run_id: canary.run, step: "lookup" })]);
    expect(mine[1]).toEqual([expect.objectContaining({ user_id: a.id, client_event_id: canary.signal, kind: "picked" })]);
    expect(mine[2]).toEqual([expect.objectContaining({ user_id: a.id, client_event_id: canary.step, step: "allergy" })]);
  });

  it("A's session client cannot write any of the three tables, for A or for B", async () => {
    const before = { a: await allOf(a.id), b: await allOf(b.id) };
    for (const owner of [a.id, b.id]) {
      const timing = await a.client.from("client_timings").insert({ user_id: owner,
        run_id: crypto.randomUUID(), path: "barcode", step: "decode", ms: 1 });
      expect(timing.error?.code).toBe("42501");
      const step = await a.client.rpc("record_onboarding_events_for", { p_user_id: owner,
        p_events: [{ client_event_id: crypto.randomUUID(), at: new Date().toISOString(),
          flow_version: "onboarding_v2", kind: "step_entered", step: "facts" }] });
      expect(step.error?.code).toBe("42501");
    }
    expect({ a: await allOf(a.id), b: await allOf(b.id) }).toEqual(before);
  });
});
