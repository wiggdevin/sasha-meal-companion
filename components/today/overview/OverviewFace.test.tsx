// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MotionConfig } from "motion/react";
import OverviewFace, { COCKPIT_MAX_BLOCKS, type CockpitData } from "./OverviewFace";
import DayCard from "@/components/today/DayCard";
import { CardToneContext } from "@/components/ui/CardFrame";
import type { RebalancePanel } from "@/lib/rebalance/panel";
import type { Macros } from "@/lib/types";

/** The Overview face, the daily cockpit (UI makeover W2, plan §4 and §11). */
const targets: Macros = { kcal: 2000, protein: 140, carbs: 200, fat: 70 };
const consumed: Macros = { kcal: 760, protein: 62, carbs: 80, fat: 30 };
const NEXT = { slot: "meal-3" as const, label: "Meal 3", name: "Salmon & rice", time: "12:30", kcal: 640, protein: 42, image: null };
const REBALANCE: RebalancePanel = {
  show: true, state: "under", tone: "nudge", copyKey: "under",
  numbers: { targetKcal: 2000, recordedKcal: 760, leftKcal: 1240, plannedKcal: 1800,
    intake: { status: "complete", estimatedSlots: 0, unknownSlots: 0, unknownItems: 0, unknownEntries: 0, partial: false },
    proteinTargetG: 140, proteinConsumedG: 62 },
  cards: [{ slot: "meal-2", label: "Lunch", time: "12:30", kcal: 600, status: "missed", highlight: true }],
};

// The companion (W3) and the week (W4) fill their own slots; here each is a placeholder row, so the
// budget below checks the cockpit's own blocks whatever those slots grow into.
vi.mock("@/components/today/overview/CompanionSlot", () => ({ default: () => <div data-slot="companion" /> }));
vi.mock("@/components/today/overview/TrendsSlot", () => ({ default: () => <div data-slot="trends" /> }));

beforeEach(() => { window.scrollTo = () => {}; Element.prototype.scrollIntoView = vi.fn(); });
afterEach(cleanup);

/** A realistic day: two of four meals eaten, the third next at 12:30, water part way. */
function data(over: Partial<CockpitData> = {}): CockpitData {
  return {
    date: "2026-10-01", today: "2026-10-01", when: "today", dayType: "rest", targets, consumed, partial: false,
    water: { cups: 4, goal: 8, unit: "cups" }, next: NEXT, planned: 4, eaten: 2, ...over,
  };
}

/** Inside the Day card the face's frames take the inset step, as on Today. */
function mount(over: Partial<CockpitData> = {}) {
  const onMarkEaten = vi.fn();
  const onOpenSlot = vi.fn();
  const face = (d: CockpitData) => <MotionConfig reducedMotion="always">
    <CardToneContext.Provider value={{ depth: 0, face: "raised" }}>
      <OverviewFace data={d} active />
    </CardToneContext.Provider>
  </MotionConfig>;
  const utils = render(face(data({ onMarkEaten, onOpenSlot, ...over })));
  const root = () => utils.container.querySelector<HTMLElement>("[data-cockpit]")!;
  return { ...utils, onMarkEaten, onOpenSlot, root, rerenderWith: (d: Partial<CockpitData>) =>
    utils.rerender(face(data({ onMarkEaten, onOpenSlot, ...d }))) };
}

describe("OverviewFace · summary with targets", () => {
  it("leads with calories left as the big numeral and the macros as compact bars", () => {
    const { root } = mount();
    const summary = within(root()).getByRole("button", { name: /^1,240 kcal left\./ });
    expect(summary.textContent).toContain("1,240");
    expect(summary.textContent).toContain("kcal left");
    expect(summary.textContent).toContain("760 of 2,000 eaten");
    for (const text of ["62/140 g", "80/200 g", "30/70 g"]) expect(summary.textContent).toContain(text);
    expect(summary.getAttribute("aria-label")).toContain("Protein 62 of 140 grams");
  });

  it("says over, not a negative, once the day passes its target", () => {
    const { root } = mount({ consumed: { kcal: 2180, protein: 150, carbs: 220, fat: 75 } });
    expect(within(root()).getByRole("button", { name: /^180 kcal over\./ })).toBeTruthy();
  });

  it("scrolls to the day's nutrients on a tap", () => {
    const target = document.createElement("section");
    target.id = "day-nutrients";
    document.body.append(target);
    const { root } = mount();
    fireEvent.click(within(root()).getByRole("button", { name: /kcal left/ }));
    expect(target.scrollIntoView).toHaveBeenCalled();
    target.remove();
  });
});

describe("OverviewFace · partly measured day", () => {
  it("says at most left and at least eaten, in words", () => {
    const { root } = mount({ partial: true });
    const summary = within(root()).getByRole("button", { name: /^at most 1,240 kcal left\./ });
    expect(summary.textContent).toContain("at most kcal left");
    expect(summary.textContent).toContain("at least 760 of 2,000 eaten");
    expect(summary.getAttribute("aria-label")).toContain("Protein at least 62 of 140 grams");
  });
});

describe("OverviewFace · without targets", () => {
  it("invents nothing before the first revision: the Finish your profile prompt, no numeral, no bars", () => {
    const { root } = mount({ targets: null });
    expect(within(root()).getByRole("heading", { name: "Finish your profile" })).toBeTruthy();
    expect(within(root()).getByRole("link", { name: "Set up" }).getAttribute("href")).toBe("/settings");
    expect(root().textContent).not.toMatch(/kcal left|kcal over|\/140 g/);
    // The meals and the next step still stand: they need no target.
    expect(root().textContent).toContain("Salmon & rice");
  });
});

