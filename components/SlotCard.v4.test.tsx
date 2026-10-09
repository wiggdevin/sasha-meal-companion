// @vitest-environment jsdom
/**
 * Cards v4 (brief ~/Inbox/plans/2026-10-08-sasha-cards-redesign-brief.md §3): two fixed header
 * presets that never change shape when the card opens, one merged figure line, no chip on the photo,
 * an inset panel only when there is something in it, and the strip's swap-unavailable dash.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MotionConfig } from "motion/react";
import SlotCard from "./SlotCard";
import type { ResolvedSlot } from "@/lib/types";

afterEach(cleanup);

const lunch: ResolvedSlot = {
  slot: "meal-2", time: "12:30", label: "Meal 2",
  meal: { id: "m", name: "Chicken and rice", slot: "meal-2", components: [],
    macros: { kcal: 541, protein: 52, carbs: 56, fat: 13 }, prepMinutes: 10, tags: [] },
  components: [], macros: { kcal: 541, protein: 52, carbs: 56, fat: 13 }, eaten: false,
};

function Card(props: Partial<React.ComponentProps<typeof SlotCard>>) {
  return <MotionConfig reducedMotion="always">
    <SlotCard slot={lunch} variant="standard" canSwap onToggleEaten={() => {}} onOpenSwap={() => {}}
      onPlanWithCoach={() => {}} onLogWhatYouAte={() => {}} {...props} />
  </MotionConfig>;
}

const header = () => (document.querySelector("[data-meal-header]") as HTMLElement).outerHTML;

describe("cards v4 header", () => {
  it.each(["focus", "standard"] as const)("keeps the %s card's header exactly as it was when the card opens", (variant) => {
    render(<Card variant={variant} focusLabel={variant === "focus" ? "Next" : undefined} />);
    const card = document.querySelector("[data-meal-card]") as HTMLElement;
    const density = card.dataset.cardDensity;
    const before = header();
    fireEvent.click(screen.getByRole("button", { name: "Expand Meal 2" }));
    expect(screen.getByRole("region", { name: "Meal 2 details" })).toBeTruthy();
    expect(card.dataset.cardDensity).toBe(density);
    expect(header()).toBe(before);
  });

  it("sets the status and time as an eyebrow in the text, never a chip on the photo", () => {
    render(<Card variant="focus" focusLabel="Next" />);
    const eyebrow = document.querySelector("[data-meal-time]") as HTMLElement;
    expect(eyebrow.closest("[data-meal-photo]")).toBeNull();
    expect(document.querySelector("[data-meal-photo]")?.parentElement?.contains(eyebrow)).toBe(false);
    expect(eyebrow.textContent).toMatch(/^Next·12:30 PM$/);
  });

  it("reads calories and protein as one line on every card", () => {
    render(<Card />);
    expect((document.querySelector("[data-meal-figures]") as HTMLElement).textContent).toBe("541 KCAL·52g protein");
  });
});

describe("cards v4 inset panel", () => {
  it("draws no panel on a collapsed card with nothing to say", () => {
    render(<Card />);
    expect(document.querySelector("[data-card-tray]")).toBeNull();
  });

  it("opens the panel for a rule mark or a plan miss, and for the detail", () => {
    render(<Card planMiss="18 g short of protein." />);
    expect(document.querySelector("[data-card-tray]")).not.toBeNull();
    cleanup();
    render(<Card />);
    fireEvent.click(screen.getByRole("button", { name: "Expand Meal 2" }));
    expect(document.querySelector("[data-card-tray]")).not.toBeNull();
  });

  it("offers the rare actions as plain text links, not pills", () => {
    render(<Card onAteSomethingElse={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand Meal 2" }));
    const links = document.querySelector("[data-meal-links]") as HTMLElement;
    for (const name of ["Ask Sasha about Meal 2", "Ate something else for Meal 2"]) {
      const link = screen.getByRole("button", { name });
      expect(links.contains(link)).toBe(true);
      expect(link.className).not.toMatch(/\bbtn\b/);
    }
  });
});

describe("cards v4 strip", () => {
  it("shows a plain dash when the meal cannot swap, never a faded icon", () => {
    render(<Card slot={{ ...lunch, eaten: true }} />);
    const zone = document.querySelector('[data-strip-zone="swap"]') as HTMLElement;
    expect(zone.textContent).toBe("—");
    expect(zone.querySelector("svg")).toBeNull();
  });

  it("turns the details chevron over as the card opens", () => {
    render(<Card />);
    const toggle = screen.getByRole("button", { name: "Expand Meal 2" });
    expect(toggle.querySelector("[data-open]")).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Collapse Meal 2" }).querySelector('[data-open="true"]')).not.toBeNull();
  });
});
