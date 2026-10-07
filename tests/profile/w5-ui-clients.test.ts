// @vitest-environment jsdom
/**
 * Phase 18 W5, UI side: the country list, the profile-pilot read (closed unless the server says
 * `enabled: true`) and the Settings save of one W5 column.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetTestAccount } from "@/tests/helpers/account";
import {
  COUNTRY_CODES, countryFromValue, countryName, countryOptions, countryValue, NO_COUNTRY,
} from "@/lib/profile/countries";
import { PROFILE_PILOT_PATH, readProfilePilot } from "@/lib/profile/profile-pilot-client";
import { savePlaceSetting } from "@/lib/profile/cuisines-client";
import { loadStore } from "@/lib/store";
import { settingsProfileToRow } from "@/lib/sync/user-settings";
import type { Settings } from "@/lib/types";

beforeEach(async () => { await resetTestAccount(); });

describe("the country list", () => {
  it("holds the 249 ISO 3166-1 alpha-2 codes, each once", () => {
    expect(COUNTRY_CODES).toHaveLength(249);
    expect(new Set(COUNTRY_CODES).size).toBe(249);
    expect(COUNTRY_CODES.every((code) => /^[A-Z]{2}$/.test(code))).toBe(true);
  });

  it("offers Prefer not to say, then the United States, then every other country by name", () => {
    const options = countryOptions();
    expect(options.slice(0, 2)).toEqual([
      { value: NO_COUNTRY, label: "Prefer not to say" }, { value: "US", label: "United States" }]);
    expect(options).toHaveLength(250);
    const rest = options.slice(2).map((option) => option.label);
    expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b, "en")));
    expect(countryName("JP")).toBe("Japan");
  });

  it("maps a stored code to the picker and a pick back to what is stored", () => {
    expect(countryValue("US")).toBe("US");
    expect(countryValue(null)).toBe(NO_COUNTRY);
    expect(countryValue("us")).toBe(NO_COUNTRY);
    expect(countryFromValue("CA")).toBe("CA");
    expect(countryFromValue(NO_COUNTRY)).toBeNull();
    expect(countryFromValue("ZZ")).toBeNull();
  });
});

describe("the profile pilot read", () => {
  const answer = (status: number, body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

  it("is on only for a 200 that says enabled: true, read fresh", async () => {
    const fetchImpl = answer(200, { enabled: true });
    expect(await readProfilePilot({ fetchImpl })).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(PROFILE_PILOT_PATH);
    expect(init.cache).toBe("no-store");
  });

  it.each([
    ["enabled: false", answer(200, { enabled: false })],
    ["a string true", answer(200, { enabled: "true" })],
    ["no body field", answer(200, {})],
    ["a 404 (the route not deployed yet)", answer(404, { enabled: true })],
    ["a 500", answer(500, { enabled: true })],
    ["a body that is not JSON", vi.fn(async () => new Response("<html>", { status: 200 }))],
    ["a network failure", vi.fn(async () => { throw new TypeError("offline"); })],
  ])("fails closed on %s", async (_label, fetchImpl) => {
    expect(await readProfilePilot({ fetchImpl: fetchImpl as unknown as typeof fetch })).toBe(false);
  });
});

describe("saving a W5 setting", () => {
  it("queues only the cuisines column, then keeps the list on the phone", async () => {
    const sync = vi.fn(async () => {});
    await savePlaceSetting({ cuisines: ["italian", "korean"] }, { sync });
    const [settings, , fields] = sync.mock.calls[0] as unknown as [Settings, unknown, string[]];
    expect(fields).toEqual(["cuisines"]);
    expect(settingsProfileToRow(settings).cuisines).toEqual(["italian", "korean"]);
    expect(loadStore().settings.cuisines).toEqual(["italian", "korean"]);
  });

  it("queues only the country column, and null clears it", async () => {
    const sync = vi.fn(async () => {});
    await savePlaceSetting({ countryCode: "US" }, { sync });
    await savePlaceSetting({ countryCode: null }, { sync });
    const calls = sync.mock.calls as unknown as [Settings, unknown, string[]][];
    expect(calls.map(([, , fields]) => fields)).toEqual([["countryCode"], ["countryCode"]]);
    expect(settingsProfileToRow(calls[0][0]).country_code).toBe("US");
    expect(settingsProfileToRow(calls[1][0]).country_code).toBeNull();
    expect(loadStore().settings.countryCode).toBeNull();
  });
});
