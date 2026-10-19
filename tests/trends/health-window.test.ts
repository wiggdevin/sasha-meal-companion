import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchDaily, readCachedDaily, writeCachedDaily } from "@/lib/health-client";
import { bindAccount, unbindAccount, type AccountHandle } from "@/lib/device/account";
import { readHealthWindow } from "@/lib/trends/sources";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CACHED = { days: [{ local_date: "2026-09-15", steps: 1300, active_kcal: 96, sleep_minutes: 444,
  body_mass_kg: 57.6, resting_heart_rate: 47, hrv_sdnn: 45, readiness_score: 78, sources: [], provenance: {} }],
sources: [] };
const FRESH = { days: [{ ...CACHED.days[0], local_date: "2026-10-18", sleep_minutes: 400 }], sources: [] };
const store = new Map<string, string>();
let h: AccountHandle;

beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  });
  unbindAccount();
  h = bindAccount(A);
  writeCachedDaily(h, CACHED, new Date("2026-09-15T14:00:00Z"));
});

describe("the week charts' health window (cache: false)", () => {
  it("never overwrites the shared health_daily cache", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(FRESH), { status: 200 }));
    const out = await fetchDaily(h, "2026-09-22", "2026-10-19", { cache: false, fetchImpl });
    expect(out.response?.days[0].local_date).toBe("2026-10-18");
    expect(readCachedDaily(h)?.response).toEqual(CACHED);
  });

  it("answers null, not the cached window, on a 503", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 503 }));
    const out = await fetchDaily(h, "2026-09-22", "2026-10-19", { cache: false, fetchImpl });
    expect(out).toEqual({ response: null, fetchedAt: null, offline: false, disabled: true });
    expect(await readHealthWindow(h, "2026-09-22", "2026-10-19", { fetchImpl })).toEqual({ status: "off" });
  });

  it("answers null, not the cached window, offline", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("offline"); });
    const out = await fetchDaily(h, "2026-09-22", "2026-10-19", { cache: false, fetchImpl });
    expect(out).toEqual({ response: null, fetchedAt: null, offline: true, disabled: false });
    expect(await readHealthWindow(h, "2026-09-22", "2026-10-19", { fetchImpl })).toEqual({ status: "unavailable" });
  });

  it("keeps the default read caching as before", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(FRESH), { status: 200 }));
    await fetchDaily(h, "2026-10-18", "2026-10-18", { fetchImpl });
    expect(readCachedDaily(h)?.response).toEqual(FRESH);
  });
});
