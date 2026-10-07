import { afterEach, describe, expect, it } from "vitest";
import { visibleProposal } from "@/lib/estimator-client";
import type { ProposalSummary } from "@/lib/api-types";

const PROPOSAL: ProposalSummary = {
  id: "p1", weekStart: "2026-09-14", createdAt: "2026-09-13T21:00:00Z", status: "pending",
  basedOnEstimateId: "e1",
  proposed: {
    kcalTrain: 2400, kcalRest: 2100, proteinG: 135, fatG: 70, carbG: 250,
    deltaKcalTrain: 50, deltaKcalRest: 0, raisedToFloor: false,
  },
};
const DECIDED: ProposalSummary = { ...PROPOSAL, id: "p0", status: "approved" };
const CACHED = { asOf: "2026-09-13", value: [PROPOSAL], stale: false };
const EMPTY = { asOf: "2026-09-13", value: [], stale: false };
const ALREADY_DECIDED = { asOf: "2026-09-13", value: [DECIDED], stale: false };

afterEach(() => {
  delete process.env.NEXT_PUBLIC_ESTIMATOR_UI;
});

describe("the Today proposal card (contracts §6)", () => {
  it("is hidden when NEXT_PUBLIC_ESTIMATOR_UI is unset, even with a pending proposal", () => {
    delete process.env.NEXT_PUBLIC_ESTIMATOR_UI;
    expect(visibleProposal(CACHED)).toBeNull();
  });

  it("is hidden when there is no pending proposal, even with the flag set", () => {
    process.env.NEXT_PUBLIC_ESTIMATOR_UI = "1";
    expect(visibleProposal(null)).toBeNull();
    expect(visibleProposal(EMPTY)).toBeNull();
  });

  it("is hidden when the row at [0] has already been decided, even with the flag set", () => {
    process.env.NEXT_PUBLIC_ESTIMATOR_UI = "1";
    expect(visibleProposal(ALREADY_DECIDED)).toBeNull();
  });

  it("shows the pending proposal once the flag is set", () => {
    process.env.NEXT_PUBLIC_ESTIMATOR_UI = "1";
    expect(visibleProposal(CACHED)).toEqual(PROPOSAL);
  });
});
