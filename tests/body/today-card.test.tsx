/**
 * T11a — Body data formatting and the tab bar.
 *
 * Vitest runs in the Node environment and React Testing Library is not installed (Sol harness), so
 * every assertion here is a static render or a pure helper: the four values with their sources, the
 * empty state, the tap-through href, the tab-bar gate, and the tri-state capability cache.
 * The 320 px five-target check stays a manual phone gate — it is not asserted here (Sol, T11a).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import BodyTodayCardView, { type TodayCardRow } from "@/components/BodyTodayCard";
import TabBar, { tabBarLayout } from "@/components/TabBar";
import {
  BODY_CAPABILITY_KEY, probeBodyCapability, readBodyCapability, resetBodyCapabilityForTests,
} from "@/lib/health/capability";
import { shouldProbeBody } from "@/lib/health/capability-client";
import { fetchDaily } from "@/lib/health-client";
import { bindAccount, markAccountReady, unbindAccount } from "@/lib/device/account";
import type { DailyHealthRow } from "@/lib/health/contract";

vi.mock("next/navigation", () => ({
  usePathname: vi.fn(() => "/"),
  useRouter: () => ({ push: vi.fn() }),
}));

const DAY: DailyHealthRow = {
  local_date: "2026-09-15", steps: 1300, active_kcal: 96, sleep_minutes: 444,
  body_mass_kg: 57.6, resting_heart_rate: 47, hrv_sdnn: 45, readiness_score: 78,
  sources: ["Apple Watch", "Withings"],
  provenance: {
    step_count: { kind: "health_auto_export", end: "2026-09-15T22:30:00Z" },
    active_energy: { kind: "apple_health_shortcut", end: "2026-09-15T23:30:00Z" },
    sleep_asleep: { kind: "oura", end: "2026-09-15T12:00:00Z" },
    body_mass: { kind: "manual", end: "2026-09-15T11:12:00Z" },
  },
};

function store(): Map<string, string> {
  return new Map<string, string>();
}

let session: Map<string, string> = store();
let local: Map<string, string> = store();

/** `useNarrowViewport`, `useBodyCapability` and the daily cache touch these globals in the browser. */
function stubBrowserGlobals(): void {
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => local.get(k) ?? null,
    setItem: (k: string, v: string) => { local.set(k, v); },
    removeItem: (k: string) => { local.delete(k); },
  });
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => session.get(k) ?? null,
    setItem: (k: string, v: string) => { session.set(k, v); },
    removeItem: (k: string) => { session.delete(k); },
  });
  vi.stubGlobal("window", {
    sessionStorage: globalThis.sessionStorage,
    localStorage: globalThis.localStorage,
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  });
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
}

beforeEach(() => {
  session = store();
  local = store();
  stubBrowserGlobals();
  resetBodyCapabilityForTests();
  // The probe asks as the ready account (PR #248 review r3 #1).
  unbindAccount();
  markAccountReady(bindAccount("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"));
  /* The card prints a local wall-clock time; pin the zone so the exact strings are deterministic. */
  vi.stubEnv("TZ", "UTC");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetBodyCapabilityForTests();
});

/** React SSR separates adjacent text nodes with `<!-- -->`; assertions want the text she reads. */
function plain(markup: string): string {
  return markup.replaceAll("<!-- -->", "");
}

