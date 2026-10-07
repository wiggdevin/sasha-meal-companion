// @vitest-environment jsdom
/**
 * Sol R2 re-plan, the render half on its own: with the storage reconciliation switched off, so the
 * widget's raw state still names a stale "rebalance" tab, the one effective preference alone keeps
 * it out of the carousel, the bubbles, the pager and the Edit tray. (LiveWidget.test.tsx covers the
 * two halves together, and the saved order.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import LiveWidget from "./LiveWidget";
import type { PanelData } from "./LiveWidgetPanels";
import { resetTestAccount } from "@/tests/helpers/account";
import { saveWidgetPrefs } from "@/lib/today/widget-prefs";

vi.mock("@/lib/today/rebalance-widget", async (original) => ({
  ...(await original<typeof import("@/lib/today/rebalance-widget")>()),
  useRebalanceWidgetSync: () => {},
}));

const DATA: PanelData = {
  targets: { kcal: 2000, protein: 150, carbs: 200, fat: 70 },
  consumed: { kcal: 500, protein: 30, carbs: 50, fat: 15 },
  partial: false,
  rebalance: { show: false },
};

const NAME = "Rebalance my day";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe(): void {} unobserve(): void {} disconnect(): void {} });
});
afterEach(cleanup);

describe("LiveWidget: the effective preference alone hides a stale tab", () => {
  it("keeps it out of the carousel, the pager and the Edit tray", async () => {
    const handle = await resetTestAccount();
    saveWidgetPrefs(handle, { panels: ["kcalLeft", "rebalance", "water"], expanded: true, index: 1 }, true);
    render(<LiveWidget data={DATA} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy());
    expect(screen.queryAllByText(new RegExp(NAME))).toHaveLength(0);
    expect(document.querySelectorAll(`[aria-label^="${NAME}"]`)).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const tray = await screen.findByRole("region", { name: "Arrange the widget" });
    expect(tray.textContent).not.toContain(NAME);
  });
});
