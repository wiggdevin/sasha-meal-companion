import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import BodyDashboard from "@/components/BodyDashboard";
import type { ActivityContextV1 } from "@/lib/activity/summary";
import type { ProposalSummary } from "@/lib/api-types";
import type { Fresh } from "@/lib/estimator-client";

const PROVENANCE_SENTENCE = "Your steps were lower than usual and agreed with your logs and weight, "
  + "so the burn estimate moved down faster. Device calories were not added.";

const activityContext = (smoothing: ActivityContextV1["smoothing"]): ActivityContextV1 => ({
  version: "activity-1.0.0",
  asOf: "2026-09-20",
  timeZone: "America/Denver",
  currentStepsAvg: 4_800,
  currentDays: 7,
  baselineStepsAvg: 8_000,
  baselineDays: 28,
  deviationPct: -0.4,
  band: "lower",
  activeKcal7dAvg: 300,
  activeKcalDays: 7,
  residualKcal: -122,
  smoothing,
  targetAdjustmentKcal: 0,
});

const proposal = (smoothing: ActivityContextV1["smoothing"]): ProposalSummary => ({
  id: "proposal-1",
  weekStart: "2026-09-14",
  createdAt: "2026-09-20T12:00:00Z",
  status: "pending",
  basedOnEstimateId: "estimate-1",
  proposed: {
    kcalTrain: 2_200,
    kcalRest: 2_000,
    proteinG: 130,
    fatG: 70,
    carbG: 250,
    deltaKcalTrain: 50,
    deltaKcalRest: 50,
    raisedToFloor: false,
  },
  activityContext: activityContext(smoothing),
});

const pending = (smoothing: ActivityContextV1["smoothing"]): Fresh<ProposalSummary[]> => ({
  asOf: "2026-09-20",
  stale: false,
  value: [proposal(smoothing)],
});

function renderBody(pendingProposal: Fresh<ProposalSummary[]> | null): string {
  return renderToStaticMarkup(
    <BodyDashboard
      response={{ days: [], sources: [] }}
      chart={[]}
      fetchedAt={null}
      offline={false}
      pendingProposal={pendingProposal}
      onProposalDecided={() => {}}
      onOpenSources={() => {}}
    />,
  );
}

describe("the pending proposal on /body", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_ESTIMATOR_UI = "1";
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_ESTIMATOR_UI;
  });

  it("renders the provenance sentence for a corroborated proposal", () => {
    expect(renderBody(pending("corroborated"))).toContain(PROVENANCE_SENTENCE);
  });

  it("renders a base-smoothed proposal card without the provenance sentence", () => {
    const markup = renderBody(pending("base"));
    expect(markup).toContain("Your training days could go to");
    expect(markup).not.toContain(PROVENANCE_SENTENCE);
  });

  it("renders no proposal card when there is no pending proposal", () => {
    expect(renderBody(null)).not.toContain("Your training days could go to");
  });
});
