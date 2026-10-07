// @vitest-environment jsdom
/**
 * Sprout's pond (owner, 2026-10-07): the rings become a rainbow over a lake; tapping it shows a
 * "remaining" key on the water without "left"; when the day falls behind Sprout sits facing away, and
 * a poke makes it look back. jsdom has no WebGL: the painted lake stands in, and everything else works.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MotionConfig } from "motion/react";
import PondScene from "./PondScene";
import { BOX, HORIZON, MACRO_BANDS, bandShare, groundFromBox, rainbowHit } from "./scene-geometry";
import type { PanelData } from "@/components/today/LiveWidgetPanels";
import type { PetState } from "@/lib/today/pet-mood";

const DATA: PanelData = {
  targets: { kcal: 2000, protein: 150, carbs: 200, fat: 70 },
  consumed: { kcal: 2100, protein: 30, carbs: 50, fat: 15 },
  partial: false,
};
const FINE: PetState = { mood: "content", vitality: 0.7, line: "Sprout is doing fine." };
const LOW: PetState = { mood: "droopy", vitality: 0.2, line: "Sprout is feeling a little low." };
const scene = (pet: PetState, data = DATA) =>
  render(<MotionConfig reducedMotion="always"><PondScene data={data} pet={pet} /></MotionConfig>);

afterEach(cleanup);

describe("PondScene", () => {
  it("draws one rainbow band per measure and shows the remaining key on a tap, then hides it", async () => {
    const { container } = scene(FINE);
    expect([...container.querySelectorAll("[data-band]")].map((g) => g.getAttribute("data-band")))
      .toEqual(["kcal", "protein", "carbs", "fat"]);
    expect(screen.queryByRole("group", { name: "Remaining today" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show what remains today" }));
    const key = screen.getByRole("group", { name: "Remaining today" });
    expect(key.textContent).toContain("remaining");
    expect(key.textContent).toContain("100 over");
    expect(key.textContent).toContain("120g PRO");
    expect(key.textContent).not.toMatch(/left/);
    fireEvent.click(screen.getByRole("button", { name: "Hide what remains" }));
    await waitFor(() => expect(screen.queryByRole("group", { name: "Remaining today" })).toBeNull());
  });

  it("says a partly measured remainder is at most", () => {
    scene(FINE, { ...DATA, partial: true, consumed: { ...DATA.consumed, kcal: 500 } });
    fireEvent.click(screen.getByRole("button", { name: "Show what remains today" }));
    expect(screen.getByRole("group", { name: "Remaining today" }).textContent).toContain("up to 1,500");
  });

  it("sulks facing away while the day is behind, with kind words, and looks back when poked", () => {
    const { container } = scene(LOW);
    expect(screen.getByText("Sprout is waiting for you.", { selector: "[aria-live]" })).toBeTruthy();
    expect(container.querySelector('[data-on] img')?.getAttribute("src")).toContain("sprout-sulk");
    fireEvent.click(screen.getByRole("button", { name: "Sprout. Poke" }));
    expect(container.querySelector('[data-on] img')?.getAttribute("src")).toContain("sprout-lookback");
    expect(container.textContent).not.toMatch(/eat|should|must/i);
  });

  it("fishes when the day is fine, and greets a first poke", () => {
    const { container } = scene(FINE);
    expect(container.querySelector('[data-on] img')?.getAttribute("src")).toContain("sprout-fishing");
    fireEvent.click(screen.getByRole("button", { name: "Sprout. Poke" }));
    expect(screen.getByText("Sprout waves without letting go of the rod.", { selector: "[aria-live]" })).toBeTruthy();
  });
});

describe("a saved Macro rings view", () => {
  it("keeps its meaning: a three-band rainbow and key without calories", () => {
    const { container } = render(<MotionConfig reducedMotion="always">
      <PondScene data={DATA} pet={FINE} bands={MACRO_BANDS} /></MotionConfig>);
    expect([...container.querySelectorAll("[data-band]")].map((g) => g.getAttribute("data-band")))
      .toEqual(["protein", "carbs", "fat"]);
    fireEvent.click(screen.getByRole("button", { name: "Show what remains today" }));
    expect(screen.getByRole("group", { name: "Remaining today" }).textContent).not.toContain("kcal");
  });
});

describe("scene geometry", () => {
  it("clips the rainbow's tap area to the arcs, at least 44 deep", () => {
    const hit = rainbowHit(4);
    expect(hit.clip.startsWith("polygon(")).toBe(true);
    expect(hit.clip.split(",").length).toBe(50);
    expect(hit.h).toBeGreaterThanOrEqual(60);
  });

  it("lights a band by the share eaten, never past full, and nothing for an unknown target", () => {
    expect(bandShare(50, 200)).toBe(0.25);
    expect(bandShare(300, 200)).toBe(1);
    expect(bandShare(50, 0)).toBe(0);
    expect(bandShare(Number.NaN, 200)).toBe(0);
  });

  it("maps the water in perspective: nothing above the horizon, farther water higher on screen", () => {
    expect(groundFromBox(100, HORIZON - 1)).toBeNull();
    const near = groundFromBox(BOX.w / 2, BOX.h - 10)!;
    const far = groundFromBox(BOX.w / 2, HORIZON + 40)!;
    expect(far.gz).toBeGreaterThan(near.gz);
    expect(near.gx).toBeCloseTo(0.5);
  });
});
