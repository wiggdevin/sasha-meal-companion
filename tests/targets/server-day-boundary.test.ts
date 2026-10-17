// t24b: the server dates target revisions, and reads the revision in force, by the account's day
// (the account's stored zone, when one is on file — owner ruling 2026-10-08, reconciliation audit
// §2 "device-vs-account-timezone-ruling-open" — else the phone's own day), never by the UTC date.
// Fake clocks around local midnight in America/Denver (UTC−6 in October) and Pacific/Auckland
// (UTC+13 in October). Run under TZ=UTC and TZ=America/Denver: nothing here may depend on the
// process zone.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TargetProfile } from "@/lib/api-types";
import {
  ACCOUNT_DAY_LAST_RESORT_ZONE, plausibleClientDay, resolveAccountDay,
} from "@/lib/server/account-day";
import { recomputeDerivedTarget } from "@/lib/server/target-recompute";
import { activeProfile } from "@/lib/server/targets";
import { latestEstimate } from "@/lib/server/expenditure";
import { USER, fakeClient, settingsRow, staleTarget } from "./recompute-fake";

vi.mock("@/lib/server/admin", async () => (await import("@/tests/helpers/admin-fake")).adminModule);

const requireUser = vi.fn();
vi.mock("@/lib/server/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/auth")>("@/lib/server/auth");
  return { ...actual, requireUser: (req: Request) => requireUser(req) };
});
vi.mock("@/lib/server/ratelimit", () => ({ enforceRateLimit: async () => undefined }));
const { GET } = await import("@/app/api/targets/route");

/** 23:30 and 00:30 local either side of midnight; the UTC date is the same on both sides. */
const DENVER = { zone: "America/Denver",
  before: "2026-10-06T05:30:00Z", after: "2026-10-06T06:30:00Z", utcDay: "2026-10-06" };
const AUCKLAND = { zone: "Pacific/Auckland",
  before: "2026-10-05T10:30:00Z", after: "2026-10-05T11:30:00Z", utcDay: "2026-10-05" };

function at(iso: string): void {
  vi.setSystemTime(new Date(iso));
}

/** Two dated revisions: one in force from Oct 5, the next from Oct 6. */
function twoDays(): TargetProfile[] {
  return [staleTarget({ id: "oct5", rev: 1, effective_from: "2026-10-05" }),
    staleTarget({ id: "oct6", rev: 2, effective_from: "2026-10-06" })];
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.stubEnv("HEALTH_TZ", "");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("resolveAccountDay", () => {
  it.each([DENVER, AUCKLAND])("dates by the stored zone either side of midnight: $zone", (city) => {
    const before = resolveAccountDay({ purpose: "t", storedZone: city.zone, now: new Date(city.before) });
    const after = resolveAccountDay({ purpose: "t", storedZone: city.zone, now: new Date(city.after) });
    expect(before).toEqual({ date: "2026-10-05", zone: city.zone, source: "account_zone" });
    expect(after).toEqual({ date: "2026-10-06", zone: city.zone, source: "account_zone" });
    // The UTC date is one of the two answers, never both: it was wrong on one side of midnight.
    expect(new Date(city.before).toISOString().slice(0, 10)).toBe(city.utcDay);
    expect(new Date(city.after).toISOString().slice(0, 10)).toBe(city.utcDay);
  });

  it("uses the request's zone only for an account with no usable stored zone", () => {
    const now = new Date(AUCKLAND.after);
    expect(resolveAccountDay({ purpose: "t", storedZone: null, requestZone: AUCKLAND.zone, now }))
      .toEqual({ date: "2026-10-06", zone: AUCKLAND.zone, source: "request_zone" });
    expect(resolveAccountDay({ purpose: "t", storedZone: "Not/AZone", requestZone: AUCKLAND.zone,
      now }).source).toBe("request_zone");
    expect(resolveAccountDay({ purpose: "t", storedZone: DENVER.zone, requestZone: AUCKLAND.zone,
      now }).date).toBe("2026-10-05");
  });

  it("falls to UTC as the logged last resort, never to the deployment zone", () => {
    const now = new Date(DENVER.before);
    vi.stubEnv("HEALTH_TZ", DENVER.zone);
    expect(resolveAccountDay({ purpose: "GET /api/targets", now })).toEqual({
      date: "2026-10-06", zone: ACCOUNT_DAY_LAST_RESORT_ZONE, source: "utc_last_resort" });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("GET /api/targets"));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("last resort"));
    expect(resolveAccountDay({ purpose: "t", storedZone: AUCKLAND.zone, now }).date)
      .toBe("2026-10-06");
  });

  it("the account's stored zone wins over a travelling phone's own day", () => {
    // The account lives in Auckland (already Oct 6); the phone travels in Denver (still Oct 5).
    const now = new Date(DENVER.before);
    expect(resolveAccountDay({ purpose: "t", storedZone: AUCKLAND.zone, now }).date)
      .toBe("2026-10-06");
    // Even though the phone reports Oct 5, the stored zone is read first and wins outright.
    expect(resolveAccountDay({ purpose: "t", storedZone: AUCKLAND.zone, clientDay: "2026-10-05",
      now })).toEqual({ date: "2026-10-06", zone: AUCKLAND.zone, source: "account_zone" });
  });

  it("falls back to the phone's own day only for an account with no usable stored zone", () => {
    const now = new Date(DENVER.before);
    expect(resolveAccountDay({ purpose: "t", storedZone: null, clientDay: "2026-10-05", now }))
      .toEqual({ date: "2026-10-05", zone: null, source: "client_day" });
    expect(resolveAccountDay({ purpose: "t", storedZone: "Not/AZone", clientDay: "2026-10-05",
      now })).toEqual({ date: "2026-10-05", zone: null, source: "client_day" });
  });

  it("ignores a phone day no zone on Earth can be on", () => {
    const now = new Date(AUCKLAND.before);
    expect(plausibleClientDay("2026-10-04", now)).toBe("2026-10-04");
    expect(plausibleClientDay("2026-10-06", now)).toBe("2026-10-06");
    expect(plausibleClientDay("2026-10-03", now)).toBeNull();
    expect(plausibleClientDay("2026-10-07", now)).toBeNull();
    expect(plausibleClientDay("2026-02-30", now)).toBeNull();
    expect(plausibleClientDay("tomorrow", now)).toBeNull();
    expect(resolveAccountDay({ purpose: "t", storedZone: AUCKLAND.zone, clientDay: "2026-10-09",
      now }).source).toBe("account_zone");
  });
});

