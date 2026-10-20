/**
 * UI makeover W8 §7.4: the store search behind the build flow's map (lib/server/places.ts). Fixed
 * hosts, an honest User-Agent or no call, a country on every geocode, rounded points, the global
 * Nominatim limit, and upstream trouble as 503 `places_unavailable` with logs that carry the status
 * only — never the area, the query or a coordinate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/server/auth";

vi.mock("server-only", () => ({}));
const limiter = vi.hoisted(() => ({ enforce: vi.fn() }));
vi.mock("@/lib/server/ratelimit", () => ({ enforceRateLimit: limiter.enforce }));

const places = await import("@/lib/server/places");
const { geocodePlace, nearbyStores, placesUserAgent, geocodeUrl, PLACES_UNAVAILABLE_MESSAGE, PlacesCache,
  storesQuery, OVERPASS_OUT_MAX } = places;

const ENV = { VERCEL_PROJECT_PRODUCTION_URL: "meals.example.app" };
/** The start of a Nominatim window, where a call may go out at once. */
const EARLY = () => 2_000_000;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});
const AREA = "Mission District San Francisco";
const HIT = [{ lat: "37.759865", lon: "-122.414798",
  display_name: "Mission District, San Francisco, California, 94110, United States" }];

/** Every console line written during a test, joined, for the "no query in logs" checks. */
let logged = "";
beforeEach(() => {
  vi.clearAllMocks();
  limiter.enforce.mockResolvedValue(undefined);
  logged = "";
  for (const level of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged += `${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`;
    });
  }
});
afterEach(() => { vi.restoreAllMocks(); });

async function refusal(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    return error as HttpError;
  }
  throw new Error("expected a refusal");
}

