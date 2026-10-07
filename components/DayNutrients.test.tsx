// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import DayNutrients from "./DayNutrients";
import { todayDismissalKey } from "@/lib/today/presentation";
import type { LoggedFood, ResolvedDay } from "@/lib/types";

const fibre = { amount: 6, unit: "g", basis: "per_100g" as const, source: "test",
  source_version: "1", revision_id: null };

function dayFor(date: string): ResolvedDay {
  const entry: LoggedFood = {
    id: "e1", foodId: "oats", name: "Oats", portionLabel: "1 cup", qty: 1, grams: 80,
    macros: { kcal: 300, protein: 10, carbs: 54, fat: 5 }, at: `${date}T08:00:00.000Z`,
    items: [{ id: "i1", seq: 0, food_ref_id: "ref", grams: 80, qty: 1, unit: "cup",
      snapshot: { fiber_total: fibre }, foodId: "oats", name: "Oats", portionLabel: "1 cup",
      macros: { kcal: 300, protein: 10, carbs: 54, fat: 5 } }],
  };
  return { date, dayType: "rest", isFloorDay: false, targets: null, slots: [], extras: [entry],
    consumed: entry.macros, waterCups: 0 };
}

const CARD = { name: "Nutrients today" };
const CLEAR = { name: "Clear the nutrients card for this day" };