describe("todayCardRows", () => {
  it("lists the viewed day's steps, device energy, sleep and weight in that order", async () => {
    const { todayCardRows } = await import("@/components/BodyTodayCard");
    const rows = todayCardRows(DAY);
    expect(rows.map((r) => r.key))
      .toEqual(["step_count", "active_energy", "sleep_asleep", "body_mass"]);
    expect(rows[0].value).toBe("1,300 steps");
    expect(rows[0].source).toBe("Apple Health");
    expect(rows[1]).toMatchObject({ label: "Device active energy", value: "96 kcal",
      meta: "Device estimate · not added to your food target" });
    expect(rows[2].value).toBe("7:24");
    expect(rows[2].source).toBe("Oura");
    expect(rows[3].value).toBe("127 lb");
    expect(rows[3].source).toBe("Typed in");
  });

  it("shows weight in the account's unit (OD20)", async () => {
    const { todayCardRows } = await import("@/components/BodyTodayCard");
    const kg = todayCardRows(DAY, "kg").find((r) => r.key === "body_mass");
    expect(kg?.value).toMatch(/ kg$/);
    expect(kg?.value).not.toMatch(/lb/);
  });

  it("omits missing steps and device energy instead of substituting trend copy", async () => {
    const { todayCardRows } = await import("@/components/BodyTodayCard");
    const rows = todayCardRows({ ...DAY, steps: null, active_kcal: null });
    expect(rows.some((row) => row.key === "step_count")).toBe(false);
    expect(rows.some((row) => row.key === "active_energy")).toBe(false);
  });

  it("spells sleep as h:mm with zero-padded minutes", async () => {
    const { sleepText } = await import("@/components/BodyTodayCard");
    expect(sleepText(444)).toBe("7:24");
    expect(sleepText(425)).toBe("7:05");
    expect(sleepText(60)).toBe("1:00");
    expect(sleepText(59)).toBe("0:59");
    expect(sleepText(0)).toBe("0:00");
  });

  it("prints the exact local as-of time, and em dash when it cannot be read", async () => {
    const { asOfText } = await import("@/components/BodyTodayCard");
    expect(asOfText("2026-09-15T22:30:00Z")).toBe("10:30 PM");
    expect(asOfText("2026-09-15T09:05:00Z")).toBe("9:05 AM");
    expect(asOfText("2026-09-15T00:07:00Z")).toBe("12:07 AM");
    expect(asOfText(null)).toBe("—");
    expect(asOfText("not a time")).toBe("—");
  });

  it("has no rows for a day with nothing recorded", async () => {
    const { todayCardRows } = await import("@/components/BodyTodayCard");
    expect(todayCardRows({
      local_date: "2026-09-15", steps: null, active_kcal: null, sleep_minutes: null,
      body_mass_kg: null, resting_heart_rate: null, hrv_sdnn: null, readiness_score: null,
      sources: [], provenance: {},
    })).toEqual([]);
  });

  it("still lists the values of a day that carries no provenance at all (pre-T11 row)", async () => {
    const { todayCardRows } = await import("@/components/BodyTodayCard");
    const legacy = { local_date: "2026-09-15", steps: 1300, active_kcal: 96, sleep_minutes: 444,
      body_mass_kg: 57.6, resting_heart_rate: null, hrv_sdnn: null, readiness_score: null,
      sources: ["Oura"],
      provenance: undefined as unknown as DailyHealthRow["provenance"] };
    const rows = todayCardRows(legacy);
    expect(rows.map((r) => r.key)).toEqual(["step_count", "active_energy", "sleep_asleep", "body_mass"]);
    expect(rows[0]).toMatchObject({ asOf: null, source: "Other" });
  });
});

