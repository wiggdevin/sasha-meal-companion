/**
 * A new Eats mark warms that food's facets off the hot path (lib/foods/prefs-client.ts calling
 * POST /api/foods/facets/warm, debounced). `setFoodMembership` is exercised with no `opts.food`
 * and no `opts.acknowledge`, so the only network this file's own tests reach is the ping itself —
 * the membership op is queued to IndexedDB exactly as the rest of tests/foods/prefs-client.test.ts
 * already proves.
 *
 * Real timers throughout: fake-indexeddb schedules its own callbacks on real timers, so faking
 * them would deadlock the membership write this debounce follows. `__setEatsFacetWarmDebounceMsForTests`
 * shortens the production 2s delay instead, so each case still proves the debounce without a slow test.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetEatsFacetWarmTimers, __resetFoodMembershipState, __setEatsFacetWarmDebounceMsForTests,
  setFoodMembership,
} from "@/lib/foods/prefs-client";
import { resetTestAccount } from "@/tests/helpers/account";
import type { AccountHandle } from "@/lib/device/account";

let h: AccountHandle;
/** The RPC branch is never reached (no `acknowledge`); this only has to satisfy the type. */
const noopSupabase = {} as SupabaseClient;
/**
 * Generous on purpose: this races real wall-clock time against a possibly busy CI/dev machine.
 * The gap between marks in the burst case is a small FIXED amount, never a fraction of this, so a
 * slow tick between marks cannot itself look like the debounce window elapsing.
 */
const DEBOUNCE_MS = 400;
const SETTLE_MS = DEBOUNCE_MS + 800;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(async () => {
  h = await resetTestAccount();
  globalThis.indexedDB = new IDBFactory();
  __resetFoodMembershipState();
  __resetEatsFacetWarmTimers();
  __setEatsFacetWarmDebounceMsForTests(DEBOUNCE_MS);
});

afterEach(() => {
  __resetEatsFacetWarmTimers();
  vi.unstubAllGlobals();
});

function stubFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Eats facet warm ping", () => {
  it("fires one POST to the warm route after the debounce window", async () => {
    const fetchMock = stubFetch();
    await setFoodMembership("Rice pouch", "eats", { account: h, supabase: noopSupabase });
    // No wait at all: a timer scheduled this tick cannot have fired yet, on any machine.
    expect(fetchMock).not.toHaveBeenCalled();
    await wait(SETTLE_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/foods/facets/warm");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("x-smc-account")).toBe(h.userId);
  }, 15_000);

  it("debounces a burst of Eats marks into exactly one request", async () => {
    const fetchMock = stubFetch();
    for (const name of ["Rice pouch", "Pear pouch", "Granola bar"]) {
      await setFoodMembership(name, "eats", { account: h, supabase: noopSupabase });
      await wait(20);
    }
    await wait(SETTLE_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("never fires for an Avoid mark", async () => {
    const fetchMock = stubFetch();
    await setFoodMembership("Broccoli", "avoid", { account: h, supabase: noopSupabase });
    await wait(SETTLE_MS);
    expect(fetchMock).not.toHaveBeenCalled();
  }, 15_000);

  it("never throws into the caller when the ping itself rejects", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    await expect(setFoodMembership("Rice pouch", "eats", { account: h, supabase: noopSupabase }))
      .resolves.toBeNull();
    await wait(SETTLE_MS);
  }, 15_000);
});
