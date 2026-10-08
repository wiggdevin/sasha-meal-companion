// @vitest-environment jsdom
/**
 * CONDITIONAL_PANELS (lib/today/widget-prefs.ts) are added, removed AND repositioned only by their
 * own gate (effectiveWidgetPrefs) — never by the tray. A Remove on one was a no-op the gate would
 * immediately undo; a Move's new position was, too (PR #470 review R3, WARN) — the gate drops the
 * panel the moment it closes and re-appends it at the end the moment it reopens — so the tray hides
 * both there and keeps them for every ordinary panel.
 */
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import WidgetEditTray from "./WidgetEditTray";
import type { WidgetPrefs } from "@/lib/today/widget-prefs";

afterEach(cleanup);

const prefs: WidgetPrefs = { panels: ["kcalLeft", "rebalance", "water"], expanded: true, index: 0 };

/** A controlled wrapper: `onChange` re-renders the tray with the next prefs the way the real,
 *  stateful widget does, so a Remove/Add that unmounts a row runs through a real re-render. */
function Controlled({ initial, onDone = () => {} }: { initial: WidgetPrefs; onDone?: () => void }) {
  const [state, setState] = useState(initial);
  return <WidgetEditTray prefs={state} onChange={setState} onDone={onDone} />;
}

describe("WidgetEditTray: no Remove or Move for a gate-conditional panel", () => {
  it("offers no Move or Remove on the Rebalance row; an ordinary row keeps all three", () => {
    render(<WidgetEditTray prefs={prefs} onChange={() => {}} onDone={() => {}} />);
    const tray = screen.getByRole("region", { name: "Arrange the widget" });

    const rebalanceRow = within(tray).getByText("Rebalance my day").closest("li");
    if (!rebalanceRow) throw new Error("Rebalance row not found");
    expect(within(rebalanceRow).queryByRole("button", { name: "Move Rebalance my day up" })).toBeNull();
    expect(within(rebalanceRow).queryByRole("button", { name: "Move Rebalance my day down" })).toBeNull();
    expect(within(rebalanceRow).queryByRole("button", { name: "Remove" })).toBeNull();

    const waterRow = within(tray).getByText("Water").closest("li");
    if (!waterRow) throw new Error("Water row not found");
    expect(within(waterRow).getByRole("button", { name: "Remove" })).toBeTruthy();
  });

  it("PR #470 review R4, WARN: an ordinary neighbour can't Move across the gated row either", () => {
    // kcalLeft, rebalance, water — rebalance sits between the two ordinary panels.
    render(<WidgetEditTray prefs={prefs} onChange={() => {}} onDone={() => {}} />);
    const tray = screen.getByRole("region", { name: "Arrange the widget" });
    const kcalDown = within(within(tray).getByText("Calories left").closest("li")!)
      .getByRole("button", { name: "Move Calories left down" });
    const waterUp = within(within(tray).getByText("Water").closest("li")!)
      .getByRole("button", { name: "Move Water up" });
    // Both would otherwise swap places with "rebalance" — a position its own gate wipes out.
    expect(kcalDown.hasAttribute("disabled")).toBe(true);
    expect(waterUp.hasAttribute("disabled")).toBe(true);
  });
});

describe("WidgetEditTray: focus stays on a surviving control (PR #470 review R1, P2)", () => {
  it("moves focus off a removed row's button onto the row that takes its place", () => {
    const initial: WidgetPrefs = { panels: ["kcalLeft", "macros", "water"], expanded: true, index: 0 };
    render(<Controlled initial={initial} />);
    const tray = screen.getByRole("region", { name: "Arrange the widget" });
    const widgetList = within(tray).getAllByRole("list")[0];
    const macrosRemove = within(within(widgetList).getByText("Protein, carbs and fat").closest("li")!)
      .getByRole("button", { name: "Remove" });
    macrosRemove.focus();
    fireEvent.click(macrosRemove);
    // Protein, carbs and fat's row left "In the widget" (it reappears under Available); Water now
    // sits at that same position in the widget and keeps focus.
    expect(within(widgetList).queryByText("Protein, carbs and fat")).toBeNull();
    expect(document.activeElement).toBe(within(within(widgetList).getByText("Water").closest("li")!)
      .getByRole("button", { name: "Remove" }));
  });

  it("PR #470 review R4, WARN: disables Remove on the last ORDINARY panel, a gated one doesn't count", () => {
    // Only one ordinary panel ("kcalLeft") plus the gate-conditional "rebalance": removing kcalLeft
    // would leave just a panel its own gate can make vanish, undoing the user's choice outright.
    const initial: WidgetPrefs = { panels: ["kcalLeft", "rebalance"], expanded: true, index: 0 };
    render(<Controlled initial={initial} />);
    const tray = screen.getByRole("region", { name: "Arrange the widget" });
    const kcalRemove = within(within(tray).getByText("Calories left").closest("li")!)
      .getByRole("button", { name: "Remove" });
    expect(kcalRemove.hasAttribute("disabled")).toBe(true);
  });

  it("moves focus to Done when removing the last removable row leaves nothing to land on", () => {
    // Two ordinary panels: removing the first is allowed (one ordinary panel still remains after).
    const initial: WidgetPrefs = { panels: ["kcalLeft", "water"], expanded: true, index: 0 };
    render(<Controlled initial={initial} />);
    const tray = screen.getByRole("region", { name: "Arrange the widget" });
    const kcalRemove = within(within(tray).getByText("Calories left").closest("li")!)
      .getByRole("button", { name: "Remove" });
    kcalRemove.focus();
    fireEvent.click(kcalRemove);
    // Only Water is left, and with just one ordinary panel its own Remove is now disabled, not a
    // focusable surviving control, so focus falls all the way back to Done.
    expect(document.activeElement).toBe(within(tray).getByRole("button", { name: "Done" }));
  });

  it("moves focus off an added row's button onto the Available row that takes its place", () => {
    const initial: WidgetPrefs = { panels: ["kcalLeft"], expanded: true, index: 0 };
    render(<Controlled initial={initial} />);
    const tray = screen.getByRole("region", { name: "Arrange the widget" });
    const addButtons = () => within(tray).getAllByRole("button", { name: "Add" });
    const firstAdd = addButtons()[0];
    const firstAvailableRow = firstAdd.closest("li");
    firstAdd.focus();
    fireEvent.click(firstAdd);
    // The row that was first in Available is now in the widget; whatever took its old spot keeps focus.
    expect(within(tray).queryByText(firstAvailableRow!.textContent!.replace("Add", ""))).not.toBeNull();
    expect(document.activeElement?.tagName).toBe("BUTTON");
    expect((document.activeElement as HTMLButtonElement).textContent).toMatch(/Add|Done/);
  });

  it("PR #470 review R5, WARN: Add inserts ahead of the gated row, never after it", () => {
    const initial: WidgetPrefs = { panels: ["kcalLeft", "rebalance"], expanded: true, index: 0 };
    render(<Controlled initial={initial} />);
    const tray = screen.getByRole("region", { name: "Arrange the widget" });
    fireEvent.click(within(tray).getAllByRole("button", { name: "Add" })[0]);
    // Whatever Add just placed sits before "Rebalance my day" in the widget list, so a later gate
    // close/reopen (which always re-appends "rebalance" at the very end) never reorders it.
    const widgetList = within(tray).getAllByRole("list")[0];
    const rows = within(widgetList).getAllByRole("listitem");
    const names = rows.map((row) => row.querySelector(".truncate")?.textContent);
    expect(names.indexOf("Rebalance my day")).toBe(names.length - 1);
  });
});
