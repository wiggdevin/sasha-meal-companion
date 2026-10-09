// @vitest-environment jsdom
/**
 * Today's overview host: it opens by itself once per account after onboarding, never before it,
 * and again whenever the companion in the well is tapped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MotionConfig } from "motion/react";
import TodayTour, { AUTO_OPEN_DELAY_MS } from "./TodayTour";
import { TOUR_SEEN_NAME, hasSeenTour, readTourSeen } from "./tour-seen";
import SproutStage from "@/components/today/island/Sprout";
import { OFFER_MS } from "./TourOffer";

type Handle = { userId: string; epoch: number };
const account = vi.hoisted(() => ({ current: { userId: "a", epoch: 1 } as Handle | null }));
vi.mock("@/lib/device/account", async (original) => ({
  ...(await original<typeof import("@/lib/device/account")>()),
  currentAccountOrNull: () => account.current,
  assertCurrent: () => {},
}));

beforeEach(() => {
  localStorage.clear();
  account.current = { userId: "a", epoch: 1 };
  vi.useFakeTimers();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

const ONBOARDED = "2026-10-08T12:00:00Z";
const wait = () => act(() => { vi.advanceTimersByTime(AUTO_OPEN_DELAY_MS + 50); });
const tour = () => screen.queryByRole("dialog", { name: "Meet Sasha" });

function mount(onboardedAt: string | null) {
  return render(<MotionConfig reducedMotion="always"><TodayTour onboardedAt={onboardedAt} /></MotionConfig>);
}

describe("TodayTour", () => {
  it("opens once after onboarding, and never again for that account", () => {
    const first = mount(ONBOARDED);
    expect(tour()).toBeNull();
    wait();
    expect(tour()).toBeTruthy();
    expect(localStorage.getItem(`smc:u:a:${TOUR_SEEN_NAME}`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    first.unmount();

    mount(ONBOARDED);
    wait();
    expect(tour()).toBeNull();
  });

  it("opens again for a different account on the same phone", () => {
    localStorage.setItem(`smc:u:a:${TOUR_SEEN_NAME}`, ONBOARDED);
    account.current = { userId: "b", epoch: 2 };
    mount(ONBOARDED);
    wait();
    expect(tour()).toBeTruthy();
    expect(hasSeenTour({ userId: "b", epoch: 2 })).toBe(true);
  });

  it("waits until onboarding is complete", () => {
    const view = mount(null);
    wait();
    expect(tour()).toBeNull();
    view.rerender(<MotionConfig reducedMotion="always"><TodayTour onboardedAt={ONBOARDED} /></MotionConfig>);
    wait();
    expect(tour()).toBeTruthy();
  });

  it("re-opens when the companion in the well is tapped", () => {
    localStorage.setItem(`smc:u:a:${TOUR_SEEN_NAME}`, ONBOARDED);
    render(<MotionConfig reducedMotion="always">
      <TodayTour onboardedAt={ONBOARDED} />
      <SproutStage state={{ mood: "content", vitality: 0.7, line: "Sprout is doing fine." }} glance={null} bounce={0} />
    </MotionConfig>);
    wait();
    expect(tour()).toBeNull();
    const sprout = screen.getByRole("button", { name: "Sprout. Say hello" });
    act(() => { sprout.focus(); fireEvent.click(sprout); });
    // The tap keeps its hello and offers the overview beside the pet; the offer opens it.
    expect(tour()).toBeNull();
    expect(screen.getByText("Sprout says hello back.")).toBeTruthy();
    const offer = screen.getByRole("button", { name: "How Sasha works?" });
    act(() => { offer.focus(); fireEvent.click(offer); });
    expect(tour()).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    act(() => { vi.runOnlyPendingTimers(); });
  });

  it("a manual open cancels the pending auto-open, so Skip is final", () => {
    render(<MotionConfig reducedMotion="always">
      <TodayTour onboardedAt={ONBOARDED} />
      <SproutStage state={{ mood: "content", vitality: 0.7, line: "Sprout is doing fine." }} glance={null} bounce={0} />
    </MotionConfig>);
    // Before the auto-open fires: open from the companion, then Skip.
    act(() => { vi.advanceTimersByTime(AUTO_OPEN_DELAY_MS / 2); });
    fireEvent.click(screen.getByRole("button", { name: "Sprout. Say hello" }));
    fireEvent.click(screen.getByRole("button", { name: "How Sasha works?" }));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    const shown = screen.queryAllByRole("dialog").length;
    act(() => { vi.advanceTimersByTime(AUTO_OPEN_DELAY_MS * 2); });
    // Nothing new opens: no second dialog, and no fresh first step.
    expect(screen.queryAllByRole("dialog").length).toBeLessThanOrEqual(shown);
    expect(screen.queryAllByRole("dialog").length).toBeLessThanOrEqual(1);
  });

  it("re-checks the mark when the auto-open fires", () => {
    mount(ONBOARDED);
    // Another tab or opener writes the mark while the timer waits.
    localStorage.setItem(`smc:u:a:${TOUR_SEEN_NAME}`, ONBOARDED);
    wait();
    expect(tour()).toBeNull();
  });

  it("lets the offer go after a few seconds", () => {
    localStorage.setItem(`smc:u:a:${TOUR_SEEN_NAME}`, ONBOARDED);
    render(<MotionConfig reducedMotion="always">
      <SproutStage state={{ mood: "content", vitality: 0.7, line: "Sprout is doing fine." }} glance={null} bounce={0} />
    </MotionConfig>);
    fireEvent.click(screen.getByRole("button", { name: "Sprout. Say hello" }));
    expect(screen.getByRole("button", { name: "How Sasha works?" })).toBeTruthy();
    act(() => { vi.advanceTimersByTime(OFFER_MS + 100); });
    act(() => { vi.runOnlyPendingTimers(); });
    expect(screen.queryByRole("button", { name: "How Sasha works?" })).toBeNull();
  });

  it("never opens by itself when storage cannot be read, and the companion still opens it", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(readTourSeen({ userId: "a", epoch: 1 })).toBe("unknown");
    render(<MotionConfig reducedMotion="always">
      <TodayTour onboardedAt={ONBOARDED} />
      <SproutStage state={{ mood: "content", vitality: 0.7, line: "Sprout is doing fine." }} glance={null} bounce={0} />
    </MotionConfig>);
    wait();
    expect(tour()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sprout. Say hello" }));
    fireEvent.click(screen.getByRole("button", { name: "How Sasha works?" }));
    expect(tour()).toBeTruthy();
    spy.mockRestore();
  });

  it("never opens by itself when a write cannot be read back", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("full"); });
    expect(readTourSeen({ userId: "a", epoch: 1 })).toBe("unknown");
    mount(ONBOARDED);
    wait();
    expect(tour()).toBeNull();
    spy.mockRestore();
  });

  it("proves unseen only with a working read and write, and leaves no probe behind", () => {
    expect(readTourSeen({ userId: "a", epoch: 1 })).toBe("unseen");
    expect(Object.keys(localStorage).filter((k) => k.includes("probe"))).toEqual([]);
    localStorage.setItem(`smc:u:a:${TOUR_SEEN_NAME}`, ONBOARDED);
    expect(readTourSeen({ userId: "a", epoch: 1 })).toBe("seen");
  });
});
