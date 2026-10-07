// @vitest-environment jsdom
/**
 * Sol R2 re-plan: a saved "rebalance" tab never outlives a denied or unanswered gate — not in the
 * carousel, the bubbles, the pager or the Edit tray — and an ordinary edit made meanwhile saves
 * the order without it. Every renderer and every write reads one effective preference
 * (`effectiveWidgetPrefs`, lib/today/widget-prefs.ts) with the gate's live answer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import LiveWidget from "./LiveWidget";
import type { PanelData } from "./LiveWidgetPanels";
import { resetTestAccount } from "@/tests/helpers/account";
import { loadWidgetPrefs, saveWidgetPrefs } from "@/lib/today/widget-prefs";
import type { RebalancePanel } from "@/lib/rebalance/panel";

const DATA: PanelData = {
  targets: { kcal: 2000, protein: 150, carbs: 200, fat: 70 },
  consumed: { kcal: 500, protein: 30, carbs: 50, fat: 15 },
  partial: false,
};

const ON: RebalancePanel = {
  show: true, state: "on_track", tone: "quiet", copyKey: "on_track",
  numbers: { targetKcal: 2000, recordedKcal: 500, leftKcal: 1500, plannedKcal: 2000,
    intake: { status: "complete", estimatedSlots: 0, unknownSlots: 0, unknownItems: 0, unknownEntries: 0, partial: false },
    proteinTargetG: 150, proteinConsumedG: 30 },
  cards: [],
};

const NAME = "Rebalance my day";
/** Visible text or an accessible name anywhere: the carousel, bubbles, pager or the Edit tray. */
const anywhere = () => screen.queryAllByText(new RegExp(NAME)).length
  + document.querySelectorAll(`[aria-label^="${NAME}"]`).length;

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe(): void {} unobserve(): void {} disconnect(): void {} });
});
afterEach(cleanup);

describe("LiveWidget: one effective preference for every renderer and every write", () => {
  it.each([
    ["denied", { show: false } as RebalancePanel],
    ["unanswered", undefined],
  ])("hides a saved tab while the gate is %s, in the carousel and the Edit tray alike", async (_label, gate) => {
    const handle = await resetTestAccount();
    // A previous session saw the gate open, so the saved order still names the tab.
    saveWidgetPrefs(handle, { panels: ["kcalLeft", "rebalance", "water"], expanded: true, index: 1 }, true);
    expect(loadWidgetPrefs(handle).panels).toContain("rebalance");

    const view = render(<LiveWidget data={{ ...DATA, rebalance: gate }} />);
    await waitFor(() => expect(anywhere()).toBe(0));

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const tray = await screen.findByRole("region", { name: "Arrange the widget" });
    expect(tray.textContent).not.toContain(NAME);
    expect(anywhere()).toBe(0);

    // An ordinary edit saves the order without the tab and keeps the rest of it.
    fireEvent.click(screen.getByRole("button", { name: "Move Water up" }));
    await waitFor(() => expect(loadWidgetPrefs(handle).panels).toEqual(["water", "kcalLeft"]));

    // Allowing access brings it in, at the end of the saved order.
    await act(async () => { view.rerender(<LiveWidget data={{ ...DATA, rebalance: ON }} />); });
    await waitFor(() => expect(anywhere()).toBeGreaterThan(0));
    expect(screen.getByRole("region", { name: "Arrange the widget" }).textContent).toContain(NAME);
    await waitFor(() => expect(loadWidgetPrefs(handle).panels).toEqual(["water", "kcalLeft", "rebalance"]));
  });

  it("never persists the tab from a write made while the gate is not an explicit yes", async () => {
    const handle = await resetTestAccount();
    saveWidgetPrefs(handle, { panels: ["kcalLeft", "rebalance"], expanded: false, index: 1 }, false);
    expect(loadWidgetPrefs(handle)).toEqual({ panels: ["kcalLeft"], expanded: false, index: 0 });
  });
});
