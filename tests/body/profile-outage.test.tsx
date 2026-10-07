/**
 * T11b (eighth-round finding 5): a profile READ FAILURE is not an empty profile.
 *
 * `/body` used to hand `null` to `TdeeLines` when the shared IndexedDB read failed, and the lines
 * then said "Add height, birth year and sex in Settings" — a claim about the user's data made out
 * of our own read error. The read now reports a `ProfileState`: `unavailable` withholds the two
 * lines that stand on the profile and leaves the retry alert in their place, while an
 * empty-but-read row keeps the sentence, because there it is true.
 *
 * Rendered statically from the pure view the page wires up. The second surface this used to cover,
 * Settings' estimator card, was an orphan and is deleted (design §8.1).
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import BodyDashboard, { type ProfileFailureProps } from "@/components/BodyDashboard";
import { PROFILE_READ_ERROR } from "@/lib/body-profile-client";
import { EMPTY_BODY_PROFILE, PROFILE_UNAVAILABLE, profileState,
  type ProfileState } from "@/lib/tdee";
import type { ExpenditureResponse } from "@/lib/api-types";
import type { DailyHealthResponse, DailyHealthRow } from "@/lib/health/contract";

const RETRY = "Try again";

const BURN_IN: ExpenditureResponse = {
  status: "burn_in", localDate: "2026-09-12", tdeeKcal: null, weightTrendKg: null, confidence: 0,
  intakeCompleteness: 0.4, qualifiedDays: 8, weighInCount: 5, reason: null, engineVersion: "v1",
  profileTdeeKcal: 2_130, learningDaysRemaining: 13,
};

const DAY: DailyHealthRow = { local_date: "2026-09-12", steps: 1300, active_kcal: 360,
  sleep_minutes: 444, body_mass_kg: 57.6, resting_heart_rate: 47, hrv_sdnn: 45,
  readiness_score: 78, sources: ["Oura"], provenance: {} };
const DAILY: DailyHealthResponse = { days: [DAY], sources: [] };

describe("/body's dashboard", () => {
  // The failure half is a discriminated union (split audit, finding 2), so the helper takes it
  // whole: a retry cannot be passed without the flag, and the flag cannot be passed without one.
  const dashboard = (props: { profile?: ProfileState } & ProfileFailureProps) =>
    renderToStaticMarkup(<BodyDashboard response={DAILY} chart={[DAY]} fetchedAt={null}
      offline={false} estimate={BURN_IN} onOpenSources={() => {}} {...props} />);

  it("withholds the profile-dependent lines and offers the retry when the read failed", () => {
    const markup = dashboard({ profile: PROFILE_UNAVAILABLE, profileFailed: true,
      onRetryProfile: () => {} });
    expect(markup).toContain(PROFILE_READ_ERROR.replace("'", "&#x27;"));
    expect(markup).toContain(RETRY);
    expect(markup).not.toContain("No weigh-in in the last 14 days");
    // The rest of the screen is untouched: the metric cards and the sources panel still render.
    expect(markup).toContain("Resting heart rate");
    expect(markup).toContain("Manage sources");
  });

  it("uses the API profile estimate when the local profile row is empty", () => {
    const markup = dashboard({ profile: profileState(EMPTY_BODY_PROFILE), profileFailed: false });
    expect(markup).toContain("From your profile");
    expect(markup).not.toContain(PROFILE_READ_ERROR);
  });

  // The dead "Try again" is impossible by type, not by discipline. Both of these are `tsc --noEmit`
  // errors, and the directives below fail the build themselves if the union is ever widened back
  // (TS2578, unused directive). Nothing here is rendered.
  it("cannot be given the flag without a retry, or a retry without the flag", () => {
    const noRetry = () => renderToStaticMarkup(
      // @ts-expect-error profileFailed demands onRetryProfile (split audit, finding 2)
      <BodyDashboard response={DAILY} chart={[DAY]} fetchedAt={null} offline={false}
        onOpenSources={() => {}} profileFailed />);
    const noFlag = () => renderToStaticMarkup(
      // @ts-expect-error a retry without the failure flag is the same dead button
      <BodyDashboard response={DAILY} chart={[DAY]} fetchedAt={null} offline={false}
        onOpenSources={() => {}} onRetryProfile={() => {}} />);
    expect([noRetry, noFlag]).toHaveLength(2);
  });
});
