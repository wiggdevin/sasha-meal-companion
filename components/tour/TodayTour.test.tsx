// @vitest-environment jsdom
/**
 * Today's overview host: it opens by itself once per account after onboarding, never before it,
 * and again whenever the companion in the well is tapped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MotionConfig } from "motion/react";
import TodayTour, { AUTO_OPEN_DELAY_MS } from "./TodayTour";
import { TOUR_SEEN_NAME, hasSeenTour } from "./tour-seen";
import SproutStage from "@/components/today/island/Sprout";

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
    expect(tour()).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    act(() => { vi.runOnlyPendingTimers(); });
  });

  it("never throws when storage cannot be read", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(() => { mount(ONBOARDED); wait(); }).not.toThrow();
    spy.mockRestore();
  });
});