describe("BodyTodayCard", () => {
  it("is loaded: it renders the four values with a source glyph, the source name and an"
    + " as-of time", () => {
    const markup = renderToStaticMarkup(<BodyTodayCardView day={DAY} />);
    expect(markup).toContain("1,300 steps");
    expect(markup).toContain("7:24");
    expect(markup).toContain('<span class="kcal font-semibold tabular-nums">96</span> kcal');
    expect(markup).toContain("Device estimate · not added to your food target");
    expect(markup).toContain("127 lb");
    expect(markup).toContain("Apple Health");
    expect(markup).toContain("Oura");
    expect(markup).toContain("Typed in");
    expect(markup).toContain("as of ");
  });

  it("reads each row's source and as-of time exactly", () => {
    const markup = plain(renderToStaticMarkup(<BodyTodayCardView day={DAY} />));
    expect(markup).toContain("Apple Health · as of 10:30 PM");
    expect(markup).toContain("Device estimate · not added to your food target");
    expect(markup).toContain("Oura · as of 12:00 PM");
    expect(markup).toContain("Typed in · as of 11:12 AM");
  });

  it("is a link to /body and honours the 44 px tap target", () => {
    const markup = renderToStaticMarkup(<BodyTodayCardView day={DAY} />);
    expect(markup).toContain('href="/body"');
    expect(markup).toContain("tap");
  });

  it("sits on the contracted glass: a shell wrapped around a surface", () => {
    const markup = renderToStaticMarkup(<BodyTodayCardView day={DAY} />);
    expect(markup).toContain("shell");
    expect(markup).toContain("surface");
  });

  it("draws each source as a neutral linear glyph, never one of the four gauge colours", () => {
    const markup = renderToStaticMarkup(<BodyTodayCardView day={DAY} />);
    expect(markup).toContain("<svg");
    // DESIGN.md reserves clay, river, moss and honey for the macro gauges.
    // Colours are tokens now (design Motion step 1), so check the gauge token names as well.
    for (const gauge of ["#c96f4a", "#8b7bb8", "#6f7f57", "#c9a24a", "--color-gauge-"]) {
      expect(markup).not.toContain(gauge);
    }
  });

  it("shows the real empty state when there is no day and no metric", () => {
    const markup = renderToStaticMarkup(<BodyTodayCardView day={null} />);
    expect(markup).toContain("No body data yet — connect a source in Settings.");
    expect(markup).not.toContain("as of ");
  });

  // The fetch has not settled yet: this must read as neutral loading, never the confident
  // "no source connected" claim, which would be a false negative for someone who has one.
  it("shows a neutral loading line, not the empty-state claim, while the fetch is in flight", () => {
    const markup = renderToStaticMarkup(<BodyTodayCardView day={null} loading />);
    expect(markup).not.toContain("No body data yet — connect a source in Settings.");
    expect(markup).toContain("Loading…");
  });

  // Finding 6: the fallback line must not read as "still learning" when the profile read itself
  // failed. No button here — the card is already a link to /body, where the retry lives.
  it("says the profile error — the profile could not be read — instead of 'still learning'", () => {
    const markup = renderToStaticMarkup(<BodyTodayCardView day={DAY} profileError />);
    expect(markup).toContain("Couldn&#x27;t read your profile — open Body");
    expect(markup).not.toContain("Still learning your burn");
  });

  // gap-body-dashboard-11: a stale cached row or estimate must not render as if it were current.
  it("shows an offline notice with the last-synced time when the row is a stale cached copy", () => {
    const markup = plain(renderToStaticMarkup(
      <BodyTodayCardView day={DAY} offline fetchedAt="2026-09-15T14:00:00Z" />,
    ));
    expect(markup).toContain("Offline");
    expect(markup).toContain("last synced");
  });

  it("shows the same notice when only the burn estimate is a stale cached copy", () => {
    const markup = plain(renderToStaticMarkup(<BodyTodayCardView day={DAY} stale />));
    expect(markup).toContain("Offline");
  });

  it("prints no offline notice at all for a live row and a fresh estimate", () => {
    const markup = renderToStaticMarkup(<BodyTodayCardView day={DAY} />);
    expect(markup).not.toContain("Offline");
  });

  /**
   * P1 (second audit): a response cached by the pre-T11 build has no `provenance`, and an
   * intermittent failure serves it back. Rendering it must not index into undefined.
   */
  it("renders a day cached before T11, with no provenance, instead of throwing", async () => {
    unbindAccount();
    const h = bindAccount("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    local.set(`smc:u:${h.userId}:health_daily`, JSON.stringify({ fetchedAt: "2026-09-15T14:00:00Z",
      response: { days: [{ local_date: "2026-09-15", steps: 1300, active_kcal: 96,
        sleep_minutes: 444, body_mass_kg: 57.6, sources: ["Oura"] }], sources: [] } }));
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));

    const out = await fetchDaily(h, "2026-09-15", "2026-09-15");
    const row = out.response!.days[0];

    let markup = "";
    expect(() => { markup = renderToStaticMarkup(<BodyTodayCardView day={row} />); }).not.toThrow();
    expect(row.provenance).toEqual({});
    expect(plain(markup)).toContain("1,300 steps");
    expect(plain(markup)).toContain("Other · as of —");
  });
});

