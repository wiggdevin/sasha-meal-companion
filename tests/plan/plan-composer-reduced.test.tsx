// @vitest-environment jsdom
/**
 * Under reduced motion the ask box's tab does not morph: the raised outline is drawn once, whole,
 * and fades in over the flat pill; the tab's buttons fade rather than pop.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import PlanComposer from "@/components/plan/PlanComposer";
import { RISE, plateauWidth, tabPath, tabRegionPath } from "@/components/plan/composer/tab-shape";

vi.mock("motion/react", async (original) => ({
  ...(await original<typeof import("motion/react")>()), useReducedMotion: () => true,
}));

const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true, get() { return this.tagName === "FORM" ? 320 : 0; } });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true, get() { return this.tagName === "FORM" ? 56 : 0; } });
});
afterAll(() => {
  if (offsetWidth) Object.defineProperty(HTMLElement.prototype, "offsetWidth", offsetWidth);
  if (offsetHeight) Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeight);
});
afterEach(cleanup);

describe("the + tab under reduced motion", () => {
  it("fades the whole raised outline in over the flat pill, with no path animation", async () => {
    const { container } = render(<PlanComposer draft="" onDraft={() => {}} onSubmit={() => {}} onPhoto={() => {}}
      onDocument={() => {}} busy={false} />);
    const svg = container.querySelector("svg[data-tab-motion]")!;
    expect(svg.getAttribute("data-tab-motion")).toBe("fade");
    expect(svg.querySelector('[data-shape="morph"]')).toBeNull();
    const plateau = plateauWidth(2);
    const flat = svg.querySelector('[data-shape="flat"] path[data-shape-fill]')!;
    const raised = svg.querySelector<SVGGElement>('[data-shape="raised"]')!;
    const raisedD = tabPath({ width: 320, height: 56, rise: RISE, spread: 1, plateau });
    expect(flat.getAttribute("d")).toBe(tabPath({ width: 320, height: 56, rise: 0, spread: 0, plateau }));
    expect(raised.querySelector("path[data-shape-fill]")!.getAttribute("d")).toBe(raisedD);
    expect(raised.style.opacity).toBe("0");
    // The tab's tint rides in the same fading layer, cut to the raised tab's region.
    expect(raised.querySelector("path[data-shape-tab]")!.getAttribute("d")).toBe(raisedD);
    expect(raised.querySelector("clipPath path")!.getAttribute("d"))
      .toBe(tabRegionPath({ width: 320, height: 56, rise: RISE, spread: 1, plateau }));

    fireEvent.click(screen.getByRole("button", { name: "Add a photo or file" }));
    expect(screen.getByRole("button", { name: "Take a photo" })).toBeTruthy();
    // The outline itself never changes; only the raised layer's opacity does.
    expect(raised.querySelector("path[data-shape-fill]")!.getAttribute("d")).toBe(raisedD);
    await waitFor(() => expect(raised.style.opacity).toBe("1"));
  });
});
