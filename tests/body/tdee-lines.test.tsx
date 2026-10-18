import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import TdeeLines, { firstTdeeLine, fluidCycleLine, tdeeLines } from "@/components/TdeeLines";
import type { ActivityContextV1 } from "@/lib/activity/summary";
import type { ExpenditureResponse } from "@/lib/api-types";
import { PROFILE_UNAVAILABLE } from "@/lib/tdee";

const activity = (over: Partial<ActivityContextV1> = {}): ActivityContextV1 => ({
  version: "activity-1.0.0", asOf: "2026-09-20", timeZone: "America/Denver",
  currentStepsAvg: 6_200, currentDays: 7, baselineStepsAvg: 8_000, baselineDays: 28,
  deviationPct: -0.225, band: "usual", activeKcal7dAvg: 410, activeKcalDays: 7,
  residualKcal: null, smoothing: "base", targetAdjustmentKcal: 0,
  ...over,
});

const estimate = (status: ExpenditureResponse["status"], over: Partial<ExpenditureResponse> = {}):
    ExpenditureResponse => ({
  status, localDate: "2026-09-20", tdeeKcal: status === "burn_in" ? null : 2_180,
  weightTrendKg: status === "burn_in" ? null : 57.4, confidence: 0.8,
  intakeCompleteness: 1, qualifiedDays: 18, weighInCount: 12,
  reason: null, engineVersion: "exp-2.0.0", profileTdeeKcal: 2_130,
  learningDaysRemaining: 3, activityContext: activity(), ...over,
});

describe("tdeeLines", () => {
  it("uses the profile estimate as the burn-in headline with the remaining-day copy", () => {
    const lines = tdeeLines({ estimate: estimate("burn_in"), profile: PROFILE_UNAVAILABLE, days: [] });
    expect(lines.map(({ label, value, detail }) => [label, value, detail])).toEqual([
      ["From your profile", "2,130 kcal",
        "Your logs and weight will refine this in about 3 days."],
      ["Device active energy", "410 kcal/day estimate",
        "7-day device average · not added to your food target."],
    ]);
    expect(firstTdeeLine(lines)?.label).toBe("From your profile");
  });

  it("keeps the profile burn-in headline when the remaining-day value is not migrated", () => {
    const lines = tdeeLines({ estimate: estimate("burn_in", { learningDaysRemaining: undefined }),
      profile: PROFILE_UNAVAILABLE, days: [] });
    expect(lines[0]).toMatchObject({ label: "From your profile",
      detail: "Your logs and weight will refine this in about 21 days." });
  });

  it("orders held copy before the profile and device rows", () => {
    const lines = tdeeLines({ estimate: estimate("held", {
      tdeeKcal: 2_120, reason: "not enough recent weigh-ins",
    }), profile: PROFILE_UNAVAILABLE, days: [] });
    expect(lines.map((line) => line.label)).toEqual([
      "Last learned", "Profile starting estimate", "Device active energy",
    ]);
    expect(lines[0]).toMatchObject({ value: "2,120 kcal",
      detail: "Holding steady — not enough recent weigh-ins." });
  });

  it("explains corroborated estimating without promoting device energy", () => {
    const lines = tdeeLines({ estimate: estimate("estimating", {
      activityContext: activity({ smoothing: "corroborated", band: "lower" }),
    }), profile: PROFILE_UNAVAILABLE, days: [] });
    expect(lines.map((line) => line.label)).toEqual([
      "From logs + weight", "Profile starting estimate", "Device active energy",
    ]);
    expect(lines[0].detail).toBe(
      "Updated today from your logged intake and weight trend. Your step trend agreed, so this update moved faster.",
    );
    expect(firstTdeeLine(lines)?.key).not.toBe("device");
  });

  it("explains blocked proposals while keeping the learned estimate first", () => {
    const lines = tdeeLines({ estimate: estimate("blocked", {
      reason: "the weekly change would exceed your limit",
    }), profile: PROFILE_UNAVAILABLE, days: [] });
    expect(lines[0]).toMatchObject({ label: "From logs + weight", value: "2,180 kcal",
      detail: "Estimate updated. No target proposal: the weekly change would exceed your limit." });
    expect(lines[1].label).toBe("Profile starting estimate");
  });

  it("omits missing device energy and keeps disclosure rows above the 44 px tap floor", () => {
    const input = { estimate: estimate("estimating", {
      activityContext: activity({ activeKcal7dAvg: null, activeKcalDays: 2 }),
    }), profile: PROFILE_UNAVAILABLE, days: [] };
    expect(tdeeLines(input).some((line) => line.key === "device")).toBe(false);
    const markup = renderToStaticMarkup(<TdeeLines {...input} />);
    expect(markup).not.toContain("Device active energy");
    // The design kit draws a disclosure row at min-h-12 (48 px) and a button at min-h-11 (44 px).
    // DESIGN.md's rule is the 44 px floor, not one class, so the guard reads the row's own number.
    for (const summary of markup.match(/<summary[^>]*>/g) ?? []) {
      const minHeight = summary.match(/min-h-(\d+)/);
      expect(minHeight?.[1], `a disclosure row needs a min height: ${summary}`).toBeTruthy();
      expect(Number(minHeight![1]), `${summary} is under the 44 px tap floor`).toBeGreaterThanOrEqual(11);
    }
  });
});

