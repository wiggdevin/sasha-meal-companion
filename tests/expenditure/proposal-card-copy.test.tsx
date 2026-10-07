// @vitest-environment jsdom
/**
 * Design §8.1/§8.3 — `ProposalCard`'s copy and its four on-screen states.
 *
 * The `deltaSentence` cases came from `tests/expenditure/card-copy.test.ts`, which was deleted
 * with `EstimatorCard`; the card it belonged to is gone, the sentence is not, and the proposal is
 * still the one place a target change is offered. The states around it — offered, in flight,
 * stale and failed — are rendered rather than described, because each one decides whether the two
 * decision buttons can be tapped.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProposalSummary, ProposedTargets } from "@/lib/api-types";
import { COMMIT_FEEDBACK_MS } from "@/components/ui/ActionFeedback";

const decideProposalOnline = vi.fn();
vi.mock("@/lib/estimator-client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  decideProposalOnline: (...args: unknown[]) => decideProposalOnline(...args),
}));

const { default: ProposalCard, deltaSentence } = await import("@/components/ProposalCard");

const proposed = (over: Partial<ProposedTargets> = {}): ProposedTargets => ({
  kcalTrain: 2250, kcalRest: 1800, proteinG: 135, fatG: 85, carbG: 210,
  deltaKcalTrain: 50, deltaKcalRest: 50, raisedToFloor: false, ...over });

const PROPOSAL: ProposalSummary = {
  id: "p-1", weekStart: "2026-09-14", createdAt: "2026-09-14T06:00:00.000Z",
  status: "pending", basedOnEstimateId: "e-1", proposed: proposed(),
};

function card(props: { offline?: boolean; onDecided?: (decision: "approve" | "reject") => void } = {}) {
  return render(<ProposalCard proposal={PROPOSAL} offline={props.offline ?? false}
    onDecided={props.onDecided ?? (() => {})} />);
}

describe("deltaSentence — the delta sentence the card leads with", () => {
  it("states the training number and that protein does not move", () => {
    expect(deltaSentence(proposed()))
      .toBe("Your training days could go to 2,250 — protein unchanged.");
  });

  it("says down when the proposal lowers calories", () => {
    expect(deltaSentence(proposed({ kcalTrain: 2150, deltaKcalTrain: -50 })))
      .toBe("Your training days could come down to 2,150 — protein unchanged.");
  });

  it("says nothing moves when the delta is zero", () => {
    expect(deltaSentence(proposed({ deltaKcalTrain: 0, deltaKcalRest: 0 })))
      .toBe("Your training days stay at 2,250 — protein unchanged.");
  });
});

describe("ProposalCard's states", () => {
  afterEach(() => { cleanup(); decideProposalOnline.mockReset(); vi.useRealTimers(); });

  it("is pending: it offers both decisions, and says nothing changes until one is tapped", () => {
    const markup = renderToStaticMarkup(
      <ProposalCard proposal={PROPOSAL} offline={false} onDecided={() => {}} />);
    expect(markup).toContain("Your training days could go to 2,250 — protein unchanged.");
    expect(markup).toContain("Nothing changes until you tap.");
    expect(markup).toContain("var(--color-feedback-pending)");
    expect(markup).not.toMatch(/<button[^>]*\sdisabled(="")?[\s>]/);
  });

  it("is busy: both decisions are disabled while the first one is in flight", async () => {
    decideProposalOnline.mockReturnValue(new Promise(() => {}));
    card();
    fireEvent.click(screen.getByRole("button", { name: "Use these" }));
    await waitFor(() => expect(
      (screen.getByRole("button", { name: "Use these" }) as HTMLButtonElement).disabled).toBe(true));
    expect((screen.getByRole("button", { name: "Keep mine" }) as HTMLButtonElement).disabled)
      .toBe(true);
  });

  it("is stale: an offline card says it needs a connection and takes no decision", () => {
    const markup = renderToStaticMarkup(
      <ProposalCard proposal={PROPOSAL} offline onDecided={() => {}} />);
    expect(markup).toContain("Needs a connection");
    expect(markup).toMatch(/<button[^>]*\sdisabled(="")?[\s>]/);
  });

  it("shows the error copy when the decision does not save, and frees the buttons again",
    async () => {
      const vibrate = vi.fn(() => true);
      Object.defineProperty(window.navigator, "vibrate", { configurable: true, value: vibrate });
      decideProposalOnline.mockRejectedValue(new Error("decide failed: 409"));
      card();
      fireEvent.click(screen.getByRole("button", { name: "Use these" }));
      expect((await screen.findByRole("alert")).textContent)
        .toContain("This proposal changed — reload to see the latest.");
      expect((screen.getByRole("button", { name: "Use these" }) as HTMLButtonElement).disabled)
        .toBe(false);
      expect(vibrate).not.toHaveBeenCalled();
    });

  it("confirms an accepted proposal only after the decision reaches the server", async () => {
    vi.useFakeTimers();
    const vibrate = vi.fn(() => true);
    Object.defineProperty(window.navigator, "vibrate", { configurable: true, value: vibrate });
    let settle!: () => void;
    decideProposalOnline.mockReturnValue(new Promise<void>((resolve) => { settle = resolve; }));
    const onDecided = vi.fn();
    card({ onDecided });

    fireEvent.click(screen.getByRole("button", { name: "Use these" }));
    expect(screen.getByRole("button", { name: "Use these" })
      .getAttribute("data-feedback-state")).toBe("pending");
    expect(vibrate).not.toHaveBeenCalled();
    await act(async () => settle());

    expect(screen.getByRole("button", { name: "Use these" })
      .getAttribute("data-feedback-state")).toBe("success");
    expect(vibrate).toHaveBeenCalledTimes(1);
    expect(onDecided).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(COMMIT_FEEDBACK_MS - 1));
    expect(onDecided).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onDecided).toHaveBeenCalledWith("approve");
    });
});