beforeEach(() => { sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("DayNutrients · daily card dismissal", () => {
  it("exposes a named, visible Clear action", () => {
    render(<DayNutrients day={dayFor("2026-09-28")} accountId="user-a" />);
    expect(screen.getByRole("region", CARD)).toBeTruthy();
    const clear = screen.getByRole("button", CLEAR);
    expect(clear.textContent).toContain("Clear");
    fireEvent.click(clear);
    expect(screen.queryByRole("region", CARD)).toBeNull();
    expect(sessionStorage.getItem(todayDismissalKey("user-a", "2026-09-28", "nutrients"))).toBe("1");
  });

  it("stays dismissed on a same-date remount and returns for another date or account", () => {
    const first = render(<DayNutrients day={dayFor("2026-09-28")} accountId="user-a" />);
    fireEvent.click(screen.getByRole("button", CLEAR));
    first.unmount();

    const again = render(<DayNutrients day={dayFor("2026-09-28")} accountId="user-a" />);
    expect(screen.queryByRole("region", CARD)).toBeNull();
    again.rerender(<DayNutrients day={dayFor("2026-09-29")} accountId="user-a" />);
    expect(screen.getByRole("region", CARD)).toBeTruthy();
    again.rerender(<DayNutrients day={dayFor("2026-09-28")} accountId="user-b" />);
    expect(screen.getByRole("region", CARD)).toBeTruthy();
    again.rerender(<DayNutrients day={dayFor("2026-09-28")} accountId="user-a" />);
    expect(screen.queryByRole("region", CARD)).toBeNull();
  });

  it("remains usable when sessionStorage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    render(<DayNutrients day={dayFor("2026-09-28")} accountId="user-a" />);
    expect(screen.getByRole("region", CARD)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", CLEAR));
    expect(screen.queryByRole("region", CARD)).toBeNull();
  });

  it("reveals Clear on a partial left swipe, dismisses on a full one, and restores a cancelled one", () => {
    const { container } = render(<DayNutrients day={dayFor("2026-09-28")} accountId="user-a" />);
    const card = () => container.querySelector("[data-swipe-card]") as HTMLElement;

    fireEvent.pointerDown(card(), { pointerType: "touch", clientX: 300, clientY: 100 });
    fireEvent.pointerMove(card(), { pointerType: "touch", clientX: 200, clientY: 190 });
    fireEvent.pointerUp(card(), { pointerType: "touch", clientX: 200, clientY: 190 });
    expect(card().getAttribute("data-swipe")).toBe("rest");
    expect(card().style.translate).toBe("0px 0");

    fireEvent.pointerDown(card(), { pointerType: "touch", clientX: 300, clientY: 100 });
    fireEvent.pointerMove(card(), { pointerType: "touch", clientX: 220, clientY: 104 });
    fireEvent.pointerUp(card(), { pointerType: "touch", clientX: 220, clientY: 104 });
    expect(card().getAttribute("data-swipe")).toBe("revealed");
    expect(screen.getByRole("region", CARD)).toBeTruthy();

    fireEvent.pointerDown(card(), { pointerType: "touch", clientX: 300, clientY: 100 });
    fireEvent.pointerCancel(card(), { pointerType: "touch" });
    expect(card().getAttribute("data-swipe")).toBe("revealed");

    fireEvent.pointerDown(card(), { pointerType: "touch", clientX: 300, clientY: 100 });
    fireEvent.pointerMove(card(), { pointerType: "touch", clientX: 60, clientY: 110 });
    fireEvent.pointerUp(card(), { pointerType: "touch", clientX: 60, clientY: 110 });
    expect(screen.queryByRole("region", CARD)).toBeNull();
  });

  it("leaves pointer presses that start on its buttons to those buttons", () => {
    const capture = vi.fn();
    Object.defineProperty(Element.prototype, "setPointerCapture", { value: capture, configurable: true });
    try {
      const { container } = render(<DayNutrients day={dayFor("2026-09-28")} accountId="user-a" />);
      const card = container.querySelector("[data-swipe-card]") as HTMLElement;
      for (const button of [screen.getByRole("button", CLEAR),
        screen.getByRole("button", { name: /nutrients have data today/ })]) {
        fireEvent.pointerDown(button, { pointerType: "touch", pointerId: 7, clientX: 300, clientY: 100 });
        fireEvent.pointerMove(button, { pointerType: "touch", pointerId: 7, clientX: 60, clientY: 102 });
        fireEvent.pointerUp(button, { pointerType: "touch", pointerId: 7, clientX: 60, clientY: 102 });
        expect(capture).not.toHaveBeenCalled();
        expect(card.getAttribute("data-swipe")).toBe("rest");
        expect(screen.getByRole("region", CARD)).toBeTruthy();
      }
      fireEvent.click(screen.getByRole("button", CLEAR));
      expect(screen.queryByRole("region", CARD)).toBeNull();
    } finally {
      delete (Element.prototype as { setPointerCapture?: unknown }).setPointerCapture;
    }
  });

  it("captures the pointer only once a horizontal swipe is established", () => {
    const capture = vi.fn();
    Object.defineProperty(Element.prototype, "setPointerCapture", { value: capture, configurable: true });
    try {
      const { container } = render(<DayNutrients day={dayFor("2026-09-28")} accountId="user-a" />);
      const card = container.querySelector("[data-swipe-card]") as HTMLElement;
      const text = screen.getByText(/g band|No fibre logged yet/);
      fireEvent.pointerDown(text, { pointerType: "touch", pointerId: 3, clientX: 300, clientY: 100 });
      expect(capture).not.toHaveBeenCalled();
      fireEvent.pointerMove(card, { pointerType: "touch", pointerId: 3, clientX: 298, clientY: 130 });
      expect(capture).not.toHaveBeenCalled();
      fireEvent.pointerMove(card, { pointerType: "touch", pointerId: 3, clientX: 220, clientY: 104 });
      expect(capture).toHaveBeenCalledOnce();
      expect(capture).toHaveBeenCalledWith(3);
    } finally {
      delete (Element.prototype as { setPointerCapture?: unknown }).setPointerCapture;
    }
  });

  it("never swallows a keyboard activation after a swipe", () => {
    const { container } = render(<DayNutrients day={dayFor("2026-09-28")} accountId="user-a" />);
    const card = container.querySelector("[data-swipe-card]") as HTMLElement;
    fireEvent.pointerDown(card, { pointerType: "touch", clientX: 300, clientY: 100 });
    fireEvent.pointerMove(card, { pointerType: "touch", clientX: 280, clientY: 100 });
    fireEvent.pointerUp(card, { pointerType: "touch", clientX: 280, clientY: 100 });
    const list = screen.getByRole("button", { name: /nutrients have data today/ });
    fireEvent.click(list, { detail: 0 });
    expect(list.getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps a dismissal in memory only when no account is bound", () => {
    render(<DayNutrients day={dayFor("2026-09-28")} accountId={null} />);
    fireEvent.click(screen.getByRole("button", CLEAR));
    expect(screen.queryByRole("region", CARD)).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });
});

describe("DayNutrients · the micronutrient disclosure", () => {
  it("points aria-controls only at a panel that is in the document (audit b4b #9)", () => {
    render(<DayNutrients day={dayFor("2026-09-28")} accountId="user-a" />);
    const toggle = screen.getByRole("button", { name: /nutrients have data today/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.hasAttribute("aria-controls")).toBe(false);
    fireEvent.click(toggle);
    const id = toggle.getAttribute("aria-controls");
    expect(id).toBeTruthy();
    expect(document.getElementById(id!)).not.toBeNull();
  });
});