/** An exp-3 row (TDEE step E): `phase` decides, and a provisional `burn_in` carries a number. */
const phased = (over: Partial<ExpenditureResponse>): ExpenditureResponse => ({
  ...estimate("burn_in"), engineVersion: "exp-3.1.0", phase: "starting", tdeeKcal: null,
  weightTrendKg: null, profileTdeeKcal: 1_900, tdeeLowKcal: 1_620, tdeeHighKcal: 2_190,
  dataWeight: 0, seedSource: "revision", proposalEligible: false, reviewFlag: null,
  activityContext: activity({ activeKcal7dAvg: null }), ...over,
});
const lead = (input: ExpenditureResponse) =>
  tdeeLines({ estimate: input, profile: PROFILE_UNAVAILABLE, days: [] })[0];
const markup = (input: ExpenditureResponse) =>
  renderToStaticMarkup(<TdeeLines estimate={input} profile={PROFILE_UNAVAILABLE} days={[]} />);

describe("tdeeLines by phase (exp-3)", () => {
  it("starting: the profile number with its range and the server's starting reason", () => {
    const input = phased({ reason: "Starting estimate — learning from your days, 3 of 14 counted" });
    expect(lead(input)).toMatchObject({ key: "profile", label: "From your profile",
      value: "about 1,900 kcal", kcal: 1_900, range: "1,620–2,190",
      detail: "Starting estimate — learning from your days, 3 of 14 counted." });
    const html = markup(input);
    expect(html).toContain("About ");
    expect(html).toContain("range 1,620–2,190");
    expect(html).not.toContain('role="meter"');
    expect(html).toContain("Which days count");
  });

  it("provisional: a burn_in row with a number shows the learned number, range, reason and meter", () => {
    const input = phased({ phase: "provisional", tdeeKcal: 2_010, tdeeLowKcal: 1_840,
      tdeeHighKcal: 2_180, dataWeight: 0.25, reason: "Learning — 13 of 14 counted days in the last 28" });
    const lines = tdeeLines({ estimate: input, profile: PROFILE_UNAVAILABLE, days: [] });
    expect(lines.map((line) => [line.label, line.value])).toEqual([
      ["Your days and your profile", "about 2,010 kcal"], ["Starting estimate", "1,900 kcal"],
    ]);
    expect(lines[0]).toMatchObject({ range: "1,840–2,180", dataWeight: 0.25,
      detail: "Learning — 13 of 14 counted days in the last 28." });
    expect(firstTdeeLine(lines)?.kcal).toBe(2_010);
    const html = markup(input);
    expect(html).toContain('role="meter"');
    expect(html).toContain('aria-valuenow="25"');
    expect(html).toContain("Where this number comes from");
    expect(html).toContain("Your days");
    expect(html).toContain("Your profile");
  });

  it("adaptive: learned from your days, with no meter once the number is all the account's own", () => {
    const input = phased({ status: "estimating", phase: "adaptive", tdeeKcal: 2_080,
      tdeeLowKcal: 1_930, tdeeHighKcal: 2_230, dataWeight: 1, proposalEligible: true, reason: null });
    expect(lead(input)).toMatchObject({ label: "Learned from your days", value: "about 2,080 kcal",
      range: "1,930–2,230", detail: "Updated daily from your logged food and weigh-ins.", note: null });
    expect(markup(input)).not.toContain('role="meter"');
  });

  it("adaptive: a proposal-gate reason is a note about target suggestions, not about the number", () => {
    const input = phased({ status: "estimating", phase: "adaptive", tdeeKcal: 2_050,
      tdeeLowKcal: 1_900, tdeeHighKcal: 2_200, dataWeight: 0.8,
      reason: "Needs four weeks of history before suggesting a change" });
    expect(lead(input)).toMatchObject({ label: "Your days and your profile",
      detail: "Updated daily from your logged food and weigh-ins.",
      note: "No target suggestion yet: needs four weeks of history before suggesting a change." });
    expect(markup(input)).toContain('aria-valuenow="80"');
  });

  it("held reason: the last estimate stays in ink, with the server's reason as sent", () => {
    const input = phased({ status: "held", phase: "provisional", tdeeKcal: 2_020,
      tdeeLowKcal: 1_850, tdeeHighKcal: 2_190, dataWeight: 0.4,
      reason: "Holding the last estimate — no weigh-in in the last 2 days" });
    expect(lead(input)).toMatchObject({ label: "Last estimate", value: "about 2,020 kcal",
      range: "1,850–2,190", dataWeight: null, stale: true,
      detail: "Holding the last estimate — no weigh-in in the last 2 days." });
    const html = markup(input);
    expect(html).not.toContain('role="meter"');
    expect(html).not.toMatch(/class="kcal[^"]*">2,020</);
  });

  it("needs a check: a review flag is an attention notice, never presented as learned", () => {
    const input = phased({ status: "estimating", phase: "adaptive", tdeeKcal: 2_640,
      tdeeLowKcal: 2_420, tdeeHighKcal: 2_860, dataWeight: 0.9, reviewFlag: "far_from_seed",
      reason: "Your logged intake and weight don't fit together — check that every counted day is complete" });
    expect(lead(input)).toMatchObject({ label: "Needs a check", attention: true, dataWeight: null,
      range: null });
    const html = markup(input);
    expect(html).not.toContain("range ");
    expect(html).not.toMatch(/class="kcal[^"]*">2,640</); // ink, not the calorie colour
    expect(html).toContain('data-tone="attention"');
    expect(html).not.toContain("Learned from your days");
    expect(html).not.toContain('role="meter"');
  });

  it("blocked: an exp-3 number stays, and the proposal reason is named as such", () => {
    const input = phased({ status: "blocked", phase: "adaptive", tdeeKcal: 2_050,
      tdeeLowKcal: 1_900, tdeeHighKcal: 2_200, dataWeight: 1, reason: "Fat floor needs a larger step" });
    expect(lead(input)).toMatchObject({ label: "Learned from your days",
      detail: "Updated daily from your logged food and weigh-ins.",
      note: "No target suggestion: fat floor needs a larger step." });
  });

  it("no profile: no number at all, only the reason that says what is missing", () => {
    const input = phased({ status: "held", profileTdeeKcal: null, tdeeLowKcal: null,
      tdeeHighKcal: null, reason: "Finish your profile — the estimate starts from your own numbers" });
    const lines = tdeeLines({ estimate: input, profile: PROFILE_UNAVAILABLE, days: [] });
    expect(lines).toEqual([expect.objectContaining({ kcal: null, label: "No estimate yet",
      detail: "Finish your profile — the estimate starts from your own numbers.",
      action: { label: "Set up your profile", href: "/settings" } })]);
    expect(firstTdeeLine(lines)).toBeNull();
    const html = markup(input);
    expect(html).toContain('href="/settings"');
    expect(html).not.toContain("Which days count");
    expect(html).not.toMatch(/\d kcal/);
  });

  it("drops a range that does not hold its own number rather than print a contradiction", () => {
    const input = phased({ phase: "provisional", tdeeKcal: 2_400, tdeeLowKcal: 1_840, tdeeHighKcal: 2_180 });
    expect(lead(input).range).toBeNull();
    expect(lead(phased({ tdeeLowKcal: null })).range).toBeNull();
  });

  it("no phase: an exp-2 row, or a cached payload, keeps the status rules", () => {
    for (const phase of [null, undefined]) {
      const legacy = { ...estimate("burn_in"), phase };
      expect(lead(legacy)).toMatchObject({ label: "From your profile", value: "2,130 kcal" });
      expect(lead(legacy).range).toBeUndefined();
      expect(lead({ ...estimate("estimating"), phase })).toMatchObject({ label: "From logs + weight" });
      expect(markup(legacy)).not.toContain("Which days count");
    }
  });
});

