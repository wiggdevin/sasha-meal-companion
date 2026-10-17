"use client";
/**
 * D3 (docs/plans/2026-10-05-day-rebalance-and-live-widget.md): the live widget opens on "rebalance"
 * the instant its tone turns to nudge; otherwise it stays on the user's last panel. Kept out of
 * components/today/LiveWidget.tsx (shared with feat/ui-glass-well's restyle) so that file only
 * calls one hook to get this.
 */
import { useEffect, useRef } from "react";
import type { AccountHandle } from "@/lib/device/account";
import type { RebalancePanel } from "@/lib/rebalance/panel";
import { effectiveWidgetPrefs, loadWidgetPrefs, type WidgetPanel, type WidgetPrefs } from "./widget-prefs";

/** "rebalance" in the stored panel order exactly while `show` is true; every other panel's order
 *  and the rest of the prefs are untouched. */
export function withRebalancePanel(panels: readonly WidgetPanel[], show: boolean): WidgetPanel[] {
  const has = panels.includes("rebalance");
  if (show === has) return [...panels];
  return show ? [...panels, "rebalance"] : panels.filter((panel) => panel !== "rebalance");
}

function samePrefs(a: WidgetPrefs, b: WidgetPrefs): boolean {
  return a.index === b.index && a.expanded === b.expanded && a.panels.length === b.panels.length
    && a.panels.every((panel, i) => panel === b.panels[i]);
}

/**
 * Keeps the EFFECTIVE prefs in step with the gate (Sol R2 re-plan): on mount, on an account change
 * and on every gate change it reconciles through the same `effectiveWidgetPrefs` projection the
 * widget renders from, so a stale "rebalance" tab is dropped too, not just hidden. The one-time jump
 * to "rebalance" the instant its tone turns to nudge (D3) is kept; a manual swipe away is never
 * fought, because the jump fires only on that edge.
 *
 * Storage is consulted only on mount and on an account change (PR #470 review R2, WARN): a write
 * that silently failed — storage full — can leave an OLDER value readable, not absent, so a read on
 * every ordinary gate change was overwriting the session's live edits with that stale value. Every
 * other run reconciles the widget's own live in-memory prefs instead, which already carries
 * whatever storage could not keep; `loadWidgetPrefs`'s fallback still covers a null read (blocked or
 * never-saved) on that one mount/account-change read.
 */
export function useRebalanceWidgetSync(
  account: AccountHandle | null,
  update: (next: WidgetPrefs) => void,
  panel: RebalancePanel | undefined,
  /** The widget's current in-memory prefs: the fallback for a null storage read, and the sole
   *  source of truth for every run after the first for this account. */
  live: WidgetPrefs,
): void {
  const show = panel?.show === true;
  const nudge = show && panel.tone === "nudge";
  const prevNudge = useRef(false);
  // `undefined` means "never run yet" — distinct from a bound account or a signed-out `null`, so
  // the very first run (and a real account change) is always detected.
  const lastAccount = useRef<AccountHandle | null | undefined>(undefined);

  useEffect(() => {
    const accountChanged = lastAccount.current !== account;
    lastAccount.current = account;
    const justNudged = nudge && !prevNudge.current;
    prevNudge.current = nudge;
    const current = accountChanged ? loadWidgetPrefs(account, live) : live;
    const effective = effectiveWidgetPrefs(current, show);
    const at = effective.panels.indexOf("rebalance");
    // A fresh nudge selects "rebalance" (D3) so the widget opens onto it the next time it opens; it
    // never expands the widget by itself (W116): the bubble and the collapsed headline carry it.
    const next = justNudged && at >= 0 ? { ...effective, index: at } : effective;
    if (samePrefs(next, current)) return;
    update(next);
    // `update` and `live` are fresh every render and are read when this fires; only a mount, an
    // account change or a real gate/nudge change should re-run it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, show, nudge]);
}
