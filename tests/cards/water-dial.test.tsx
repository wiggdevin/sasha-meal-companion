// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import WaterDial from "@/components/WaterDial";
import { HOLD_MS } from "@/lib/today/water-gesture";

describe("the water dial", () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); cleanup(); });

  const dial = (props: { cups: number; goal: number; onAddCup?: () => void;
      onSetCups?: (cups: number) => void }) =>
    render(<WaterDial cups={props.cups} goal={props.goal}
      onAddCup={props.onAddCup ?? (() => {})} onSetCups={props.onSetCups ?? (() => {})}>
      <span>dial</span>
    </WaterDial>);

  it("sits idle with the count, the goal and how to use it", () => {
    dial({ cups: 2, goal: 8 });
    expect(screen.getByRole("button", { name: /Water: 2 of 8 cups/ })).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("counts one cup added on a tap", () => {
    const onAddCup = vi.fn();
    dial({ cups: 2, goal: 8, onAddCup });
    const button = screen.getByRole("button");
    fireEvent.pointerDown(button, { pointerId: 1, clientX: 40, button: 0 });
    fireEvent.pointerUp(button, { pointerId: 1 });
    expect(onAddCup).toHaveBeenCalledTimes(1);
  });

  it("opens the slider while held, and commits the dragged count", () => {
    const onSetCups = vi.fn();
    dial({ cups: 2, goal: 8, onSetCups });
    const button = screen.getByRole("button");
    fireEvent.pointerDown(button, { pointerId: 1, clientX: 100, button: 0 });
    act(() => { vi.advanceTimersByTime(HOLD_MS + 10); });
    expect(screen.getByRole("status").textContent).toContain("2 cups");
    fireEvent.pointerMove(button, { pointerId: 1, clientX: 156 });
    expect(screen.getByRole("status").textContent).toContain("4 cups");
    fireEvent.pointerUp(button, { pointerId: 1 });
    expect(onSetCups).toHaveBeenCalledWith(4);
  });

  /* The count is the caller's, never the dial's own optimistic guess: when the save behind the
     tap does not land, the caller does not raise the count and the dial keeps showing the truth,
     rather than a cup the day does not have. */
  it("keeps the shown count when the add did not land", () => {
    const onAddCup = vi.fn();
    dial({ cups: 2, goal: 8, onAddCup });
    const button = screen.getByRole("button");
    fireEvent.pointerDown(button, { pointerId: 1, clientX: 40, button: 0 });
    fireEvent.pointerUp(button, { pointerId: 1 });
    expect(onAddCup).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /Water: 2 of 8 cups/ })).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
