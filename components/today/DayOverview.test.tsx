// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MotionConfig } from "motion/react";
import DayOverview from "./DayOverview";
import type { PanelData } from "@/components/today/LiveWidgetPanels";
import type { OrbitBody } from "@/lib/today/health-orbit";
import type { DailyHealthRow } from "@/lib/health/contract";
import type { Macros } from "@/lib/types";

/** The Day card's Overview face, cards v4 (brief 2026-10-08 §4): the hero counts what is LEFT. */

const targets: Macros = { kcal: 2000, protein: 150, carbs: 200, fat: 70 };
const none: Macros = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
const some: Macros = { kcal: 1200, protein: 90, carbs: 80, fat: 30 };
const past: Macros = { kcal: 2300, protein: 160, carbs: 210, fat: 80 };

const row: DailyHealthRow = {
  local_date: "2026-10-08", steps: 6400, active_kcal: 420, sleep_minutes: 452, body_mass_kg: null, sources: ["oura"],
  resting_heart_rate: null, hrv_sdnn: null, readiness_score: null, provenance: {},
};
const ready: OrbitBody = { capability: "enabled", loading: false, row, offline: false, fetchedAt: "2026-10-08T07:00:00Z" };

beforeEach(() => { window.scrollTo = () => {}; });
afterEach(cleanup);

function mount(data: Partial<PanelData> = {}, body?: OrbitBody) {
  const full: PanelData = { targets, consumed: some, partial: false, water: { cups: 4, goal: 8 }, ...data };
  return render(<MotionConfig reducedMotion="always"><DayOverview data={full} body={body} /></MotionConfig>);
}

const hero = () => screen.getByTestId("overview-hero");

describe("DayOverview · the hero counts what is left", () => {
  it("shows the calories LEFT as the hero figure, and the eaten figure one tier down", () => {
    mount();
    expect(hero().textContent).toBe("800");
    expect(screen.getByTestId("overview-hero-label").textContent).toBe("Left");
    expect(screen.getByTestId("overview-eaten").textContent).toContain("1,200");
    expect(screen.getByTestId("overview-eaten").textContent).toContain("eaten");
    expect(screen.getByLabelText("Calories").textContent).toContain("of 2,000 kcal");
  });

  it("draws a full ring on a fresh day, not an empty one", () => {
    mount({ consumed: none });
    expect(hero().textContent).toBe("2,000");
    expect(screen.getByTestId("overview-kcal-ring").getAttribute("data-share")).toBe("1");
  });

  it("over budget reads Over and shows the overage, with an empty ring", () => {
    mount({ consumed: past });
    expect(screen.getByTestId("overview-hero-label").textContent).toBe("Over");
    expect(hero().textContent).toBe("300");
    expect(screen.getByTestId("overview-kcal-ring").getAttribute("data-share")).toBe("0");
    expect(screen.getByLabelText("Calories").getAttribute("data-mood")).toBe("over");
  });

  it("a partly measured day bounds both figures in words", () => {
    mount({ partial: true });
    const well = screen.getByLabelText("Calories");
    expect(well.textContent).toContain("At most");
    expect(screen.getByTestId("overview-eaten").textContent?.toLowerCase()).toContain("at least");
    expect(well.textContent).toContain("at least 1,200 kcal eaten of 2,000. at most 800 kcal left.");
  });

  it("keeps the spoken summary of the calories accurate", () => {
    mount();
    expect(screen.getByLabelText("Calories").textContent).toContain("1,200 kcal eaten of 2,000. 800 kcal left.");
  });
});

describe("DayOverview · two wells", () => {
  it("draws exactly two wells: the hero and one quiet well", () => {
    const { container } = mount({}, ready);
    expect(container.querySelectorAll(".glass-well")).toHaveLength(2);
  });

  it("holds macros, water, active and recovery in the quiet well", () => {
    mount({}, ready);
    const quiet = screen.getByLabelText("Macros, water and body");
    expect(quiet.textContent).toContain("Protein: 90 grams of 150");
    expect(quiet.textContent).toContain("Water: 4 of 8 cups");
    expect(quiet.textContent).toContain("Active burn: 420 kcal");
    expect(quiet.textContent).toContain("Sleep and recovery: 7h 32m");
  });
});

describe("DayOverview · water", () => {
  it("at zero shows a genuinely empty bead, not a floored one", () => {
    mount({ water: { cups: 0, goal: 8 } });
    const bead = document.querySelector("[data-water]")!;
    expect(bead.hasAttribute("data-empty")).toBe(true);
  });

  it("with some water the bead holds liquid", () => {
    mount({ water: { cups: 4, goal: 8 } });
    expect(document.querySelector("[data-water]")!.hasAttribute("data-empty")).toBe(false);
    expect(screen.getByTestId("overview-water").textContent).toBe("4 / 8 cups");
  });

  it("while loading says so and holds no liquid", () => {
    mount({ water: undefined });
    expect(screen.getByLabelText("Macros, water and body").textContent).toContain("Water: loading");
    expect(document.querySelector("[data-water]")!.hasAttribute("data-empty")).toBe(true);
  });

  it("Add a cup is an icon-only circle button with an accessible name, on the 44 px hit system", () => {
    const onAddCup = vi.fn();
    mount({ onAddCup });
    const button = screen.getByRole("button", { name: "Add a cup of water" });
    expect(button.textContent?.trim()).toBe("");
    expect(button.className).toContain("btn-circle");
    expect(button.className).toContain("btn-sm");
    fireEvent.click(button);
    expect(onAddCup).toHaveBeenCalledTimes(1);
  });

  it("offers no Add a cup without a writer", () => {
    mount();
    expect(screen.queryByRole("button", { name: /Add a cup/ })).toBeNull();
  });
});

describe("DayOverview · active and recovery", () => {
  it("off offers a compact Connect link to Settings, never an unmeasured zero", () => {
    mount({}, { capability: "disabled", loading: false, row: null, offline: false, fetchedAt: null });
    const links = screen.getAllByRole("link", { name: "Connect health" });
    expect(links).toHaveLength(2);
    expect(links[0].getAttribute("href")).toBe("/settings");
    expect(links[0].className).toContain("tap");
    expect(screen.getByLabelText("Active burn").textContent).toContain("Off");
  });

  it("loading shows an ellipsis", () => {
    mount();
    expect(screen.getByLabelText("Active burn").textContent).toContain("Active burn: loading");
  });

  it("a reading from before the phone went offline says so", () => {
    mount({}, { ...ready, offline: true });
    const tile = screen.getByLabelText("Sleep and recovery");
    expect(tile.textContent).toContain("Saved earlier");
    expect(tile.textContent).toContain("from before you went offline");
  });
});
