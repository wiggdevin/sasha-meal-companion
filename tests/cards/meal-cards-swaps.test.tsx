// @vitest-environment jsdom
/** UI audit 2026-10-18 §7 (meal cards and swaps): the fixes, held. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import SlotCard from "@/components/SlotCard";
import SwapSheet from "@/components/SwapSheet";
import { RESCHEDULE_ERROR_MS } from "@/components/useMealReschedule";
import type { Meal, ResolvedSlot } from "@/lib/types";

const MEAL: Meal = {
  id: "meal:oats", name: "Oats and berries", slot: "meal-1",
  components: [{ name: "Oats", qty: 80, unit: "g", role: "carb",
    macros: { kcal: 300, protein: 10, carbs: 54, fat: 6 } }],
  macros: { kcal: 300, protein: 10, carbs: 54, fat: 6 }, prepMinutes: 5, tags: [],
};
const SLOT: ResolvedSlot = {
  slot: "meal-1", time: "08:00", label: "Breakfast", meal: MEAL, components: MEAL.components,
  macros: MEAL.macros, eaten: false,
};

afterEach(() => { cleanup(); vi.useRealTimers(); });

function swipeRight(card: HTMLElement) {
  fireEvent.pointerDown(card, { pointerType: "mouse", button: 0, clientX: 10, clientY: 300 });
  fireEvent.pointerMove(document, { pointerType: "mouse", clientX: 110, clientY: 302 });
  fireEvent.pointerUp(document, { pointerType: "mouse" });
}

describe("meal card swipe", () => {
  it("opens Swap on a right swipe of a planned meal", () => {
    const onOpenSwap = vi.fn();
    const { container } = render(<SlotCard slot={SLOT} variant="focus" canSwap
      onToggleEaten={() => {}} onOpenSwap={onOpenSwap} />);
    swipeRight(container.querySelector("[data-meal-card]") as HTMLElement);
    expect(onOpenSwap).toHaveBeenCalledTimes(1);
  });

  it("never opens Swap from an eaten meal, whose Swap control is hidden too", () => {
    const onOpenSwap = vi.fn();
    const { container } = render(<SlotCard slot={{ ...SLOT, eaten: true }} variant="focus" canSwap
      onToggleEaten={() => {}} onOpenSwap={onOpenSwap} />);
    swipeRight(container.querySelector("[data-meal-card]") as HTMLElement);
    expect(onOpenSwap).not.toHaveBeenCalled();
  });
});

describe("text fields inside a meal card", () => {
  it("keep their long-press menu; the card's own surface does not", () => {
    const { container } = render(<SlotCard slot={SLOT} variant="focus" canSwap
      onToggleEaten={() => {}} onOpenSwap={() => {}} onTimeChange={() => {}}
      attachment={<input aria-label="Search" />} />);
    const field = screen.getByLabelText("Search");
    const onField = new Event("contextmenu", { bubbles: true, cancelable: true });
    field.dispatchEvent(onField);
    expect(onField.defaultPrevented).toBe(false);
    const card = container.querySelector("[data-meal-card]") as HTMLElement;
    const onCard = new Event("contextmenu", { bubbles: true, cancelable: true });
    card.dispatchEvent(onCard);
    expect(onCard.defaultPrevented).toBe(true);
  });
});

describe("a refused reschedule", () => {
  it("shows its alert, then clears it on its own", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { container } = render(<SlotCard slot={SLOT} variant="focus" canSwap
      onToggleEaten={() => {}} onOpenSwap={() => {}}
      onTimeChange={() => Promise.reject(new Error("offline"))} />);
    const card = container.querySelector("[data-meal-card]") as HTMLElement;
    fireEvent.pointerDown(card, { pointerType: "mouse", button: 0, clientX: 10, clientY: 300 });
    act(() => { vi.advanceTimersByTime(500); });
    fireEvent.pointerMove(document, { pointerType: "mouse", clientX: 10, clientY: 400 });
    await act(async () => { fireEvent.pointerUp(document, { pointerType: "mouse" }); });
    expect(screen.getByRole("alert").textContent).toContain("Time could not be saved");
    act(() => { vi.advanceTimersByTime(RESCHEDULE_ERROR_MS); });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("the ingredient draft", () => {
  it("survives a collapse, and the folded card shows the saved calories", async () => {
    const onSave = vi.fn();
    const { container } = render(<SlotCard slot={SLOT} variant="focus" canSwap
      onToggleEaten={() => {}} onOpenSwap={() => {}} foods={{}} onSaveComponents={onSave} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Expand Breakfast" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Increase Oats" })); });
    expect(screen.getByRole("button", { name: "Save ingredients" })).toBeTruthy();
    const figures = () => container.querySelector("[data-meal-figures]")!.textContent ?? "";
    expect(figures()).not.toContain("300");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Collapse Breakfast" })); });
    expect(figures()).toContain("300");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Expand Breakfast" })); });
    expect(screen.getByRole("button", { name: "Save ingredients" })).toBeTruthy();
    expect(figures()).not.toContain("300");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Discard" })); });
    expect(screen.queryByRole("button", { name: "Save ingredients" })).toBeNull();
    expect(figures()).toContain("300");
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe("SwapSheet's Today's pick", () => {
  it("names the rotation meal once, with its figures", () => {
    const markup = renderToStaticMarkup(<SwapSheet slot="meal-1" options={[MEAL]} currentMealId={MEAL.id}
      isDefaultPick onSelect={() => {}} onUseRotation={() => {}} onClose={() => {}} />);
    expect(markup).toContain("Today&#x27;s pick: Oats and berries");
    expect(markup.split("Oats and berries").length - 1).toBe(1);
  });
});
