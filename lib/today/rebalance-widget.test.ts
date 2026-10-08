/** D3 (Phase 19 R2): "rebalance" joins or leaves the saved panel order, never touching the rest. */
// @vitest-environment jsdom
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { resetTestAccount } from "@/tests/helpers/account";
import { DEFAULT_PREFS, loadWidgetPrefs, saveWidgetPrefs, type WidgetPrefs } from "./widget-prefs";
import { useRebalanceWidgetSync, withRebalancePanel } from "./rebalance-widget";
import { accountKey, type AccountHandle } from "@/lib/device/account";
import type { RebalancePanel } from "@/lib/rebalance/panel";

const NUDGE: RebalancePanel = {
  show: true, state: "under", tone: "nudge", copyKey: "under",
  numbers: { targetKcal: 2000, recordedKcal: 500, leftKcal: 1500, plannedKcal: 1800,
    intake: { status: "complete", estimatedSlots: 0, unknownSlots: 0, unknownItems: 0, unknownEntries: 0, partial: false },
    proteinTargetG: 120, proteinConsumedG: 25 },
  cards: [],
};

afterEach(cleanup);

describe("withRebalancePanel", () => {
  it("appends it once while show is true", () => {
    expect(withRebalancePanel(["kcalLeft", "water"], true)).toEqual(["kcalLeft", "water", "rebalance"]);
    expect(withRebalancePanel(["kcalLeft", "water", "rebalance"], true)).toEqual(["kcalLeft", "water", "rebalance"]);
  });

  it("removes it, and only it, once show is false", () => {
    expect(withRebalancePanel(["kcalLeft", "rebalance", "water"], false)).toEqual(["kcalLeft", "water"]);
    expect(withRebalancePanel(["kcalLeft", "water"], false)).toEqual(["kcalLeft", "water"]);
  });

  it("never reorders the other panels", () => {
    expect(withRebalancePanel(["water", "macros", "kcalLeft"], true))
      .toEqual(["water", "macros", "kcalLeft", "rebalance"]);
  });
});

/**
 * A harness shaped like the real widget (components/today/LiveWidget.tsx): `live` is React state
 * the hook's own `update` writes back into, not a prop frozen for the test, so a second render sees
 * exactly what the first one committed — the same relationship the component has. The widget's own
 * separate mount-load effect (`setPrefs(loadWidgetPrefs(account))`) is reproduced too, since the
 * sync hook alone, by design, may skip its own write on a run whose projection needs no change.
 */
function useHarness(account: AccountHandle | null, initialPanel: RebalancePanel | undefined) {
  const [panel, setPanel] = useState(initialPanel);
  const [live, setLive] = useState<WidgetPrefs>(DEFAULT_PREFS);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLive(loadWidgetPrefs(account));
  }, [account]);
  useRebalanceWidgetSync(account, setLive, panel, live);
  return { panel, setPanel, live, setLive };
}

describe("useRebalanceWidgetSync", () => {
  beforeEach(() => { localStorage.clear(); });

  it("PR #470 review R1, P1: opens the widget, not just selects the panel, the instant it nudges", async () => {
    const handle = await resetTestAccount();
    const { result } = renderHook(() => useHarness(handle, { ...NUDGE, show: false }));
    act(() => { result.current.setPanel(NUDGE); });
    await waitFor(() => expect(result.current.live.panels).toContain("rebalance"));
    expect(result.current.live.index).toBe(result.current.live.panels.indexOf("rebalance"));
    expect(result.current.live.expanded).toBe(true);
  });

  it("PR #470 review R1/R2, WARN: an in-memory edit storage never kept survives a later gate change", async () => {
    const handle = await resetTestAccount();
    const { result } = renderHook(() => useHarness(handle, { ...NUDGE, show: false }));
    await waitFor(() => expect(result.current.live).toBeTruthy());
    // A tray edit made while storage was full or blocked: held only in memory, never persisted —
    // `saveWidgetPrefs` would have failed silently and left no newer value for a later read to see.
    act(() => { result.current.setLive({ panels: ["water", "macros", "kcalLeft"], expanded: true, index: 1 }); });
    // A later, ordinary gate change (not a nudge, not an account change) must reconcile the live
    // prefs, never re-read storage — a stale but still-readable old value would otherwise win.
    act(() => { result.current.setPanel({ ...NUDGE, tone: "quiet" }); });
    await waitFor(() => expect(result.current.live.panels).toContain("rebalance"));
    expect(result.current.live.panels[0]).toBe("water");
  });

  it("reads storage once, on mount, when nothing has been edited in memory yet", async () => {
    const handle = await resetTestAccount();
    saveWidgetPrefs(handle, { panels: ["macros", "kcalLeft", "water"], expanded: true, index: 0 }, false);
    const { result } = renderHook(() => useHarness(handle, undefined));
    await waitFor(() => expect(result.current.live.panels[0]).toBe("macros"));
  });

  it("never re-reads storage for the same account after the first run, even if it changed underneath", async () => {
    const handle = await resetTestAccount();
    const { result } = renderHook(() => useHarness(handle, { ...NUDGE, show: false }));
    await waitFor(() => expect(result.current.live).toBeTruthy());
    act(() => { result.current.setLive({ panels: ["water", "macros", "kcalLeft"], expanded: true, index: 1 }); });
    // Another tab (or a stale write) left a different value in storage; this run must never see it.
    saveWidgetPrefs(handle, { panels: ["kcalEaten"], expanded: false, index: 0 }, false);
    act(() => { result.current.setPanel({ ...NUDGE, tone: "quiet" }); });
    await waitFor(() => expect(result.current.live.panels).toContain("rebalance"));
    expect(result.current.live.panels[0]).toBe("water");
  });
});

describe("loadWidgetPrefs / saveWidgetPrefs: this tab's session cache (Sol re-plan)", () => {
  beforeEach(() => { localStorage.clear(); });

  it("a remount sees the last attempted save, not an older value a failed write left readable", async () => {
    const handle = await resetTestAccount();
    saveWidgetPrefs(handle, { panels: ["macros", "kcalLeft", "water"], expanded: true, index: 0 }, false);
    const edited: WidgetPrefs = { panels: ["water", "macros", "kcalLeft"], expanded: true, index: 1 };
    saveWidgetPrefs(handle, edited, false);
    // Simulate storage silently failing that second write (full or blocked): the old value is all
    // that is actually readable back, the same shape a real failed `setItem` would leave behind.
    localStorage.setItem(accountKey(handle, "widget:v1"),
      JSON.stringify({ panels: ["macros", "kcalLeft", "water"], expanded: true, index: 0 }));
    // A fresh mount (no `live` of its own yet) must still see the attempted edit.
    expect(loadWidgetPrefs(handle).panels[0]).toBe("water");
  });

  it("never carries one account's session cache over to a different one", async () => {
    const first = await resetTestAccount();
    saveWidgetPrefs(first, { panels: ["water"], expanded: true, index: 0 }, false);
    const second = await resetTestAccount("22222222-2222-4222-8222-222222222222");
    expect(loadWidgetPrefs(second).panels).toEqual(DEFAULT_PREFS.panels);
  });

  it("reports false when the write itself never lands, instead of claiming success (#470 followup)", async () => {
    const handle = await resetTestAccount();
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new DOMException("full", "QuotaExceededError"); };
    try {
      expect(saveWidgetPrefs(handle, { panels: ["water"], expanded: true, index: 0 }, false)).toBe(false);
    } finally {
      Storage.prototype.setItem = original;
    }
  });
});
