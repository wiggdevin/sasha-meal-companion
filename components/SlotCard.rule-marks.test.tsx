// @vitest-environment jsdom
/**
 * Saved meals against the CURRENT food rules (2026-10-05, contract #380): the card shows the slot's
 * worst mark on its beige tray (`.matte-reset`, so the reason reads in ink, never on the charcoal
 * hero beside the title, time pill or calories), and once open each ingredient line carries its own
 * `componentRuleMarks` entry. Missing or null marks say nothing; an eaten slot is history and is
 * never marked. A mark never hides a line or blocks a tap.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SlotCard from "./SlotCard";
import { lineRuleMarks, slotRuleMark } from "./SlotRuleMarks";
import type { FoodComponent, ResolvedSlot, RuleMark } from "@/lib/types";

const line = (name: string, kcal: number): FoodComponent => ({ name, qty: 1, unit: "whole", role: "free",
  macros: { kcal, protein: 10, carbs: 10, fat: 5 } });
const PEANUT: RuleMark = { verdict: "blocked", reason: "Peanut butter has peanut, which your rules exclude." };
const CHECKING: RuleMark = { verdict: "unknown", reason: "Checking against your updated food rules." };

const base: ResolvedSlot = { slot: "meal-1", label: "Meal 1", time: "08:00",
  meal: { id: "saved", slot: "meal-1", name: "Toast and peanut butter", components: [],
    macros: { kcal: 400, protein: 20, carbs: 40, fat: 15 }, prepMinutes: 0, tags: [] },
  components: [line("Toast", 200), line("Peanut butter", 200)],
  macros: { kcal: 400, protein: 20, carbs: 40, fat: 15 }, eaten: false };

function card(slot: ResolvedSlot) {
  return render(<SlotCard slot={slot} variant="standard" canSwap={false}
    onToggleEaten={vi.fn()} onOpenSwap={vi.fn()} />);
}

afterEach(cleanup);

describe("the meal card's rule marks", () => {
  it("shows a blocked slot's mark on the tray, in ink, clear of the hero", () => {
    const { container } = card({ ...base, ruleMark: PEANUT, componentRuleMarks: [null, PEANUT] });
    const line = container.querySelector("[data-slot-rule-mark]") as HTMLElement;
    expect(line.getAttribute("data-slot-rule-mark")).toBe("blocked");
    expect(line.textContent).toContain("Off your rules");
    expect(line.textContent).toContain(PEANUT.reason);
    expect(line.closest(".matte-reset")).not.toBeNull();
    expect(container.querySelector("[data-meal-header]")?.contains(line)).toBe(false);
    // The tag is the red role on its own wash, so it reads the same inside the meal card.
    expect(within(line).getByText("Off your rules").className).toContain("text-red-ink");
  });

  it("shows an unknown slot as Check with its reason", () => {
    const { container } = card({ ...base, ruleMark: CHECKING, componentRuleMarks: [CHECKING, null] });
    const line = container.querySelector("[data-slot-rule-mark]") as HTMLElement;
    expect(line.getAttribute("data-slot-rule-mark")).toBe("unknown");
    expect(within(line).getByText("Check").className).toContain("text-yellow-ink");
    expect(line.textContent).toContain(CHECKING.reason);
  });

  it("says nothing for a clear slot, or one built before the fields existed", () => {
    for (const slot of [{ ...base, ruleMark: null, componentRuleMarks: [null, null] }, base]) {
      const { container } = card(slot);
      expect(container.querySelector("[data-rule-mark]")).toBeNull();
      cleanup();
    }
  });

  it("never marks an eaten slot, whatever it carries", () => {
    const { container } = card({ ...base, eaten: true, eatenAt: "2026-10-05T08:10:00Z",
      ruleMark: PEANUT, componentRuleMarks: [null, PEANUT] });
    expect(container.querySelector("[data-rule-mark]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Expand Meal 1" }));
    expect(container.querySelector("[data-rule-mark]")).toBeNull();
  });

  it("marks each open ingredient line with its own entry, and the card line steps aside", () => {
    const { container } = card({ ...base, ruleMark: PEANUT, componentRuleMarks: [null, PEANUT] });
    fireEvent.click(screen.getByRole("button", { name: "Expand Meal 1" }));
    const lines = [...container.querySelectorAll("[data-ingredient-line]")] as HTMLElement[];
    expect(lines.map((row) => row.querySelector("[data-ingredient-name]")?.textContent))
      .toEqual(["Toast", "Peanut butter"]);
    expect(lines[0].querySelector("[data-rule-mark]")).toBeNull();
    expect(lines[1].querySelector("[data-rule-mark]")?.getAttribute("data-rule-mark")).toBe("blocked");
    expect(lines[1].textContent).toContain(PEANUT.reason);
    // Still there, still one line each: the mark adds a line, it removes nothing.
    expect(lines[1].querySelector("[data-ingredient-name]")?.textContent).toBe("Peanut butter");
  });
});

describe("lineRuleMarks and slotRuleMark", () => {
  const marked = { ...base, ruleMark: PEANUT, componentRuleMarks: [null, PEANUT] };

  it("reads resolveDay's lines by position and an edited draft by name", () => {
    expect(lineRuleMarks(marked, marked.components)).toEqual([null, PEANUT]);
    const draft = [line("Peanut butter", 100), line("Banana", 90)];
    expect(lineRuleMarks(marked, draft)).toEqual([PEANUT, null]);
    expect(lineRuleMarks({ ...marked, componentRuleMarks: undefined }, marked.components)).toEqual([null, null]);
    expect(lineRuleMarks({ ...marked, eaten: true }, marked.components)).toEqual([null, null]);
  });

  it("keeps the card line open only when no ingredient line carries a mark", () => {
    expect(slotRuleMark(marked, false)).toEqual(PEANUT);
    expect(slotRuleMark(marked, true)).toBeNull();
    // An accepted recipe with no lines still carries its recipe's verdict.
    expect(slotRuleMark({ ...marked, components: [], componentRuleMarks: [] }, true)).toEqual(PEANUT);
    expect(slotRuleMark({ ...marked, ruleMark: undefined }, false)).toBeNull();
    expect(slotRuleMark({ ...marked, eaten: true }, false)).toBeNull();
  });
});
