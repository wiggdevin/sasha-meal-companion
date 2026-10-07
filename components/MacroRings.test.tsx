// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import MacroRings, { LEFT_DIALS, RIGHT_DIALS } from "./MacroRings";
import { MAX_CUPS, PX_PER_CUP } from "@/lib/today/water-gesture";
import type { Macros } from "@/lib/types";

// Production smoke for the Today screen ("gauges render for calories, protein,
// carbs, fat") could not run past the sign-in wall (docs/audit/2026-09-13),
// leaving MacroRings — unlike every other layer behind Today (lib/resolve.ts,
// lib/store.ts, lib/gauge.ts, SlotCard.tsx) — as the one piece with no test at
// all. This closes that gap so the four gauges are checked without a browser.

const targets: Macros = { kcal: 2000, protein: 150, carbs: 200, fat: 70 };

describe("MacroRings", () => {
  it("needs profile: shows profile setup instead of gauges when targets are missing", () => {
    const consumed: Macros = { kcal: 500, protein: 20, carbs: 70, fat: 10 };
    const markup = renderToStaticMarkup(<MacroRings targets={null} consumed={consumed} />);
    expect(markup).toContain("Finish your profile");
    expect(markup).toContain("Add your details to get daily targets.");
    expect(markup).not.toContain('aria-label="Calories:');
  });

  it("is drawing: renders a gauge for calories, protein, carbs and fat with consumed/target"
    + " values", () => {
    const consumed: Macros = { kcal: 1200, protein: 90, carbs: 80, fat: 30 };
    const markup = renderToStaticMarkup(<MacroRings targets={targets} consumed={consumed} />);

    expect(markup).toContain('aria-label="Calories: 1,200 of 2,000 kcal"');
    expect(markup).toContain('aria-label="Protein: 90 of 150 g"');
    expect(markup).toContain('aria-label="Carbs: 80 of 200 g"');
    expect(markup).toContain('aria-label="Fat: 30 of 70 g"');
  });

  it("shows what is left to eat when calories or protein are not yet met", () => {
    const consumed: Macros = { kcal: 1200, protein: 90, carbs: 80, fat: 30 };
    const markup = renderToStaticMarkup(<MacroRings targets={targets} consumed={consumed} />);

    expect(markup).toContain('<span aria-hidden="true" class="font-semibold kcal">800</span>');
    expect(markup).toContain("800 calories");
    expect(markup).toContain("60 grams protein");
    expect(markup).not.toContain("Calories and protein done for today.");
  });

  it("shows the done message once calories and protein targets are met", () => {
    const consumed: Macros = { kcal: 2000, protein: 150, carbs: 150, fat: 60 };
    const markup = renderToStaticMarkup(<MacroRings targets={targets} consumed={consumed} />);

    expect(markup).toContain("Calories and protein done for today.");
  });

  it("draws a capped red excess lap with its own end dot and spoken overage", () => {
    const consumed: Macros = { kcal: 2500, protein: 150, carbs: 200, fat: 120 };
    const markup = renderToStaticMarkup(<MacroRings targets={targets} consumed={consumed} />);

    expect(markup).toContain('aria-label="Calories: 2,500 of 2,000 kcal, 500 kcal over"');
    expect(markup).toContain('aria-label="Fat: 120 of 70 g, 50 g over"');
    expect(markup).toContain("Fat 50 g over");
    expect(markup).toContain('data-excess-arc="fat"');
    expect(markup).toContain('data-excess-dot="fat"');
    expect(markup).toContain('stroke="var(--color-alert)"');
  });

  // FluidVoice T02 (2026-09-28): carbs over water on the left, protein over fat on the right.
  // Water on the left leaves the whole card to its right for one long drag.
  it("puts carbs and water on the left, protein and fat on the right", () => {
    expect(LEFT_DIALS.map((spec) => spec.key)).toEqual(["carbs", "water"]);
    expect(RIGHT_DIALS.map((spec) => spec.key)).toEqual(["protein", "fat"]);
  });

  it("renders the dials left column, calories, right column", () => {
    const consumed: Macros = { kcal: 1200, protein: 90, carbs: 80, fat: 30 };
    const markup = renderToStaticMarkup(<MacroRings targets={targets} consumed={consumed} />);
    const at = (label: string) => markup.indexOf(`aria-label="${label}:`);

    expect(at("Carbs")).toBeLessThan(at("Water"));
    expect(at("Water")).toBeLessThan(at("Calories"));
    expect(at("Calories")).toBeLessThan(at("Protein"));
    expect(at("Protein")).toBeLessThan(at("Fat"));
  });

  it("draws no tick marks and no guide ring on any dial", () => {
    const consumed: Macros = { kcal: 1200, protein: 90, carbs: 80, fat: 30 };
    const markup = renderToStaticMarkup(<MacroRings targets={targets} consumed={consumed} />);

    // `<line ` with the space: the `<linearGradient` defs do not match.
    expect(markup).not.toContain("<line ");
    expect(markup).not.toContain("stroke-dasharray=\"3 6\"");
  });
});

