/**
 * Design §8.3 — the render spec for every state `/body` supports: the page's skeleton, empty,
 * loaded, offline and profile-error shells, the Movement panel's insufficient and populated
 * readings, the Sources panel's empty, active and revoked rows, and the weight-trend line's
 * gate at 20 weigh-ins (§8.2).
 *
 * Rendered statically. Every state here is a function of props, so a static render is the whole
 * card — and it keeps this file in the default node environment, which is what lets the inventory
 * gate in `tests/cards/inventory.test.ts` stay under its five-second budget alongside it.
 *
 * `/body`'s own three branches are a function of one hook's answer (`useBodyDashboard`), so the
 * page is rendered here too, with that answer pinned. The page is asserted through its DOM, never
 * by reading its source.
 */
import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import BodyDashboard, { type BodyDashboardProps, type ProfileFailureProps }
  from "@/components/BodyDashboard";
import BodyPage from "@/app/body/page";
import type { BodyDashboardData } from "@/lib/health/body-page";
import { PROFILE_READ_ERROR } from "@/lib/body-profile-client";
import { EMPTY_BODY_PROFILE, PROFILE_UNAVAILABLE, profileState } from "@/lib/tdee";
import { MIN_WEIGH_INS_FOR_TREND } from "@/lib/estimator-client";
import type { ExpenditureResponse } from "@/lib/api-types";
import type { DailyHealthResponse, DailyHealthRow } from "@/lib/health/contract";
import { ACTIVITY_CONTEXT_VERSION, type ActivityContextV1 } from "@/lib/activity/summary";

const DAY: DailyHealthRow = { local_date: "2026-09-12", steps: 8_200, active_kcal: 360,
  sleep_minutes: 444, body_mass_kg: 57.6, resting_heart_rate: 47, hrv_sdnn: 45,
  readiness_score: 78, sources: ["Oura"], provenance: {} };

const SOURCE = { id: "s1", kind: "oura", device_label: "Oura Ring",
  last_received_at: "2026-09-12T06:00:00.000Z", revoked: false };

const RESPONSE: DailyHealthResponse = { days: [DAY], sources: [] };

const ESTIMATE: ExpenditureResponse = {
  status: "estimating", localDate: "2026-09-12", tdeeKcal: 2_250, weightTrendKg: 57.6,
  confidence: 0.8, intakeCompleteness: 0.9, qualifiedDays: 18,
  weighInCount: MIN_WEIGH_INS_FOR_TREND, reason: null, engineVersion: "v1",
  profileTdeeKcal: 2_130,
};

const TREND_SERIES = [57.9, null, 57.8, 57.7, 57.6];

/**
 * The failure half of `/body`'s props is a discriminated union, so it travels whole: a retry
 * cannot be passed without the flag, and the flag cannot be passed without a retry.
 */
type DashboardProps = Omit<Partial<BodyDashboardProps>, "profileFailed" | "onRetryProfile">
  & Partial<ProfileFailureProps>;

function dashboard(props: DashboardProps = {}): string {
  const all = {
    response: RESPONSE, chart: [DAY], fetchedAt: null, offline: false,
    onOpenSources: () => {}, ...props,
  } as BodyDashboardProps;
  return renderToStaticMarkup(<BodyDashboard {...all} />);
}

/** `fetchDaily`'s settled answer, which is the only thing `/body` branches on. */
type DailyState = BodyDashboardData["daily"];

const hook = vi.hoisted(() => ({ daily: null as unknown }));

vi.mock("@/lib/health/body-page", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/health/body-page")>();
  return {
    ...actual,
    useBodyDashboard: (): BodyDashboardData => ({
      daily: hook.daily as DailyState, chart: [DAY], estimate: null, estimateStatus: "loading",
      retryEstimate: () => {}, pendingProposal: null,
      profile: { profile: null, state: PROFILE_UNAVAILABLE, status: "ready", error: null,
        retry: () => {} },
      reload: () => {}, onProposalDecided: () => {},
    }),
  };
});

/** `/body` itself, rendered on one pinned read. Its three branches are a function of that read. */
function page(daily: DailyState): string {
  hook.daily = daily;
  return renderToStaticMarkup(<BodyPage />);
}

