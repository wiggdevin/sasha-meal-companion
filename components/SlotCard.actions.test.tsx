// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MotionConfig } from "motion/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SlotCard from "./SlotCard";
import Sheet from "./Sheet";
import { LoggedExtraCard } from "./LoggedExtras";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { TEST_USER } from "@/tests/helpers/account";
import { feedbackStateProps } from "@/components/ui/ActionFeedback";
import { leftSwipeOutcome } from "./useMealReschedule";
import type { FoodComponent, ResolvedSlot } from "@/lib/types";

const slot: ResolvedSlot = { slot: "meal-1", label: "Meal 1", time: "12:30",
  meal: { id: "mine", slot: "meal-1", name: "Rice bowl", components: [],
    macros: { kcal: 0, protein: 0, carbs: 0, fat: 0 }, prepMinutes: 0, tags: [] },
  components: [], macros: { kcal: 0, protein: 0, carbs: 0, fat: 0 }, eaten: false };

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("SlotCard actions", () => {
  it("reveals Clear, then Delete, with a hard-swipe threshold relative to card width", () => {
    expect(leftSwipeOutcome(39, 300)).toBe("none");
    expect(leftSwipeOutcome(64, 300)).toBe("clear");
    expect(leftSwipeOutcome(150, 300)).toBe("actions");
    // Both catches hold the card, so only a pull well past the second deletes.
    expect(leftSwipeOutcome(240, 300)).toBe("actions");
    expect(leftSwipeOutcome(262, 300)).toBe("delete");
    expect(leftSwipeOutcome(300, 480)).toBe("delete");
  });

  it("keeps destructive actions off the card face until a swipe reveals them", () => {
    const onClear = vi.fn();
    const onDelete = vi.fn();
    const props = { variant: "standard" as const, canSwap: false,
      onToggleEaten: vi.fn(), onOpenSwap: vi.fn(), onClear, onDelete };
    const { container } = render(<SlotCard slot={slot} {...props} />);
    // The keyboard path stays off the visual surface until it takes focus.
    expect(screen.getByRole("button", { name: "More for Meal 1" }).className).toContain("sr-only");
    const card = container.querySelector("[data-meal-card]") as HTMLElement;
    Object.defineProperty(card, "getBoundingClientRect", { value: () => ({ width: 300 }) });
    fireEvent.pointerDown(card, { pointerType: "mouse", button: 0, clientX: 260, clientY: 80 });
    fireEvent.pointerMove(document, { pointerType: "mouse", clientX: 100, clientY: 80 });
    fireEvent.pointerUp(document, { pointerType: "mouse" });
    fireEvent.click(screen.getByRole("button", { name: "Clear Meal 1" }));
    expect(onClear).toHaveBeenCalledOnce();
  });

  it("keeps revealed actions open after a partial left swipe and deletes on a full swipe", () => {
    const onDelete = vi.fn();
    const { container } = render(<SlotCard slot={slot} variant="standard"
      canSwap={false} onToggleEaten={() => {}} onOpenSwap={() => {}}
      onClear={() => {}} onDelete={onDelete} />);
    const card = container.querySelector("[data-meal-card]") as HTMLElement;
    Object.defineProperty(card, "getBoundingClientRect", { value: () => ({ width: 300 }) });
    fireEvent.pointerDown(card, { pointerType: "mouse", button: 0, clientX: 260, clientY: 80 });
    fireEvent.pointerMove(document, { pointerType: "mouse", clientX: 100, clientY: 80 });
    fireEvent.pointerUp(document, { pointerType: "mouse" });
    expect(screen.getByRole("button", { name: "Delete Meal 1" }).tabIndex).toBe(0);
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.pointerDown(card, { pointerType: "mouse", button: 0, clientX: 295, clientY: 80 });
    fireEvent.pointerMove(document, { pointerType: "mouse", clientX: -5, clientY: 80 });
    fireEvent.pointerUp(document, { pointerType: "mouse" });
    expect(onDelete).toHaveBeenCalledOnce();
  });

  it("offers keyboard-accessible Clear and Delete through a focus-only More control", async () => {
    const onClear = vi.fn();
    const onDelete = vi.fn();
    render(<SlotCard slot={slot} variant="standard" canSwap={false}
      onToggleEaten={() => {}} onOpenSwap={() => {}} onClear={onClear} onDelete={onDelete} />);
    expect(screen.getByRole("button", { name: "Clear Meal 1", hidden: true }).tabIndex).toBe(-1);
    const more = screen.getByRole("button", { name: "More for Meal 1" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    const clear = screen.getByRole("button", { name: "Clear Meal 1" });
    await waitFor(() => expect(document.activeElement).toBe(clear));
    expect(screen.getByRole("button", { name: "Delete Meal 1" }).tabIndex).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Delete Meal 1" }));
    expect(onDelete).toHaveBeenCalledOnce();
    // Delete closed the actions; More opens them again, and a second press closes them.
    fireEvent.click(more);
    fireEvent.click(more);
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    fireEvent.click(screen.getByRole("button", { name: "Clear Meal 1" }));
    expect(onClear).toHaveBeenCalledOnce();
  });

  it("does not offer Clear or Delete for an eaten meal, including a full swipe", () => {
    const onDelete = vi.fn();
    const { container } = render(<SlotCard slot={{ ...slot, eaten: true }} variant="standard"
      canSwap={false} onToggleEaten={() => {}} onOpenSwap={() => {}}
      onClear={() => {}} onDelete={onDelete} />);
    expect(screen.queryByRole("button", { name: "More for Meal 1" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Clear Meal 1" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete Meal 1" })).toBeNull();
    const card = container.querySelector("[data-meal-card]") as HTMLElement;
    Object.defineProperty(card, "getBoundingClientRect", { value: () => ({ width: 300 }) });
    fireEvent.pointerDown(card, { pointerType: "mouse", button: 0, clientX: 295, clientY: 80 });
    fireEvent.pointerMove(document, { pointerType: "mouse", clientX: -5, clientY: 80 });
    fireEvent.pointerUp(document, { pointerType: "mouse" });
    expect(onDelete).not.toHaveBeenCalled();
  });
});

/**
 * FluidVoice F01-F09: Today owns the eaten and meal-edit writes, and hands this card the shared
 * ActionFeedback state for its own slot only. The eaten control shows pending/success on the
 * control that was pressed; a meal edit marks the card changed (violet) for its four seconds.
 */
describe("SlotCard feedback", () => {
  const base = { variant: "standard" as const, canSwap: false,
    onToggleEaten: vi.fn(), onOpenSwap: vi.fn() };

  it("puts the page's eaten state on the eaten control, pending as busy and disabled", () => {
    const { rerender } = render(<SlotCard slot={slot} {...base} eatenFeedback="pending" />);
    const tick = screen.getByRole("button", { name: "Mark eaten, Meal 1" }) as HTMLButtonElement;
    expect(tick.getAttribute("data-feedback-state")).toBe("pending");
    expect(tick.getAttribute("aria-busy")).toBe("true");
    expect(tick.getAttribute("aria-disabled")).toBe("true");
    rerender(<SlotCard slot={{ ...slot, eaten: true }} {...base} eatenFeedback="success" />);
    const done = screen.getByRole("button", { name: "Eaten, Meal 1. Undo" });
    expect(done.getAttribute("data-feedback-state")).toBe("success");
    expect(done.getAttribute("data-eaten")).toBe("true");
  });

  it("uses the same compact eaten control for a focus card", () => {
    const { rerender } = render(<SlotCard slot={slot} {...base} variant="focus" eatenFeedback="success" />);
    expect(screen.getByRole("button", { name: "Mark eaten, Meal 1" }).getAttribute("data-feedback-state")).toBe("success");
    expect(screen.queryByRole("button", { name: "Eaten" })).toBeNull();
    rerender(<SlotCard slot={slot} {...base} variant="focus" />);
    expect(screen.getByRole("button", { name: "Mark eaten, Meal 1" }).hasAttribute("data-feedback-state")).toBe(false);
  });

  it("marks the card changed after a meal edit", () => {
    const { container } = render(<SlotCard slot={slot} {...base} mealFeedback="changed" />);
    const card = container.querySelector("[data-meal-card]") as HTMLElement;
    expect(card.getAttribute("data-feedback-state")).toBe("changed");
    // The shared `.control[data-feedback-state]` selectors only colour a card carrying the class.
    expect(card.classList.contains(feedbackStateProps(undefined).className)).toBe(true);
  });
});

describe("SlotCard compact detail", () => {
  const detailed: ResolvedSlot = { slot: "meal-1", label: "Meal 1", time: "12:30",
    meal: { id: "mine", slot: "meal-1", name: "Rice bowl", components: [],
      macros: { kcal: 610, protein: 53, carbs: 79, fat: 6 }, prepMinutes: 0, tags: [] },
    components: [
      { name: "Chicken breast", qty: 150, unit: "g", role: "protein",
        macros: { kcal: 248, protein: 46, carbs: 0, fat: 5 } },
      { name: "Rice", qty: 1.5, unit: "cup", role: "carb",
        macros: { kcal: 362, protein: 7, carbs: 79, fat: 1 } },
    ],
    macros: { kcal: 610, protein: 53, carbs: 79, fat: 6 }, eaten: false };

  function renderDetailed(extra: Record<string, unknown> = {}) {
    const callbacks = { onToggleEaten: vi.fn(), onOpenSwap: vi.fn(), onOpenEdit: vi.fn(),
      onTimeChange: vi.fn(), onClear: vi.fn(), onDelete: vi.fn() };
    const utils = render(<SlotCard slot={detailed} variant="standard" canSwap
      {...callbacks} {...extra} />);
    const mutations = [callbacks.onToggleEaten, callbacks.onOpenSwap, callbacks.onTimeChange,
      callbacks.onClear, callbacks.onDelete];
    return { ...utils, callbacks, mutations };
  }

  it("a tap on the card opens its detail in place and never opens an edit sheet", () => {
    const { callbacks, container } = renderDetailed();
    const surface = container.querySelector("[data-card-edit]") as HTMLElement;
    fireEvent.click(surface, { detail: 1 });
    expect(screen.getByRole("region", { name: "Meal 1 details" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Ask .* about Meal 1$/ })).toBeTruthy();
    fireEvent.click(surface, { detail: 1 });
    expect(screen.queryByRole("region", { name: "Meal 1 details" })).toBeNull();
    // Folding away, the card's actions are already out of reach, not merely fading.
    expect(screen.queryByRole("button", { name: /^Ask .* about Meal 1$/ })).toBeNull();
    expect(callbacks.onOpenEdit).not.toHaveBeenCalled();
  });

  it("renders a flow the card started inside the card's own tray, never as a modal or a second card", () => {
    const onClose = vi.fn();
    const { container } = renderDetailed({ attachment: <Sheet title="Plan Meal 1" onClose={onClose}
      header={<p>PLAN · MEAL 1 Breakfast 12:30 pm</p>} inset={{ label: "Plan with Sasha" }}>
      <p>Ideas</p></Sheet> });
    expect(screen.queryByRole("dialog")).toBeNull();
    const panel = screen.getByRole("region", { name: "Plan Meal 1" });
    // One container (U2): the flow sits in the meal card's beige tray, in the detail's place.
    expect(panel.closest("[data-meal-card]")).toBeTruthy();
    expect(panel.closest('[data-card-tray="flow"]')).toBeTruthy();
    expect(container.querySelector("[data-attached-sheet]")).toBeNull();
    expect(screen.queryByRole("button", { name: "Expand Meal 1" })).toBeNull();
    // A slim mode row, not the repeated header: the card above already names the meal and its time.
    expect(within(panel).getByRole("heading", { name: "Plan with Sasha" })).toBeTruthy();
    expect(screen.queryByText(/PLAN · MEAL 1/)).toBeNull();
    // It grows with the card; it never scrolls inside.
    expect(panel.querySelector(".overflow-y-auto, .overscroll-contain")).toBeNull();
    expect((container.querySelector("[data-after-dark-meal]") as HTMLElement).getAttribute("data-card-density"))
      .toBe("compact");
    fireEvent.click(within(panel).getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(panel, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("under reduced motion, the flow simply arrives in the tray", async () => {
    const props = { slot: detailed, variant: "standard" as const, canSwap: true,
      onToggleEaten: vi.fn(), onOpenSwap: vi.fn() };
    const { rerender } = render(<MotionConfig reducedMotion="always"><SlotCard {...props} /></MotionConfig>);
    rerender(<MotionConfig reducedMotion="always"><SlotCard {...props}
      attachment={<Sheet title="Swap Meal 1" onClose={vi.fn()}><p>Other meals</p></Sheet>} /></MotionConfig>);
    // No blur or spring: the detail leaves at once and the flow is there on the next frame.
    const panel = await screen.findByRole("region", { name: "Swap Meal 1" }, { timeout: 100 });
    expect(panel.closest('[data-card-tray="flow"]')).toBeTruthy();
    expect(panel.closest("[style*='blur(6px)']")).toBeNull();
  });

  it("swaps the detail for the flow in place and back, returning focus to the footer", async () => {
    const callbacks = { onToggleEaten: vi.fn(), onOpenSwap: vi.fn(), onClear: vi.fn(), onDelete: vi.fn(),
      onPlanWithCoach: vi.fn() };
    const props = { slot: detailed, variant: "standard" as const, canSwap: true, ...callbacks };
    const { rerender } = render(<SlotCard {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand Meal 1" }));
    expect(screen.getByRole("region", { name: "Meal 1 details" })).toBeTruthy();
    rerender(<SlotCard {...props} attachment={<Sheet key="swap" title="Swap Meal 1" onClose={vi.fn()}>
      <p>Other meals</p></Sheet>} />);
    const panel = await screen.findByRole("region", { name: "Swap Meal 1" });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Meal 1 details" })).toBeNull());
    expect(panel.closest('[data-card-tray="flow"]')).toBeTruthy();
    expect(document.activeElement).toBe(panel);
    rerender(<SlotCard {...props} />);
    // The detail comes back where it was, open, and focus lands on its footer's control.
    const collapse = await screen.findByRole("button", { name: "Collapse Meal 1" });
    await waitFor(() => expect(document.activeElement).toBe(collapse));
    expect(screen.queryByRole("region", { name: "Swap Meal 1" })).toBeNull();
  });

  it("the explicit expander opens detail at once and never opens edit", () => {
    vi.useFakeTimers();
    const { callbacks, mutations } = renderDetailed();
    fireEvent.click(screen.getByRole("button", { name: "Expand Meal 1" }), { detail: 1 });
    const detail = screen.getByRole("region", { name: "Meal 1 details" });
    expect(detail).toBeTruthy();
    expect(screen.queryByText("2 ingredients")).toBeNull();
    expect(within(detail).getByRole("button", { name: /Preparation/ }).getAttribute("aria-expanded")).toBe("false");
    act(() => { vi.advanceTimersByTime(1000); });
    expect(callbacks.onOpenEdit).not.toHaveBeenCalled();
    for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Collapse Meal 1" }));
    expect(screen.queryByRole("region", { name: "Meal 1 details" })).toBeNull();
  });

  it("shows the meal's share of daily targets as compact meters", () => {
    renderDetailed({ dayTotals: { consumed: { kcal: 900, protein: 60, carbs: 100, fat: 30 },
      targets: { kcal: 2000, protein: 150, carbs: 220, fat: 70 } } });
    fireEvent.click(screen.getByRole("button", { name: "Expand Meal 1" }));
    const detail = screen.getByRole("region", { name: "Meal 1 details" });
    expect(within(detail).getByText("Daily share")).toBeTruthy();
    fireEvent.click(within(detail).getByRole("button", { name: /Daily share/ }));
    expect(within(detail).getByRole("meter", { name: "Calories: 610 of 2,000" })).toBeTruthy();
    expect(within(detail).getByRole("meter", { name: "Protein: 53 of 150 grams" })).toBeTruthy();
    // Once in the collapsed row's summary, once beside the calorie meter.
    expect(within(detail).getAllByText("31%")).toHaveLength(2);
  });

  it("lists ingredients first, then collapsed preparation and daily-target rows", () => {
    renderDetailed({ dayTotals: { consumed: { kcal: 900, protein: 60, carbs: 100, fat: 30 },
      targets: { kcal: 2000, protein: 150, carbs: 220, fat: 70 } } });
    fireEvent.click(screen.getByRole("button", { name: "Expand Meal 1" }));
    const detail = screen.getByRole("region", { name: "Meal 1 details" });
    const text = detail.textContent ?? "";
    expect(text.indexOf("Ingredients")).toBeLessThan(text.indexOf("Preparation"));
    expect(text.indexOf("Preparation")).toBeLessThan(text.indexOf("Daily share"));
    const rows = Array.from(detail.querySelectorAll("button[aria-controls]"));
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.getAttribute("aria-expanded")).toBe("false");
  });

  it("never invents daily targets when the profile has none", () => {
    renderDetailed({ dayTotals: { consumed: { kcal: 0, protein: 0, carbs: 0, fat: 0 }, targets: null } });
    fireEvent.click(screen.getByRole("button", { name: "Expand Meal 1" }));
    const detail = screen.getByRole("region", { name: "Meal 1 details" });
    expect(within(detail).queryByText("Daily share")).toBeNull();
    expect(within(detail).queryByRole("meter")).toBeNull();
  });

  it("previews ingredient scaling in the card before saving the changed meal", async () => {
    const onSaveComponents = vi.fn(async (_components: FoodComponent[]) => {});
    renderDetailed({ onSaveComponents, foods: {} });
    fireEvent.click(screen.getByRole("button", { name: "Expand Meal 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Increase Rice" }));
    expect((document.querySelector("[data-meal-calories]") as HTMLElement).textContent).toContain("670");
    expect(onSaveComponents).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save ingredients" }));
    await waitFor(() => expect(onSaveComponents).toHaveBeenCalledOnce());
    expect(onSaveComponents.mock.calls[0]?.[0]).toEqual([
      detailed.components[0],
      { name: "Rice", qty: 1.75, unit: "cup", role: "carb",
        macros: { kcal: 422, protein: 8.2, carbs: 92.2, fat: 1.2 } },
    ]);
  });

  it("removes one ingredient without requiring repeated minus taps", () => {
    renderDetailed({ onSaveComponents: vi.fn(async () => {}), foods: {} });
    fireEvent.click(screen.getByRole("button", { name: "Expand Meal 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Chicken breast" }));
    expect((document.querySelector("[data-meal-calories]") as HTMLElement).textContent).toContain("362");
    expect(screen.queryByText("Chicken breast")).toBeNull();
  });

  it("offers Undo for 5 seconds after an ingredient is removed", () => {
    vi.useFakeTimers();
    renderDetailed({ onSaveComponents: vi.fn(async () => {}), foods: {} });
    fireEvent.click(screen.getByRole("button", { name: "Expand Meal 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Chicken breast" }));
    fireEvent.click(screen.getByRole("button", { name: "Undo remove Chicken breast" }));
    expect(screen.getByText("Chicken breast")).toBeTruthy();
    expect((document.querySelector("[data-meal-calories]") as HTMLElement).textContent).not.toContain("362");

    fireEvent.click(screen.getByRole("button", { name: "Remove Chicken breast" }));
    act(() => { vi.advanceTimersByTime(5000); });
    expect(screen.queryByRole("button", { name: "Undo remove Chicken breast" })).toBeNull();
    expect(screen.queryByText("Chicken breast")).toBeNull();
  });

  it("keeps minus from deleting an ingredient; removal stays explicit", () => {
    renderDetailed({ onSaveComponents: vi.fn(async () => {}), foods: {} });
    fireEvent.click(screen.getByRole("button", { name: "Expand Meal 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Decrease Rice" }));
    for (let index = 0; index < 8; index += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Decrease Rice" }));
    }
    expect(screen.getByText("Rice")).toBeTruthy();
    expect(screen.getByText("¼ cup")).toBeTruthy();
  });

  it("keeps an opened card in its compact header, so the ingredients lead (meal cards v3)", () => {
    const { container } = renderDetailed();
    const card = container.querySelector("[data-after-dark-meal]") as HTMLElement;
    expect(card.getAttribute("data-card-density")).toBe("compact");
    fireEvent.click(screen.getByRole("button", { name: "Expand Meal 1" }));
    expect(card.getAttribute("data-card-density")).toBe("compact");
  });

  it("uses an inline ingredient search instead of a second search button", () => {
    renderDetailed({ onSaveComponents: vi.fn(async () => {}), foods: {} });
    fireEvent.click(screen.getByRole("button", { name: "Expand Meal 1" }));
    expect(screen.getByRole("searchbox", { name: "Search foods" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Search foods for Meal 1" })).toBeNull();
  });

  it("does not leave unsaved preview numbers on a collapsed card", () => {
    renderDetailed({ onSaveComponents: vi.fn(async () => {}), foods: {} });
    fireEvent.click(screen.getByRole("button", { name: "Expand Meal 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Increase Rice" }));
    expect((document.querySelector("[data-meal-calories]") as HTMLElement).textContent).toContain("670");
    fireEvent.click(screen.getByRole("button", { name: "Collapse Meal 1" }));
    expect((document.querySelector("[data-meal-calories]") as HTMLElement).textContent).toContain("610");
  });

});

/** A reschedule the server refused is an error: a red alert, never a quiet status pill. */
describe("reschedule failure", () => {
  async function dragAndFail(card: HTMLElement) {
    vi.useFakeTimers();
    fireEvent.pointerDown(card, { pointerType: "mouse", button: 0, clientX: 150, clientY: 300 });
    act(() => { vi.advanceTimersByTime(460); });
    fireEvent.pointerMove(document, { pointerType: "mouse", clientX: 150, clientY: 420 });
    fireEvent.pointerUp(document, { pointerType: "mouse" });
    await act(async () => { await vi.runAllTimersAsync(); });
  }

  it("shows a failed meal-time save as a red alert", async () => {
    const onTimeChange = vi.fn(async () => { throw new Error("offline"); });
    const { container } = render(<SlotCard slot={slot} variant="standard"
      canSwap={false} onToggleEaten={() => {}} onOpenSwap={() => {}} onTimeChange={onTimeChange} />);
    await dragAndFail(container.querySelector("[data-meal-card]") as HTMLElement);
    expect(onTimeChange).toHaveBeenCalledTimes(1);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Time could not be saved. Try again.");
    expect(alert.className).toContain("bg-alert");
  });

  it("shows a failed logged-entry time save as a red alert", async () => {
    unbindAccount(); bindAccount(TEST_USER);
    const onTimeChange = vi.fn(async () => { throw new Error("offline"); });
    const entry = { id: "e1", foodId: "f", name: "Toast", portionLabel: "slice", qty: 1, grams: 30,
      macros: { kcal: 80, protein: 3, carbs: 15, fat: 1 }, at: "2026-09-20T12:00:00" };
    const { container } = render(<LoggedExtraCard entry={entry} pending={false} onOpen={() => {}}
      onTimeChange={onTimeChange} />);
    await dragAndFail(container.querySelector(".meal-card") as HTMLElement);
    expect(onTimeChange).toHaveBeenCalledTimes(1);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Time could not be saved. Try again.");
    expect(alert.className).toContain("bg-alert");
  });
});