// T8 §1 chose one footer line for water (D3). The balanced layout supersedes it:
// water is the fifth dial, under carbs on the right, so the count logged from the FAB still
// shows on Today — now in the same form as the macros.
describe("MacroRings · the water dial", () => {
  const consumed: Macros = { kcal: 1200, protein: 90, carbs: 80, fat: 30 };
  const render = (water?: { cups: number; goal: number }) =>
    renderToStaticMarkup(<MacroRings targets={targets} consumed={consumed} water={water} />);

  it("reads the cups against the viewed day's goal", () => {
    expect(render({ cups: 3, goal: 10 })).toContain('aria-label="Water: 3 of 10 cups"');
  });

  it("shows a day with no water_log row as zero, never an empty dial", () => {
    expect(render({ cups: 0, goal: 10 })).toContain('aria-label="Water: 0 of 10 cups"');
  });

  it("shows zero with no target while the day has not been read yet", () => {
    const markup = render();
    expect(markup).toContain('aria-label="Water: 0 cups"');
    expect(markup).not.toContain("of 0");
  });

  it("is the one water element: no footer line, no meter, no stepper", () => {
    const markup = render({ cups: 3, goal: 10 });
    expect(markup.match(/Water/g)).toHaveLength(2); // the aria-label and the dial's eyebrow
    expect(markup).not.toContain("Water 3 of 10 cups");
    expect(markup).not.toContain("progressbar");
    expect(markup).not.toContain("Add a cup");
    expect(markup.match(/role="status"/g)).toHaveLength(1);
  });
});

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("MacroRings · water drag and step parity", () => {
  const consumed: Macros = { kcal: 1200, protein: 90, carbs: 80, fat: 30 };
  const renderWater = (cups: number, onSetCups = vi.fn()) => {
    const utils = render(<MacroRings targets={targets} consumed={consumed}
      water={{ cups, goal: 10 }} onAddCup={vi.fn()} onSetCups={onSetCups} />);
    return { ...utils, onSetCups };
  };

  it("the drag and the plus step both stop at the same bounded cup value", () => {
    vi.useFakeTimers();
    const dragged = renderWater(MAX_CUPS - 1);
    const dial = screen.getByRole("button", { name: /^Water: / });
    fireEvent.pointerDown(dial, { pointerType: "mouse", button: 0, clientX: 40 });
    act(() => { vi.advanceTimersByTime(450); });
    fireEvent.pointerMove(dial, { pointerType: "mouse", clientX: 40 + PX_PER_CUP * 5 });
    fireEvent.pointerUp(dial, { pointerType: "mouse", clientX: 40 + PX_PER_CUP * 5 });
    expect(dragged.onSetCups).toHaveBeenLastCalledWith(MAX_CUPS);
    dragged.unmount();

    const stepped = renderWater(MAX_CUPS - 1);
    fireEvent.click(screen.getByRole("button", { name: "One more cup of water" }));
    expect(stepped.onSetCups).toHaveBeenLastCalledWith(MAX_CUPS);
    stepped.rerender(<MacroRings targets={targets} consumed={consumed}
      water={{ cups: MAX_CUPS, goal: 10 }} onAddCup={vi.fn()} onSetCups={stepped.onSetCups} />);
    expect((screen.getByRole("button", { name: "One more cup of water" }) as HTMLButtonElement).disabled)
      .toBe(true);
  });

  it("the drag and the minus step both stop at zero", () => {
    vi.useFakeTimers();
    const dragged = renderWater(1);
    const dial = screen.getByRole("button", { name: /^Water: / });
    fireEvent.pointerDown(dial, { pointerType: "mouse", button: 0, clientX: 200 });
    act(() => { vi.advanceTimersByTime(450); });
    fireEvent.pointerMove(dial, { pointerType: "mouse", clientX: 200 - PX_PER_CUP * 4 });
    fireEvent.pointerUp(dial, { pointerType: "mouse", clientX: 200 - PX_PER_CUP * 4 });
    expect(dragged.onSetCups).toHaveBeenLastCalledWith(0);
    dragged.unmount();

    const stepped = renderWater(1);
    fireEvent.click(screen.getByRole("button", { name: "One less cup of water" }));
    expect(stepped.onSetCups).toHaveBeenLastCalledWith(0);
  });
});