describe("/body's shell states — skeleton, empty, loaded, offline and profile error", () => {
  it("draws the loaded dashboard: metric cards, movement, what you burn and sources", () => {
    const markup = dashboard({ estimate: ESTIMATE });
    expect(markup).toContain("Resting heart rate");
    expect(markup).toContain("Movement pattern");
    expect(markup).toContain("What you burn");
    expect(markup).toContain("Sources");
  });

  it("says how old the copy is when the screen is offline, and not before", () => {
    expect(dashboard({ offline: true, fetchedAt: "2026-09-12T06:00:00.000Z" }))
      .toContain("Offline — last synced");
    expect(dashboard({ offline: false, fetchedAt: "2026-09-12T06:00:00.000Z" }))
      .not.toContain("Offline — last synced");
  });

  it("offers a retry on a profile error, and withholds the profile-backed lines", () => {
    const markup = dashboard({ profile: PROFILE_UNAVAILABLE, profileFailed: true,
      onRetryProfile: () => {}, estimate: ESTIMATE });
    expect(markup).toContain(PROFILE_READ_ERROR.replace("'", "&#x27;"));
    expect(markup).toContain("Try again");
    // The rest of the screen is untouched by one failed read.
    expect(markup).toContain("Sources");
  });

  it("keeps the empty-but-read profile apart from the failed read", () => {
    const markup = dashboard({ profile: profileState(EMPTY_BODY_PROFILE), estimate: ESTIMATE });
    expect(markup).not.toContain(PROFILE_READ_ERROR);
    expect(markup).toContain("Profile starting estimate");
  });

  it("says it cannot reach the server, with a retry, when offline with nothing cached", () => {
    const markup = page({ disabled: false, response: null, fetchedAt: null, offline: true });
    expect(markup).toContain("Couldn&#x27;t reach the server");
    expect(markup).toContain("Nothing has changed with your connected sources.");
    expect(markup).toContain("Try again");
    expect(markup).not.toContain("Nothing here yet");
  });

  it("says the estimate is loading, and draws no movement panel, before it lands", () => {
    const markup = dashboard({ estimate: null, estimateStatus: "loading" });
    expect(markup).toContain("Loading your burn estimate");
    expect(markup).not.toContain("Movement pattern");
    expect(markup).not.toContain("Keep syncing");
  });

  it("says the estimate failed, with a retry, when its read failed", () => {
    const markup = dashboard({ estimate: null, estimateStatus: "error", onRetryEstimate: () => {} });
    expect(markup).toContain("Couldn&#x27;t load your burn estimate");
    expect(markup).toContain("Try again");
    expect(markup).not.toContain("Movement pattern");
  });

  it("draws no TDEE line at all before the first estimate lands", () => {
    const markup = dashboard({ estimate: null });
    expect(markup).toContain("What you burn");
    expect(markup).not.toContain("From logs + weight");
    expect(markup).not.toContain("Profile starting estimate");
  });

  /* The skeleton and the "nothing here yet" card are the page's own two pre-dashboard states
     (app/body/page.tsx:56-58). They are the states a brand-new account sees first, so each is
     rendered here rather than left to the walkthrough. */
  it("draws only the skeleton while the first read is still in flight", () => {
    const markup = page(null);
    // The card it becomes, at E1 on the ground (DESIGN.md §Elevation): a shell, not a beige block.
    expect(markup).toContain('<div class="shell" aria-hidden="true"><div class="surface h-80"></div></div>');
    expect(markup).not.toContain("Nothing here yet");
    expect(markup).not.toContain("Sources");
  });

  it.each([
    ["ingest is off", { disabled: true, response: RESPONSE, fetchedAt: null, offline: false }],
    ["the read came back empty", { disabled: false, response: null, fetchedAt: null, offline: false }],
  ])("draws BodyEmptyState, and no dashboard, when %s", (_case, daily) => {
    const markup = page(daily as DailyState);
    expect(markup).toContain("Nothing here yet");
    expect(markup).toContain("Body data turns on once you connect a source in Settings.");
    expect(markup).not.toContain("Movement pattern");
    expect(markup).not.toContain('class="h-80 rounded-[32px] bg-fog"');
  });

  it("draws the dashboard, and neither shell, once a response has landed", () => {
    const markup = page({ disabled: false, response: RESPONSE, fetchedAt: null, offline: false });
    expect(markup).toContain("What you burn");
    expect(markup).not.toContain("Nothing here yet");
    expect(markup).not.toContain('class="h-80 rounded-[32px] bg-fog"');
  });
});

describe("the Movement panel — movement insufficient, then movement populated", () => {
  const populated: ActivityContextV1 = { version: ACTIVITY_CONTEXT_VERSION,
    asOf: "2026-09-12", timeZone: "UTC",
    currentStepsAvg: 9_400, currentDays: 7, baselineStepsAvg: 7_100, baselineDays: 26,
    deviationPct: 32, band: "higher", activeKcal7dAvg: 380, activeKcalDays: 7,
    residualKcal: null, smoothing: "base", targetAdjustmentKcal: 0 };

  it("keeps saying 'Keep syncing' while there is not enough movement history", () => {
    const markup = dashboard({ estimate: { ...ESTIMATE, activityContext: undefined } });
    expect(markup).toContain("Keep syncing");
    expect(markup).toContain("0 of 7 recent days");
    expect(markup).toContain("0 of 28 usual-range days");
  });

  it("names the band and both coverages once the history is there", () => {
    const markup = dashboard({ estimate: { ...ESTIMATE, activityContext: populated } });
    expect(markup).toContain("Higher than usual");
    expect(markup).toContain("7 of 7 recent days");
    expect(markup).toContain("26 of 28 usual-range days");
    expect(markup).not.toContain("Keep syncing");
  });
});