describe("OverviewFace · meals", () => {
  it("shows done of planned and the next meal with its time; a tap opens that slot", () => {
    const { root, onOpenSlot } = mount();
    const meals = within(root()).getByRole("region", { name: "Meals" });
    expect(meals.textContent).toContain("2 of 4 meals");
    expect(meals.textContent).toContain("Next · 12:30 PM");
    fireEvent.click(within(meals).getByRole("button", { name: /^Next: Salmon & rice at 12:30 PM, 640 kcal/ }));
    expect(onOpenSlot).toHaveBeenCalledWith("meal-3");
  });

  it("marks the next meal eaten from its check, and drops the check at once when the next meal changes", () => {
    const { onMarkEaten, rerenderWith } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Mark Salmon & rice eaten" }));
    expect(onMarkEaten).toHaveBeenCalledWith("meal-3");
    rerenderWith({ eaten: 3, next: { ...NEXT, slot: "meal-4", name: "Yogurt", time: "16:00" } });
    expect(screen.queryByRole("button", { name: "Mark Salmon & rice eaten" })).toBeNull();
    expect(screen.getByRole("button", { name: "Mark Yogurt eaten" })).toBeTruthy();
  });

  it("ignores a second tap that lands on the next meal's check as it slides in", () => {
    const { onMarkEaten, rerenderWith } = mount();
    rerenderWith({ eaten: 3, next: { ...NEXT, slot: "meal-4", name: "Yogurt", time: "16:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Mark Yogurt eaten" }));
    expect(onMarkEaten).not.toHaveBeenCalled();
  });

  it("says all eaten when every planned meal is in, never a scolding", () => {
    const { root } = mount({ next: null, eaten: 4 });
    expect(root().textContent).toContain("4 of 4 meals");
    expect(root().textContent).toContain("Every planned meal on this day is eaten.");
  });

  it("says nothing planned when the day has no meals, and shows no count it does not know", () => {
    const { root, rerenderWith } = mount({ next: null, planned: 0, eaten: 0 });
    expect(root().textContent).toContain("No meals are planned for this day.");
    rerenderWith({ eaten: undefined });
    expect(root().textContent).not.toMatch(/\d of 4 meals/);
  });
});

describe("OverviewFace · rebalance and next step", () => {
  it("shows the rebalance line only while the page passes one, read-only with one link", () => {
    const { root, onOpenSlot, rerenderWith } = mount({ rebalance: { show: false } });
    expect(within(root()).queryByRole("region", { name: "Rebalance my day" })).toBeNull();
    rerenderWith({ rebalance: REBALANCE });
    const row = within(root()).getByRole("region", { name: "Rebalance my day" });
    expect(row.textContent).toContain("1240 kcal left today");
    fireEvent.click(within(row).getByRole("button", { name: "View meal: Lunch" }));
    expect(onOpenSlot).toHaveBeenCalledWith("meal-2");
  });

  it("gives one next step line", () => {
    const { root, rerenderWith } = mount();
    const steps = root().querySelectorAll("[data-next-step]");
    expect(steps).toHaveLength(1);
    expect(steps[0].textContent).toBe("Tick each meal once you've had it.");
    rerenderWith({ water: { cups: 0, goal: 8, unit: "cups" } });
    expect(root().querySelector("[data-next-step]")?.textContent).toBe("No water yet today. Tap the cup to log some.");
  });
});

describe("OverviewFace · cockpit budget", () => {
  it("fits one phone screen by structure: at most six blocks, each a small inset card or one line", () => {
    const { root } = mount({ rebalance: REBALANCE });
    const blocks = [...root().children] as HTMLElement[];
    expect(blocks.length).toBeLessThanOrEqual(COCKPIT_MAX_BLOCKS);
    // Summary, meals, rebalance, the next step, then the companion and the week, in that order.
    expect(blocks.slice(-2).map((block) => block.getAttribute("data-slot"))).toEqual(["companion", "trends"]);
    for (const block of blocks) {
      if (block.hasAttribute("data-next-step") || block.hasAttribute("data-slot")) continue;
      expect(block.className).toContain("card-sm");
      // Inside the Day card every block is the inset step, so none blends into the card behind it.
      expect(block.className).toContain("card-recess");
      expect(block.className).not.toContain("shell");
    }
    expect(root().querySelectorAll(".card-md, .card-lg")).toHaveLength(0);
  });

  it("holds no water control of its own: the cup is the Day card header's, named once", () => {
    const { root } = mount();
    expect(within(root()).queryByRole("button", { name: /water/i })).toBeNull();
    render(<MotionConfig reducedMotion="always">
      <DayCard calendar={<div>Week calendar</div>} overview={data({ onAddCup: () => {}, onSetCups: () => {} })} />
    </MotionConfig>);
    const card = document.querySelector<HTMLElement>('section[aria-label="Day"]')!;
    const overview = card.querySelector<HTMLElement>('[data-face="overview"]')!;
    expect(within(overview).queryAllByRole("button", { name: /water/i })).toHaveLength(0);
    expect(within(card.querySelector("header")!).getAllByRole("button", { name: /water/i })).toHaveLength(1);
  });
});