describe("server recompute (POST /api/sync/ops) day", () => {
  it.each([DENVER, AUCKLAND])("dates the write by the stored zone, not UTC: $zone", async (city) => {
    for (const [instant, day] of [[city.before, "2026-10-05"], [city.after, "2026-10-06"]]) {
      at(instant);
      const fake = fakeClient(settingsRow({ time_zone: city.zone }), [staleTarget()]);
      const outcome = await recomputeDerivedTarget(fake.client, USER);
      expect(outcome.status).toBe("written");
      expect(fake.writes[0].effective_from).toBe(day);
    }
  });

  it("dates a write by the account's stored zone, even when the phone reports an earlier day (travel)",
    async () => {
      at(DENVER.before); // Auckland: Oct 6 18:30. The travelling phone: Oct 5 23:30.
      const fake = fakeClient(settingsRow({ time_zone: AUCKLAND.zone }), [staleTarget()]);
      await recomputeDerivedTarget(fake.client, USER, { clientDay: "2026-10-05",
        requestZone: DENVER.zone });
      expect(fake.writes[0].effective_from).toBe("2026-10-06");
    });

  it("falls back to the phone's own day when the account has no stored zone", async () => {
    at(DENVER.before);
    const fake = fakeClient(settingsRow({ time_zone: null }), [staleTarget()]);
    await recomputeDerivedTarget(fake.client, USER, { clientDay: "2026-10-05",
      requestZone: DENVER.zone });
    expect(fake.writes[0].effective_from).toBe("2026-10-05");
  });

  it("dates by the request's zone when the account stored none and the phone sent no day", async () => {
    at(AUCKLAND.after);
    const fake = fakeClient(settingsRow({ time_zone: null }), [staleTarget()]);
    await recomputeDerivedTarget(fake.client, USER, { requestZone: AUCKLAND.zone });
    expect(fake.writes[0].effective_from).toBe("2026-10-06");
  });
});

describe("revision in force on the account's day", () => {
  it.each([DENVER, AUCKLAND])("activeProfile without a date reads the stored zone: $zone",
    async (city) => {
      const fake = fakeClient(settingsRow({ time_zone: city.zone }), twoDays());
      at(city.before);
      expect((await activeProfile(fake.client, USER))?.id).toBe("oct5");
      at(city.after);
      expect((await activeProfile(fake.client, USER))?.id).toBe("oct6");
    });

  it("latestEstimate's burn-in day is the account's day", async () => {
    at(DENVER.before);
    const fake = fakeClient(settingsRow({ time_zone: DENVER.zone }), twoDays());
    expect((await latestEstimate(fake.client, USER)).localDate).toBe("2026-10-05");
  });

  it("GET /api/targets answers the account's stored day regardless of ?date=", async () => {
    at(DENVER.before);
    const fake = fakeClient(settingsRow({ time_zone: AUCKLAND.zone }), twoDays());
    requireUser.mockResolvedValue({ userId: USER, client: fake.client });
    const read = async (query: string) => (await (await GET(
      new Request(`https://x.test/api/targets${query}`))).json()).target.id;
    expect(await read("")).toBe("oct6");
    expect(await read("?date=2026-10-05")).toBe("oct6");
    expect(await read("?date=1999-01-01")).toBe("oct6");
  });

  it("GET /api/targets falls back to the phone's own day for an account with no stored zone",
    async () => {
      at(DENVER.before); // UTC day is already 2026-10-06 at this instant.
      const fake = fakeClient(settingsRow({ time_zone: null }), twoDays());
      requireUser.mockResolvedValue({ userId: USER, client: fake.client });
      const read = async (query: string) => (await (await GET(
        new Request(`https://x.test/api/targets${query}`))).json()).target.id;
      expect(await read("?date=2026-10-05")).toBe("oct5");
      expect(await read("")).toBe("oct6"); // no client day sent, no request zone: UTC last resort
    });
});
