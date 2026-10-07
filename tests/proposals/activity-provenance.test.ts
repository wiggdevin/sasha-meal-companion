import { describe, expect, it } from "vitest";
import type { ActivityContextV1 } from "@/lib/activity/summary";
import { proposalActivitySentence } from "@/lib/proposal";
import { toSummary } from "@/lib/server/proposals";
import ProposalCard from "@/components/ProposalCard";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

const context = (over: Partial<ActivityContextV1> = {}): ActivityContextV1 => ({
  version: "activity-1.0.0", asOf: "2026-09-20", timeZone: "America/Denver",
  currentStepsAvg: 4_800, currentDays: 7, baselineStepsAvg: 8_000, baselineDays: 28,
  deviationPct: -0.4, band: "lower", activeKcal7dAvg: 300, activeKcalDays: 7,
  residualKcal: -122, smoothing: "corroborated", targetAdjustmentKcal: 0,
  ...over,
});

describe("proposal activity provenance", () => {
  it("carries stored activity context into the card and renders only corroborated provenance", () => {
    const row = { id: "p1", week_start: "2026-09-14", created_at: "2026-09-20T12:00:00Z",
      status: "pending", based_on_estimate_id: "e1", proposed: {
        kcalTrain: 2_200, kcalRest: 2_000, proteinG: 130, fatG: 70, carbG: 250,
        deltaKcalTrain: 50, deltaKcalRest: 50, raisedToFloor: false,
      }, activity_context: context() };
    const summary = toSummary(row);
    expect(summary.activityContext).toEqual(context());
    const corroborated = renderToStaticMarkup(createElement(ProposalCard,
      { proposal: summary, offline: false, onDecided: () => {} }));
    expect(corroborated).toContain("burn estimate moved down faster");
    const base = renderToStaticMarkup(createElement(ProposalCard, { proposal: { ...summary,
      activityContext: context({ smoothing: "base" }) }, offline: false, onDecided: () => {} }));
    expect(base).not.toContain("burn estimate moved down faster");
  });

  it("explains corroborated lower activity without adding device calories", () => {
    expect(proposalActivitySentence(context())).toBe(
      "Your steps were lower than usual and agreed with your logs and weight, so the burn estimate moved down faster. Device calories were not added.",
    );
  });

  it("explains corroborated higher activity without adding device calories", () => {
    expect(proposalActivitySentence(context({
      band: "higher", currentStepsAvg: 11_200, deviationPct: 0.4, residualKcal: 122,
    }))).toBe(
      "Your steps were higher than usual and agreed with your logs and weight, so the burn estimate moved up faster. Device calories were not added.",
    );
  });

  it.each([
    context({ smoothing: "base" }),
    context({ band: "usual" }),
    context({ band: "insufficient" }),
    undefined,
  ])("is absent without corroborated directional smoothing", (value) => {
    expect(proposalActivitySentence(value)).toBeNull();
  });
});