describe("the User-Agent", () => {
  it("names the app and its production address", () => {
    expect(placesUserAgent(ENV)).toMatch(/^[A-Za-z]+\/1\.0 \(\+https:\/\/meals\.example\.app\)$/);
    expect(placesUserAgent({ VERCEL_PROJECT_PRODUCTION_URL: "https://meals.example.app/" }))
      .toBe(placesUserAgent(ENV));
  });

  it("is null without a production address, or with one that is not a host", () => {
    expect(placesUserAgent({})).toBeNull();
    expect(placesUserAgent({ VERCEL_PROJECT_PRODUCTION_URL: "  " })).toBeNull();
    expect(placesUserAgent({ VERCEL_PROJECT_PRODUCTION_URL: "not a host" })).toBeNull();
  });

  it("missing: 503 places_unavailable and no fetch, no limiter, for either call", async () => {
    const fetch = vi.fn();
    for (const call of [() => geocodePlace(AREA, "US", { fetch, env: {} }),
      () => nearbyStores(37.76, -122.41, { fetch, env: {} })]) {
      const error = await refusal(call());
      expect(error.status).toBe(503);
      expect(error.code).toBe("places_unavailable");
      expect(error.message).toBe(PLACES_UNAVAILABLE_MESSAGE);
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(limiter.enforce).not.toHaveBeenCalled();
  });
});

describe("geocodePlace", () => {
  it("rounds the point to 2 decimals and keeps a short label", async () => {
    const fetch = vi.fn().mockResolvedValue(json(HIT));
    expect(await geocodePlace(AREA, "us", { fetch, env: ENV, now: EARLY }))
      .toEqual({ lat: 37.76, lon: -122.41, label: "Mission District, San Francisco" });
  });

  it("asks Nominatim's fixed host with free text and the country code, and the User-Agent", async () => {
    const fetch = vi.fn().mockResolvedValue(json(HIT));
    await geocodePlace(AREA, "US", { fetch, env: ENV, now: EARLY });
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://nominatim.openstreetmap.org");
    expect(parsed.pathname).toBe("/search");
    expect(parsed.searchParams.get("q")).toBe(AREA);
    expect(parsed.searchParams.get("countrycodes")).toBe("us");
    expect(parsed.searchParams.get("postalcode")).toBeNull();
    expect(parsed.searchParams.get("limit")).toBe("1");
    expect((init.headers as Record<string, string>)["user-agent"]).toBe(placesUserAgent(ENV));
  });

  it("a postal code uses the structured postalcode query filtered by countrycodes, never free text", async () => {
    for (const zip of ["94110", "94110-1234"]) {
      const parsed = new URL(geocodeUrl(zip, "US"));
      expect(parsed.searchParams.get("postalcode")).toBe(zip);
      expect(parsed.searchParams.get("countrycodes")).toBe("us");
      expect(parsed.searchParams.get("q")).toBeNull();
      // The structured `country` matches a name, not a code: never sent.
      expect(parsed.searchParams.get("country")).toBeNull();
    }
    const gb = new URL(geocodeUrl("SW1A 1AA", "GB")).searchParams;
    expect([gb.get("postalcode"), gb.get("countrycodes"), gb.get("country")]).toEqual(["SW1A 1AA", "gb", null]);
    expect(new URL(geocodeUrl("M5V 2T6", "CA")).searchParams.get("postalcode")).toBe("M5V 2T6");
    expect(new URL(geocodeUrl("SW1A 1AA", "GB")).searchParams.get("postalcode")).toBe("SW1A 1AA");
    expect(new URL(geocodeUrl("75011", "FR")).searchParams.get("postalcode")).toBe("75011");
    // A street address with a number is free text.
    expect(new URL(geocodeUrl("10 Main Street", "US")).searchParams.get("q")).toBe("10 Main Street");
  });

  it("no country never centres the map: 400, no limiter, no fetch", async () => {
    const fetch = vi.fn();
    for (const country of ["", "USA", "1A", undefined as unknown as string]) {
      const error = await refusal(geocodePlace(AREA, country, { fetch, env: ENV, now: EARLY }));
      expect(error.status).toBe(400);
      expect(error.code).toBe("country_required");
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(limiter.enforce).not.toHaveBeenCalled();
  });

  it("takes the global Nominatim slot before every call", async () => {
    const fetch = vi.fn().mockResolvedValue(json(HIT));
    await geocodePlace(AREA, "US", { fetch, env: ENV, now: EARLY });
    expect(limiter.enforce).toHaveBeenCalledWith("places:nominatim", 1, 2);
    expect(limiter.enforce.mock.invocationCallOrder[0]).toBeLessThan(fetch.mock.invocationCallOrder[0]);
  });

  it("waits out a busy global slot once, then answers 503 without calling", async () => {
    const busy = new HttpError(429, "rate_limited", "Too many requests.");
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetch = vi.fn().mockResolvedValue(json(HIT));
    limiter.enforce.mockRejectedValueOnce(busy);
    expect((await geocodePlace(AREA, "US", { fetch, env: ENV, now: EARLY, sleep })).lat).toBe(37.76);
    expect(sleep).toHaveBeenCalledTimes(1);

    fetch.mockClear();
    limiter.enforce.mockRejectedValue(busy);
    const error = await refusal(geocodePlace(AREA, "US", { fetch, env: ENV, now: EARLY, sleep }));
    expect(error.status).toBe(503);
    expect(error.code).toBe("places_unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never sends late in a window: a late slot waits for the next window's start", async () => {
    // 1.5 s into a 2 s window, then 0.01 s into the next one.
    const times = [2_001_500, 2_001_500, 2_002_010];
    const now = () => times.length > 1 ? times.shift()! : times[0];
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetch = vi.fn().mockResolvedValue(json(HIT));
    await geocodePlace(AREA, "US", { fetch, env: ENV, sleep, now });
    expect(sleep).toHaveBeenCalledWith(500);
    expect(limiter.enforce).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reads lateness from the limiter's window, so a grant at the end of one window is late here", async () => {
    // Granted at 1.98 s of the window ending at 2_002_000 (database clock); the answer reaches
    // this instance 20 ms after that window turned, which its own clock would call "early".
    limiter.enforce.mockResolvedValueOnce(2_002_000).mockResolvedValueOnce(2_004_000);
    const times = [2_002_020, 2_002_020, 2_002_030];
    const now = () => times.length > 1 ? times.shift()! : times[0];
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetch = vi.fn().mockResolvedValue(json(HIT));
    await geocodePlace(AREA, "US", { fetch, env: ENV, sleep, now });
    expect(sleep).toHaveBeenCalledWith(0);
    expect(limiter.enforce).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("answers 503 without calling when both slots come late", async () => {
    const fetch = vi.fn().mockResolvedValue(json(HIT));
    const error = await refusal(geocodePlace(AREA, "US", { fetch, env: ENV,
      sleep: async () => undefined, now: () => 2_001_950 }));
    expect(error.code).toBe("places_unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("upstream 429 or 5xx → 503 places_unavailable", async () => {
    for (const status of [429, 500, 503]) {
      const fetch = vi.fn().mockResolvedValue(json({ error: "busy" }, status));
      const error = await refusal(geocodePlace(AREA, "US", { fetch, env: ENV, now: EARLY }));
      expect(error.status).toBe(503);
      expect(error.code).toBe("places_unavailable");
      expect(error.message).toBe(PLACES_UNAVAILABLE_MESSAGE);
    }
    expect(logged).toContain("status 429");
  });

  it("a timeout → 503 places_unavailable", async () => {
    const fetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    const error = await refusal(geocodePlace(AREA, "US", { fetch: fetch as unknown as typeof globalThis.fetch,
      env: ENV, now: EARLY, nominatimMs: 10 }));
    expect(error.status).toBe(503);
    expect(error.code).toBe("places_unavailable");
    expect(logged).toContain("timeout");
  });

  it("a network error or a malformed answer → 503", async () => {
    const down = vi.fn().mockRejectedValue(new TypeError(`fetch failed for ${AREA}`));
    expect((await refusal(geocodePlace(AREA, "US", { fetch: down, env: ENV, now: EARLY }))).code).toBe("places_unavailable");
    const odd = vi.fn().mockResolvedValue(json({ not: "a list" }));
    expect((await refusal(geocodePlace(AREA, "US", { fetch: odd, env: ENV, now: EARLY }))).code).toBe("places_unavailable");
  });

  it("no match is 404 place_not_found", async () => {
    const fetch = vi.fn().mockResolvedValue(json([]));
    const error = await refusal(geocodePlace("Nowhereville", "US", { fetch, env: ENV, now: EARLY }));
    expect(error.status).toBe(404);
    expect(error.code).toBe("place_not_found");
  });

  it("logs carry the status only: never the area, the ZIP or a coordinate", async () => {
    for (const [q, status] of [[AREA, 429], ["94110", 500]] as const) {
      await refusal(geocodePlace(q, "US", { fetch: vi.fn().mockResolvedValue(json([], status)), env: ENV, now: EARLY }));
    }
    await refusal(geocodePlace(AREA, "US", { fetch: vi.fn().mockRejectedValue(new TypeError(AREA)), env: ENV, now: EARLY }));
    expect(logged).not.toBe("");
    for (const secret of ["Mission", "94110", "San Francisco", "37.7", "-122.4"]) expect(logged).not.toContain(secret);
  });
});

const store = (id: number, name: string, lat: number, lon: number, type = "node") =>
  (type === "node" ? { type, id, lat, lon, tags: { shop: "supermarket", name } }
    : { type, id, center: { lat, lon }, tags: { shop: "supermarket", name } });

describe("nearbyStores", () => {
  it("asks Overpass's fixed host with [timeout:8], the grocery shops, 4 km and the rounded point", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ elements: [
      store(1, "Rainbow Grocery", 37.7695, -122.4155), store(2, "Bi-Rite Market", 37.7616, -122.4256),
      store(3, "Safeway", 37.7643, -122.4310, "way"),
    ] }));
    const stores = await nearbyStores(37.759865, -122.414798, { fetch, env: ENV, now: EARLY });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://overpass-api.de/api/interpreter");
    expect(init.method).toBe("POST");
    const query = new URLSearchParams(String(init.body)).get("data") ?? "";
    expect(query.startsWith("[out:json][timeout:8];")).toBe(true);
    expect(query).toContain("(around:4000,37.76,-122.41)");
    expect(query).toContain("supermarket|grocery|greengrocer");
    expect(query).toContain("[\"name\"]");
    expect(query).not.toContain("37.7598");
    expect((init.headers as Record<string, string>)["user-agent"]).toBe(placesUserAgent(ENV));
    // Nearest first, distances in whole metres from the rounded point, ids typed.
    expect(stores.map((s) => s.name)).toEqual(["Rainbow Grocery", "Bi-Rite Market", "Safeway"]);
    expect(stores.every((s, i, all) => i === 0 || all[i - 1].distanceM <= s.distanceM)).toBe(true);
    expect(stores.every((s) => Number.isInteger(s.distanceM))).toBe(true);
    expect(stores.find((s) => s.name === "Safeway")?.id).toBe("way/3");
  });

  it("asks once more within 8 km when fewer than 3 stores are within 4 km", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ elements: [store(1, "Corner Grocer", 37.761, -122.411)] }))
      .mockResolvedValueOnce(json({ elements: [store(1, "Corner Grocer", 37.761, -122.411),
        store(2, "Far Market", 37.80, -122.44), store(3, "Farther Foods", 37.72, -122.45)] }));
    const stores = await nearbyStores(37.76, -122.41, { fetch, env: ENV, now: EARLY });
    expect(fetch).toHaveBeenCalledTimes(2);
    const second = new URLSearchParams(String((fetch.mock.calls[1] as [string, RequestInit])[1].body)).get("data");
    expect(second).toContain("(around:8000,37.76,-122.41)");
    expect(stores).toHaveLength(3);
  });

  it("never retries more than once, and keeps the first answer when the retry fails", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ elements: [store(1, "Corner Grocer", 37.761, -122.411)] }))
      .mockResolvedValueOnce(json({ error: "busy" }, 429));
    const stores = await nearbyStores(37.76, -122.41, { fetch, env: ENV, now: EARLY });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(stores.map((s) => s.name)).toEqual(["Corner Grocer"]);
  });

  it("drops unnamed rows, collapses a store's node and building, and caps the list at 25", async () => {
    const many = Array.from({ length: 40 }, (_, i) => store(100 + i, `Store ${i}`, 37.76 + i * 0.0005, -122.41));
    const fetch = vi.fn().mockResolvedValue(json({ elements: [
      { type: "node", id: 1, lat: 37.7601, lon: -122.41, tags: { shop: "grocery" } },
      store(2, "Twin Market", 37.7602, -122.4101), store(3, "Twin Market", 37.7603, -122.4101, "way"),
      ...many,
    ] }));
    const stores = await nearbyStores(37.76, -122.41, { fetch, env: ENV, now: EARLY });
    expect(stores).toHaveLength(25);
    expect(stores.filter((s) => s.name === "Twin Market")).toHaveLength(1);
    expect(new Set(stores.map((s) => s.id)).size).toBe(25);
  });

  it("upstream 429 or a timeout → 503 places_unavailable, and the log has no coordinate", async () => {
    const busy = vi.fn().mockResolvedValue(json({}, 429));
    expect((await refusal(nearbyStores(37.759865, -122.414798, { fetch: busy, env: ENV, now: EARLY }))).code)
      .toBe("places_unavailable");
    const hang = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    const error = await refusal(nearbyStores(37.759865, -122.414798, {
      fetch: hang as unknown as typeof globalThis.fetch, env: ENV, now: EARLY, overpassMs: 10 }));
    expect(error.status).toBe(503);
    expect(error.message).toBe(PLACES_UNAVAILABLE_MESSAGE);
    expect(logged).toContain("status 429");
    expect(logged).toContain("timeout");
    for (const secret of ["37.7", "-122.4"]) expect(logged).not.toContain(secret);
  });

  it("asks Overpass for far more than it keeps, so the nearest are never cut by id order", async () => {
    expect(OVERPASS_OUT_MAX).toBeGreaterThanOrEqual(400);
    expect(storesQuery(37.76, -122.41, 4_000)).toContain(`out center ${OVERPASS_OUT_MAX};`);
    // 120 stores, the nearest carrying the highest ids: the 25 kept are the 25 nearest.
    const elements = Array.from({ length: 120 }, (_, i) => ({ type: "node", id: i + 1,
      lat: 37.76 + (120 - i) * 0.0002, lon: -122.41, tags: { shop: "supermarket", name: `Store ${i + 1}` } }));
    const stores = await nearbyStores(37.76, -122.41, { fetch: vi.fn(async () => json({ elements })), env: ENV, now: EARLY });
    expect(stores).toHaveLength(25);
    expect(stores[0].name).toBe("Store 120");
    expect(stores.map((row) => row.name)).not.toContain("Store 1");
  });

  it("takes the Overpass app slot, never the Nominatim one", async () => {
    await nearbyStores(37.76, -122.41, { fetch: vi.fn(async () => json({ elements: [] })), env: ENV, now: EARLY });
    const keys = limiter.enforce.mock.calls.map((call: unknown[]) => call[0]);
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys)).toEqual(new Set(["places:overpass"]));
  });

  it("answers a refused Overpass slot (twice) with 503 and no upstream call", async () => {
    const fetcher = vi.fn(async () => json({ elements: [] }));
    limiter.enforce.mockRejectedValue(new HttpError(429, "rate_limited", "slow down"));
    await expect(nearbyStores(37.76, -122.41, { fetch: fetcher, env: ENV, now: EARLY, sleep: async () => undefined }))
      .rejects.toMatchObject({ status: 503, code: "places_unavailable" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("serves a repeated point from the cache with one upstream call", async () => {
    const stores = Array.from({ length: 4 }, (_, i) => ({ type: "node", id: i + 1, lat: 37.76, lon: -122.41,
      tags: { shop: "supermarket", name: `Store ${i}` } }));
    const fetcher = vi.fn(async () => json({ elements: stores }));
    const cache = new PlacesCache();
    const first = await nearbyStores(37.761, -122.412, { fetch: fetcher, env: ENV, now: EARLY, cache });
    const second = await nearbyStores(37.759, -122.409, { fetch: fetcher, env: ENV, now: EARLY, cache });
    expect(second).toEqual(first);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