describe("tdeeLines, exp-3.1.0 notes and the fluid cycle", () => {
  const adaptive = (over: Partial<ExpenditureResponse>) => phased({ status: "estimating",
    phase: "adaptive", tdeeKcal: 2_050, tdeeLowKcal: 1_900, tdeeHighKcal: 2_200, dataWeight: 0.9, ...over });

  it.each([
    ["Needs about six weeks of weigh-ins before suggesting a change",
      "No target suggestion yet: needs about six weeks of weigh-ins before suggesting a change."],
    ["Checking whether your weight follows a regular cycle",
      "No target suggestion yet: checking whether your weight follows a regular cycle."],
    ["Your weight jumped recently — waiting for the new trend",
      "No target suggestion yet: your weight jumped recently — waiting for the new trend."],
    ["Your last two weeks and last four weeks disagree",
      "No target suggestion yet: your last two weeks and last four weeks disagree."],
    ["Data was thin in the last week", "No target suggestion yet: data was thin in the last week."],
    ["The estimate is still moving", "No target suggestion yet: the estimate is still moving."],
    ["16 of 21 counted days in the last 28", "No target suggestion yet: 16 of 21 counted days in the last 28."],
  ])("adaptive gate reason %s reads as one note sentence", (reason, note) => {
    const line = lead(adaptive({ reason }));
    expect(line.note).toBe(note);
    expect(line.detail).toBe("Updated daily from your logged food and weigh-ins.");
    expect(markup(adaptive({ reason }))).toContain(note.replace("'", "&#x27;"));
  });

  it("fluid cycle set: one quiet line with the engine's own period and no cause", () => {
    const input = adaptive({ fluidCycleDays: 27.6, reason: null });
    const text = "Your weight follows a ~28-day cycle; the estimate allows for it.";
    expect(fluidCycleLine(input)).toBe(text);
    expect(lead(input).cycle).toBe(text);
    const html = markup(input);
    expect(html).toContain(text);
    expect(html).not.toMatch(/menstru|period|hormon/i);
    expect(lead(adaptive({ fluidCycleDays: 31 })).cycle).toContain("~31-day cycle");
  });

  it("fluid cycle null or absent: no cycle line", () => {
    for (const input of [adaptive({ fluidCycleDays: null }), adaptive({}), adaptive({ fluidCycleDays: 0 })]) {
      expect(fluidCycleLine(input)).toBeNull();
      expect(markup(input)).not.toContain("cycle; the estimate allows for it");
    }
    expect(fluidCycleLine({ ...estimate("estimating"), fluidCycleDays: undefined })).toBeNull();
  });
});
