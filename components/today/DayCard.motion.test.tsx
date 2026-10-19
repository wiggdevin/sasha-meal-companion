// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MotionConfig } from "motion/react";
import DayCard from "./DayCard";
import type { OverviewData } from "./overview/types";
import type { Macros } from "@/lib/types";

/**
 * The Day card's motion: the two faces never remount, and the card's height is held and sprung
 * between them. jsdom has no layout, so the faces box reads a fixed height per face from a stub.
 */
const targets: Macros = { kcal: 2000, protein: 150, carbs: 200, fat: 70 };
const consumed: Macros = { kcal: 1200, protein: 90, carbs: 80, fat: 30 };
const HEIGHTS = { calendar: 200, overview: 366 } as const;

let restoreHeight: (() => void) | null = null;
beforeEach(() => {
  window.scrollTo = () => {};
  Element.prototype.scrollIntoView = vi.fn();
  const own = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.style.height) return parseFloat(this.style.height);
      const active = this.querySelector(':scope > [role="tabpanel"][data-active]');
      return active ? HEIGHTS[active.getAttribute("data-face") as keyof typeof HEIGHTS] : 0;
    },
  });
  restoreHeight = () => { if (own) Object.defineProperty(HTMLElement.prototype, "offsetHeight", own); };
});
afterEach(() => { cleanup(); restoreHeight?.(); vi.useRealTimers(); });

const overview: OverviewData = {
  date: "2026-10-01", today: "2026-10-01", when: "today", targets, consumed, partial: false,
  water: { cups: 4, goal: 8 }, onAddCup: () => {}, onSetCups: () => {},
  next: { slot: "meal-2", label: "Meal 2", name: "Eggs & Jasmine rice", time: "10:30", kcal: 940, protein: 42, image: null },
  planned: 3, onMarkEaten: () => {},
};

function mount(reduced = false) {
  const card = <DayCard calendar={<div>Week calendar</div>} overview={overview} />;
  return render(reduced ? <MotionConfig reducedMotion="always">{card}</MotionConfig> : card);
}

const tab = (name: "Calendar" | "Overview") => screen.getByRole("tab", { name });
const panel = (name: "Calendar" | "Overview") => document.getElementById(tab(name).getAttribute("aria-controls")!)!;
const facesBox = () => panel("Calendar").parentElement!;
const eat = (scope: HTMLElement, hidden = false) =>
  within(scope).getByRole("button", { name: "Mark Eggs & Jasmine rice eaten", hidden });

describe("DayCard · faces stay mounted", () => {
  it("switches between the calendar and the overview without remounting either or the overview's rows", () => {
    mount();
    const before = { calendar: panel("Calendar"), overview: panel("Overview") };
    const button = eat(before.overview);
    for (const name of ["Calendar", "Overview", "Calendar", "Overview"] as const) fireEvent.click(tab(name));
    expect(panel("Calendar")).toBe(before.calendar);
    expect(panel("Overview")).toBe(before.overview);
    expect(eat(panel("Overview"))).toBe(button);
  });
});

describe("DayCard · height", () => {
  it("holds the card at the overview's height and springs it to the calendar's own", async () => {
    mount();
    fireEvent.click(tab("Calendar"));
    expect(facesBox().style.height).toBe(`${HEIGHTS.overview}px`);
    // Settled, the box hands its height back to its content (the month).
    await waitFor(() => expect(facesBox().style.height).toBe(""), { timeout: 3000 });
  });

  it("takes each face's height at once under reduced motion", () => {
    mount(true);
    fireEvent.click(tab("Calendar"));
    expect(facesBox().style.height).toBe("");
    fireEvent.click(tab("Overview"));
    expect(facesBox().style.height).toBe("");
  });
});