describe("the body capability cache", () => {
  it("is unknown until a probe, enabled on an authoritative 200 and cached for the session", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    expect(readBodyCapability()).toBe("unknown");
    expect(await probeBodyCapability()).toBe("enabled");
    expect(session.get(BODY_CAPABILITY_KEY)).toBe("enabled");
    expect(readBodyCapability()).toBe("enabled");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("is disabled on a 503, and neither a 401 nor a network error decides anything", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    expect(await probeBodyCapability()).toBe("disabled");
    expect(readBodyCapability()).toBe("disabled");

    resetBodyCapabilityForTests();
    session.clear();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    expect(await probeBodyCapability()).toBe("unknown");
    expect(readBodyCapability()).toBe("unknown");

    resetBodyCapabilityForTests();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    expect(await probeBodyCapability()).toBe("unknown");
    expect(session.has(BODY_CAPABILITY_KEY)).toBe(false);
  });

  it("never probes on /sign-in (the tab bar renders outside AuthGate)", () => {
    expect(shouldProbeBody("/sign-in")).toBe(false);
    expect(shouldProbeBody("/")).toBe(true);
    expect(shouldProbeBody(null)).toBe(true);
  });

  it("retries after a 401 instead of freezing on unknown for the whole session", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await probeBodyCapability()).toBe("unknown");
    expect(await probeBodyCapability()).toBe("enabled");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries after a network error instead of freezing on unknown", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await probeBodyCapability()).toBe("unknown");
    expect(readBodyCapability()).toBe("unknown");
    expect(await probeBodyCapability()).toBe("enabled");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("TabBar", () => {
  // The dock is rendered as the server would: drop this file's partial window stub so motion
  // takes its server path instead of treating the fake as a browser.
  beforeEach(() => { vi.stubGlobal("window", undefined); });

  function tabBar(capability: "unknown" | "enabled" | "disabled") {
    return renderToStaticMarkup(<TabBar bodyCapability={capability} />);
  }

  function hrefs(markup: string): string[] {
    return [...markup.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  }

  it("keeps the same four capsule destinations while capability state resolves", async () => {
    const on = hrefs(tabBar("enabled"));
    expect(on).toEqual(["/", "/body", "/foods", "/settings"]);
    expect(hrefs(tabBar("disabled"))).toEqual(on);
    expect(hrefs(tabBar("unknown"))).toEqual(on);
  });

  it("expands only the selected label instead of changing the item count", () => {
    const off = tabBar("disabled");
    expect(off).toContain(">Today</span>");
    expect(off).not.toContain(">Body</span>");
    expect(hrefs(off)).toHaveLength(4);
  });

  it("drops to glyph-only below 360 px so every target stays 44 px at 320 px", () => {
    expect(tabBarLayout(320, 4).glyphOnly).toBe(true);
    expect(tabBarLayout(360, 4).glyphOnly).toBe(false);
    expect(tabBarLayout(320, 4).columns).toBe(4);
  });
});

describe("TodayCardRow (type guard)", () => {
  it("is shaped as label/value/source/asOf", async () => {
    const { todayCardRows } = await import("@/components/BodyTodayCard");
    const row: TodayCardRow = todayCardRows(DAY)[0];
    expect(Object.keys(row).sort()).toEqual(["asOf", "key", "label", "meta", "source", "value"]);
  });
});
