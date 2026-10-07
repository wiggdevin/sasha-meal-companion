// @vitest-environment jsdom
/**
 * Kimi K4 (2026-10-04): the review before logging could open with its commit under the dock. When it
 * appears, the page moves just far enough to bring the commit row above the dock.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MotionConfig } from "motion/react";
import PanelReview from "@/components/plan/PanelReview";
import { DOCK_CLEARANCE } from "@/lib/dom/spring-scroll";
import { captureProposal } from "@/tests/coach/editors/fixtures";

afterEach(() => { cleanup(); vi.restoreAllMocks(); document.documentElement.scrollTop = 0; });

const pending = { draft: captureProposal, slot: "meal-2" as const,
  at: { localDate: "2026-10-04", tz: "UTC", eatenAt: new Date("2026-10-04T12:00:00Z") } };

function mount(commitBottom: number) {
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((run) => { run(0); return 1; });
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.hasAttribute("data-review-commit")) return { bottom: commitBottom, top: commitBottom - 120 } as DOMRect;
    return original.call(this);
  });
  render(<MotionConfig reducedMotion="always">
    <PanelReview pending={pending} label="Meal 2" onConfirm={async () => null} onCancel={() => {}} onDone={() => {}} />
  </MotionConfig>);
}

describe("the review before logging", () => {
  it("brings its commit above the dock when it would open under it", () => {
    Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, value: 4000 });
    // The commit's foot sits 20 px above the screen's bottom edge: under the dock.
    mount(window.innerHeight - 20);
    expect(screen.getByRole("button", { name: "Log it" })).toBeTruthy();
    // Up by the dock and its gap, less the 20 px it already cleared the edge by.
    expect(document.documentElement.scrollTop).toBe(DOCK_CLEARANCE + 12 - 20);
  });

  it("leaves the page alone when the commit already sits above the dock", () => {
    mount(200);
    expect(document.documentElement.scrollTop).toBe(0);
  });
});