describe("the Sources panel — sources empty, sources active and sources revoked", () => {
  it("asks for a source instead of drawing an empty list", () => {
    const markup = dashboard({ response: { ...RESPONSE, sources: [] } });
    expect(markup).toContain("No source yet. Connect your phone in Settings.");
    expect(markup).toContain("Manage sources");
  });

  it("names an active source and when it was last heard from", () => {
    const markup = dashboard({ response: { ...RESPONSE, sources: [SOURCE] } });
    expect(markup).toContain("Oura Ring");
    expect(markup).toContain("last received");
    expect(markup).not.toContain("No source yet");
  });

  it("says a revoked source is revoked rather than silently stale", () => {
    const markup = dashboard({
      response: { ...RESPONSE, sources: [{ ...SOURCE, revoked: true }] },
    });
    expect(markup).toContain("revoked");
    expect(markup).not.toContain("last received");
  });
});

describe("WeightTrend, the weight-trend line on /body (design §8.2)", () => {
  it("stays hidden under 20 weigh-ins, even with a series to draw", () => {
    const markup = dashboard({ estimate: { ...ESTIMATE,
      weighInCount: MIN_WEIGH_INS_FOR_TREND - 1, weightTrendSeriesKg: TREND_SERIES } });
    expect(markup).not.toContain("Weight trend");
  });

  it("stays hidden in burn-in, however many weigh-ins there are", () => {
    const markup = dashboard({ estimate: { ...ESTIMATE, status: "burn_in",
      weighInCount: MIN_WEIGH_INS_FOR_TREND + 5, weightTrendSeriesKg: TREND_SERIES } });
    expect(markup).not.toContain("Weight trend");
  });

  it("is mounted at 20 weigh-ins and draws the stored series, not an empty line", () => {
    const markup = dashboard({ estimate: { ...ESTIMATE, weightTrendSeriesKg: TREND_SERIES } });
    expect(markup).toContain("Weight trend");
    expect(markup).toContain("A 20-day average");
    // The series reaches the sparkline: five points, one of them a gap.
    expect(markup).toMatch(/aria-label="Weight trend in (pounds|kilograms)"/);
    expect(markup).not.toContain("NaN");
  });

  it("is mounted with no series rather than throwing when the field is absent", () => {
    const markup = dashboard({ estimate: { ...ESTIMATE, weightTrendSeriesKg: undefined } });
    expect(markup).toContain("Weight trend");
    expect(markup).not.toContain("NaN");
  });

  it("is not mounted at all when there is no estimate to gate on", () => {
    expect(dashboard({ estimate: null })).not.toContain("Weight trend");
  });

  it("is mounted in the provisional phase under 20 weigh-ins (exp-3 gates on phase)", () => {
    const markup = dashboard({ estimate: { ...ESTIMATE, status: "burn_in", phase: "provisional",
      weighInCount: 8, weightTrendSeriesKg: TREND_SERIES } });
    expect(markup).toContain("Weight trend");
    expect(markup).toContain("The line through your weigh-ins");
    expect(markup).not.toContain("A 20-day average");
  });

  it("stays hidden in the starting phase, and with a phased series of under two points", () => {
    expect(dashboard({ estimate: { ...ESTIMATE, phase: "starting",
      weightTrendSeriesKg: TREND_SERIES } })).not.toContain("Weight trend");
    expect(dashboard({ estimate: { ...ESTIMATE, phase: "adaptive",
      weightTrendSeriesKg: [null, null, 70.1] } })).not.toContain("Weight trend");
  });
});

describe("the metric cards", () => {
  it("draws a populated HealthMetricCard a series, with its own footnote", () => {
    const markup = dashboard({ estimate: ESTIMATE });
    for (const eyebrow of ["Weight", "Sleep", "Steps", "Device active energy estimate",
      "Resting heart rate", "HRV", "Readiness"]) {
      expect(markup).toContain(eyebrow);
    }
    expect(markup).toContain("1 of 1 days with data");
  });

  it("prints a dash, not a zero, for a day with no data", () => {
    const blank = { ...DAY, steps: null, hrv_sdnn: null };
    const markup = dashboard({ chart: [blank], estimate: ESTIMATE });
    expect(markup).toContain("—");
    expect(markup).toContain("0 of 1 days with data");
  });
});

describe("the two orphaned body cards (design §8.1)", () => {
  it.each(["components/EstimatorCard.tsx", "components/BodyDataCard.tsx"])(
    "%s is gone from the tree, not merely unmounted", (path) => {
      expect(existsSync(new URL(`../../${path}`, import.meta.url))).toBe(false);
    });
});
