// @vitest-environment jsdom
/**
 * The edit sheet's lines carry the slot's `componentRuleMarks` (2026-10-05, contract #380): each line
 * its own mark, read by name so a line keeps it as the draft changes; the line stays, stays editable,
 * and its "Change …" button is described by the mark. Missing marks, and an eaten slot, say nothing.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import EditSlotSheet from "./EditSlotSheet";
import type { FoodComponent, Macros, RuleMark } from "@/lib/types";

const line = (name: string): FoodComponent => ({ name, qty: 1, unit: "whole", role: "free",
  macros: { kcal: 100, protein: 5, carbs: 10, fat: 3 } });
const planned = [line("Toast"), line("Peanut butter"), line("Mystery bar")];
const PEANUT: RuleMark = { verdict: "blocked", reason: "Peanut butter has peanut, which your rules exclude." };
const UNCHECKED: RuleMark = { verdict: "unknown",
  reason: "Mystery bar is not in your foods, so it cannot be checked against your rules." };

function sheet(ruleMarks?: (RuleMark | null)[], replaced?: Macros) {
  render(<EditSlotSheet open label="Meal 1" planned={planned} override={undefined} target={undefined}
    foods={{}} ruleMarks={ruleMarks} replaced={replaced} onSave={vi.fn()} onClose={vi.fn()} />);
}

afterEach(cleanup);

describe("EditSlotSheet rule marks", () => {
  it("marks each line with its own entry and describes its change button by it", () => {
    sheet([null, PEANUT, UNCHECKED]);
    const peanut = screen.getByRole("button", { name: "Change Peanut butter" });
    expect(peanut.querySelector("[data-rule-mark]")?.getAttribute("data-rule-mark")).toBe("blocked");
    expect(document.getElementById(peanut.getAttribute("aria-describedby")!)?.textContent)
      .toContain(PEANUT.reason);
    const mystery = screen.getByRole("button", { name: "Change Mystery bar" });
    expect(mystery.querySelector("[data-rule-mark]")?.textContent).toContain("Check");
    const toast = screen.getByRole("button", { name: "Change Toast" });
    expect(toast.querySelector("[data-rule-mark]")).toBeNull();
    expect(toast.hasAttribute("aria-describedby")).toBe(false);
  });

  it("keeps a line's mark by name when another line is stepped off", () => {
    sheet([null, PEANUT, UNCHECKED]);
    fireEvent.click(screen.getByRole("button", { name: "Take Toast off" }));
    expect(screen.queryByRole("button", { name: "Change Toast" })).toBeNull();
    expect(screen.getByRole("button", { name: "Change Peanut butter" })
      .querySelector("[data-rule-mark]")?.getAttribute("data-rule-mark")).toBe("blocked");
  });

  it("says nothing without marks, and nothing on an eaten slot", () => {
    sheet(undefined);
    expect(document.querySelector("[data-rule-mark]")).toBeNull();
    cleanup();
    sheet([null, PEANUT, UNCHECKED], { kcal: 300, protein: 15, carbs: 30, fat: 9 });
    expect(document.querySelector("[data-rule-mark]")).toBeNull();
  });
});