describe("MacroRings · macro detail disclosure", () => {
  const consumed: Macros = { kcal: 1200, protein: 90, carbs: 80, fat: 30 };
  const DIVIDER = "mt-3 border-t border-hairline pt-3";

  it("begins expanded and toggles with its button, keeping the short divider", () => {
    const { container } = render(<MacroRings targets={targets} consumed={consumed} />);
    const toggle = screen.getByRole("button", { name: "Macro detail" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("img", { name: /^Protein: / })).toBeTruthy();
    expect(container.innerHTML).toContain(DIVIDER);

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("img", { name: /^Protein: / })).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("800 calories");
    expect(container.innerHTML).toContain(DIVIDER);

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("img", { name: /^Protein: / })).toBeTruthy();
  });

  it("toggles on a long hold of the Still to eat region, never on a short press", () => {
    vi.useFakeTimers();
    const { container } = render(<MacroRings targets={targets} consumed={consumed} />);
    const toggle = screen.getByRole("button", { name: "Macro detail" });
    const region = container.querySelector("[data-macro-summary]") as HTMLElement;

    fireEvent.pointerDown(region, { pointerType: "touch", clientX: 10, clientY: 10 });
    act(() => { vi.advanceTimersByTime(200); });
    fireEvent.pointerUp(region, { pointerType: "touch" });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    fireEvent.pointerDown(region, { pointerType: "touch", clientX: 10, clientY: 10 });
    act(() => { vi.advanceTimersByTime(450); });
    fireEvent.pointerUp(region, { pointerType: "touch" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.innerHTML).toContain(DIVIDER);
  });

  it("keeps water logging and its steps reachable while the detail is collapsed", () => {
    const onSetCups = vi.fn();
    render(<MacroRings targets={targets} consumed={consumed} water={{ cups: 3, goal: 10 }}
      onAddCup={vi.fn()} onSetCups={onSetCups} />);
    fireEvent.click(screen.getByRole("button", { name: "Macro detail" }));
    expect(screen.queryByRole("img", { name: /^Calories: / })).toBeNull();
    const water = screen.getByRole("group", { name: "Water" });
    expect(water.textContent).toContain("3 of 10 cups");
    fireEvent.click(screen.getByRole("button", { name: "One more cup of water" }));
    expect(onSetCups).toHaveBeenLastCalledWith(4);
    fireEvent.click(screen.getByRole("button", { name: "One less cup of water" }));
    expect(onSetCups).toHaveBeenLastCalledWith(2);
  });

  it("reads water in the account's unit on the dial, the folded line and the steps (audit b4b #5)", () => {
    const onSetCups = vi.fn();
    render(<MacroRings targets={targets} consumed={consumed} water={{ cups: 3, goal: 10, unit: "oz" }}
      onAddCup={vi.fn()} onSetCups={onSetCups} />);
    expect(screen.getByRole("img", { name: "Water: 24 of 80 oz" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Water: 24 of 80 oz\. Tap adds 8 oz/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Macro detail" }));
    expect(screen.getByRole("group", { name: "Water" }).textContent).toContain("24 of 80 oz");
    expect(screen.queryByText(/cups/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "8 oz more water" }));
    expect(onSetCups).toHaveBeenLastCalledWith(4);
    fireEvent.click(screen.getByRole("button", { name: "8 oz less water" }));
    expect(onSetCups).toHaveBeenLastCalledWith(2);
  });

  it("draws three chevrons that point toward the destination", () => {
    const { container } = render(<MacroRings targets={targets} consumed={consumed} />);
    const chevrons = () => container.querySelector("[data-chevrons]") as HTMLElement;
    expect(chevrons().querySelectorAll("[data-chevron]")).toHaveLength(3);
    expect(chevrons().getAttribute("data-chevrons")).toBe("up");
    fireEvent.click(screen.getByRole("button", { name: "Macro detail" }));
    expect(chevrons().getAttribute("data-chevrons")).toBe("down");
  });
});
