import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchDaily, readCachedDaily, writeCachedDaily } from "@/lib/health-client";
import { bindAccount, unbindAccount, type AccountHandle } from "@/lib/device/account";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
/** Phase 9 §0.4: the account's own key. */
const HEALTH_DAILY_CACHE_KEY = `smc:u:${A}:health_daily`;
let h: AccountHandle;

const RESPONSE = { days: [{ local_date: "2026-09-15", steps: 1300, active_kcal: 96,
  sleep_minutes: 444, body_mass_kg: 57.6, resting_heart_rate: 47, hrv_sdnn: 45, readiness_score: 78,
  sources: ["Oura"], provenance: {} }], sources: [] };

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  });
  unbindAccount();
  h = bindAccount(A);
});

describe("the health daily cache", () => {
  it("writes and reads one entry under smc:u:<id>:health_daily with a fetchedAt stamp", () => {
    writeCachedDaily(h, RESPONSE, new Date("2026-09-15T14:00:00Z"));
    expect([...store.keys()]).toEqual([HEALTH_DAILY_CACHE_KEY]);
    expect(readCachedDaily(h)).toEqual({ fetchedAt: "2026-09-15T14:00:00.000Z", response: RESPONSE });
  });

  it("returns null rather than throwing on unusable stored text", () => {
    store.set(HEALTH_DAILY_CACHE_KEY, "{not json");
    expect(readCachedDaily(h)).toBeNull();
  });

  /** P1 (second audit): the pre-T11 build cached rows without `provenance`. */
  it("normalises a row cached before T11 to an empty provenance map", () => {
    store.set(HEALTH_DAILY_CACHE_KEY, JSON.stringify({ fetchedAt: "2026-09-15T14:00:00Z",
      response: { days: [{ local_date: "2026-09-15", steps: 1300, active_kcal: 96,
        sleep_minutes: 444, body_mass_kg: 57.6, sources: ["Oura"] }], sources: [] } }));
    expect(readCachedDaily(h)?.response.days[0].provenance).toEqual({});
  });
});

describe("fetchDaily", () => {
  it("caches a fresh response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(RESPONSE), { status: 200 })));
    const out = await fetchDaily(h, "2026-09-15", "2026-09-15");
    expect(out).toMatchObject({ response: RESPONSE, offline: false, disabled: false });
    expect(readCachedDaily(h)?.response).toEqual(RESPONSE);
  });

  it("normalises a 200 whose rows predate provenance, so nothing downstream can index undefined", async () => {
    const stale = { days: [{ local_date: "2026-09-15", steps: 1300, active_kcal: 96,
      sleep_minutes: 444, body_mass_kg: 57.6, sources: ["Oura"] }], sources: [] };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(stale), { status: 200 })));
    const out = await fetchDaily(h, "2026-09-15", "2026-09-15");
    expect(out.response?.days[0].provenance).toEqual({});
    expect(readCachedDaily(h)?.response.days[0].provenance).toEqual({});
  });

  it("reports disabled on a 503 and does not overwrite the cache", async () => {
    writeCachedDaily(h, RESPONSE, new Date("2026-09-15T14:00:00Z"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    const out = await fetchDaily(h, "2026-09-15", "2026-09-15");
    expect(out.disabled).toBe(true);
    expect(readCachedDaily(h)?.response).toEqual(RESPONSE);
  });

  it("falls back to the cache when the network throws", async () => {
    writeCachedDaily(h, RESPONSE, new Date("2026-09-15T14:00:00Z"));
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    const out = await fetchDaily(h, "2026-09-15", "2026-09-15");
    expect(out).toMatchObject({ response: RESPONSE, offline: true,
      fetchedAt: "2026-09-15T14:00:00.000Z" });
  });
});
