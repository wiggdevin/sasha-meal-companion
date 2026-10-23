// @vitest-environment jsdom
/**
 * UI audit 2026-10-07 (Shopping r1 BLOCK): a tick made once shadowed every later read of its line,
 * so a line unticked on another device stayed "in cart" here and left the to-buy list.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ShoppingList, { type ShoppingListActions } from "./ShoppingList";
import type { ShoppingLine } from "@/lib/shopping/types";

function line(over: Partial<ShoppingLine> = {}): ShoppingLine {
  return { id: "milk", periodId: "p1", origin: "manual", name: "Milk", identity: null, category: "manual",
    needGrams: null, confirmedStockGrams: null, buyGrams: null, packageGrams: null,
    purchaseConversionStatus: "unknown", sources: [], pinned: false, checked: false, note: null,
    revision: 1, ...over };
}

function actions(over: Partial<ShoppingListActions> = {}): ShoppingListActions {
  return { setChecked: vi.fn(async () => {}), removeLine: vi.fn(async () => {}),
    patchLine: vi.fn(async () => {}), confirmPantry: vi.fn(async () => {}), ...over };
}

const list = (lines: ShoppingLine[], a: ShoppingListActions) =>
  <ShoppingList title="This week" lines={lines} actions={a} />;
const summary = () => screen.getByText(/in cart · This week/).textContent;

afterEach(cleanup);

describe("a shopping tick", () => {
  it("gives way to a newer read of its line", async () => {
    const a = actions();
    const { rerender } = render(list([line()], a));
    await act(async () => { fireEvent.click(screen.getByRole("checkbox", { name: "Milk, to buy" })); });
    expect(summary()).toBe("1 of 1 in cart · This week");
    // This save's answer, then another device unticks it: each newer revision is the truth.
    rerender(list([line({ checked: true, revision: 2 })], a));
    expect(summary()).toBe("1 of 1 in cart · This week");
    rerender(list([line({ checked: false, revision: 3 })], a));
    expect(summary()).toBe("0 of 1 in cart · This week");
    expect(screen.getByRole("checkbox", { name: "Milk, to buy" })).toBeTruthy();
  });

  it("rolls a failed tick back to the line as last read, not over a newer tick", async () => {
    let failFirst!: (error: Error) => void;
    const setChecked = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { failFirst = reject; }))
      .mockImplementation(async () => {});
    render(list([line()], actions({ setChecked })));
    await act(async () => { fireEvent.click(screen.getByRole("checkbox", { name: "Milk, to buy" })); });
    fireEvent.click(screen.getByRole("button", { name: /In cart/ }));
    await act(async () => { fireEvent.click(screen.getByRole("checkbox", { name: "Milk, in cart" })); });
    await act(async () => { fireEvent.click(screen.getByRole("checkbox", { name: "Milk, to buy" })); });
    expect(summary()).toBe("1 of 1 in cart · This week");
    await act(async () => { failFirst(new Error("offline")); });
    // The newest tick (in cart) stands; the failed first one neither flips it nor speaks over it.
    // Taps made while the first save was out wait for it, and only the newest is then sent.
    expect(summary()).toBe("1 of 1 in cart · This week");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("offline")).toBeNull();
    expect(setChecked.mock.calls.map((call) => call[1])).toEqual([true, true]);
  });
});
