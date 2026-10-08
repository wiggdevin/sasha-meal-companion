"use client";

import { useEffect, useRef } from "react";
import Button from "@/components/ui/Button";
import Fold from "@/components/ui/Fold";
import { CARD_META, CARD_SECTION } from "@/lib/design/meal-type";
import {
  COMING_PANELS, PANEL_NAME, WIDGET_PANELS, isConditionalPanel, movePanel, type WidgetPanel, type WidgetPrefs,
} from "@/lib/today/widget-prefs";
import styles from "@/components/today/island/Island.module.css";

const UP = "M6 15l6-6 6 6";
const DOWN = "M6 9l6 6 6-6";

function Arrow({ path }: { path: string }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path} /></svg>;
}

/**
 * The widget's edit tray (owner, 2026-10-05: "figure out a unique way to allow the widget to be
 * changed and customized"): the lid lifts off the widget and this tray folds open under it. In the
 * widget, each panel can move up or down or be removed (one always stays); Available adds one back;
 * panels whose backend has not landed show as "Coming soon". Every change applies at once; Done closes.
 * Remove and Add unmount the very row the keyboard focus sits on (PR #470 review R1, P2): both move
 * focus to a surviving control afterward — the row that slides into the vacated spot, or Done when
 * none is left — instead of losing a keyboard or screen-reader user's place to the document body.
 * A gate-conditional panel (lib/today/widget-prefs.ts's `isConditionalPanel`) offers neither Remove
 * nor Move (PR #470 review R3/R4, WARN): `effectiveWidgetPrefs` drops it from storage the moment
 * its gate closes and re-appends it at the end the moment it reopens, so a chosen position would be
 * silently lost at the very next gate change — a control that promises a lasting change it cannot
 * keep is worse than no control. An ordinary neighbour's own Move can still swap places with it, so
 * that neighbour's Move is disabled at that boundary too, not just at the ends of the list. Remove
 * is disabled once only one ORDINARY panel is left, not merely one panel of any kind: a gated panel
 * can vanish on its own gate's say, so "one always stays" has to mean one the user actually chose.
 */
export default function WidgetEditTray({ prefs, onChange, onDone }: {
  prefs: WidgetPrefs; onChange: (next: WidgetPrefs) => void; onDone: () => void;
}) {
  const { panels } = prefs;
  const ordinaryCount = panels.filter((panel) => !isConditionalPanel(panel)).length;
  const available = WIDGET_PANELS.filter((panel) => !panels.includes(panel));
  type AvailablePanel = (typeof available)[number];
  const removeRefs = useRef(new Map<WidgetPanel, HTMLButtonElement>());
  const addRefs = useRef(new Map<AvailablePanel, HTMLButtonElement>());
  const doneRef = useRef<HTMLButtonElement | null>(null);
  const pendingFocus = useRef<{ kind: "remove" | "add"; at: number } | null>(null);

  // Runs after the row the focus was on has already unmounted: lands on whatever now sits at (or
  // nearest to) that same position, falling back to Done when the whole list emptied out.
  useEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    pendingFocus.current = null;
    if (pending.kind === "remove") {
      const removable = panels.filter((panel) => !isConditionalPanel(panel));
      // A lone remaining ordinary panel has its own Remove disabled (`ordinaryCount === 1`): not a
      // focusable target, so land on Done directly rather than call `.focus()` on a disabled button.
      const target = removable.length > 1 ? removable[Math.min(pending.at, removable.length - 1)] : undefined;
      (target && removeRefs.current.get(target) || doneRef.current)?.focus();
    } else {
      const target = available[Math.min(pending.at, available.length - 1)];
      (target && addRefs.current.get(target) || doneRef.current)?.focus();
    }
  }, [panels, available]);

  const set = (next: WidgetPanel[], keep?: WidgetPanel) => {
    const current = keep ?? panels[Math.min(prefs.index, panels.length - 1)];
    const at = next.indexOf(current);
    onChange({ ...prefs, panels: next, index: at >= 0 ? at : 0 });
  };
  const remove = (panel: WidgetPanel) => {
    const removable = panels.filter((name) => !isConditionalPanel(name));
    pendingFocus.current = { kind: "remove", at: removable.indexOf(panel) };
    set(panels.filter((name) => name !== panel));
  };
  const add = (panel: AvailablePanel) => {
    pendingFocus.current = { kind: "add", at: available.indexOf(panel) };
    // Ahead of any gate-conditional panel, never after it (PR #470 review R5, WARN): appending
    // after "rebalance" reads fine while the gate stays open, but the very next gate cycle drops
    // it and re-appends it at the end, silently reordering the panel Add just placed.
    const firstConditional = panels.findIndex((name) => isConditionalPanel(name));
    const next = firstConditional < 0 ? [...panels, panel]
      : [...panels.slice(0, firstConditional), panel, ...panels.slice(firstConditional)];
    set(next);
  };
  return <Fold>
    <section aria-label="Arrange the widget" className={`glass-well ${styles.tray}`}>
      <div className="flex items-center justify-between gap-3">
        <h3 className={`m-0 ${CARD_SECTION}`}>In the widget</h3>
        <Button ref={doneRef} variant="primary" size="sm" onClick={onDone}>Done</Button>
      </div>
      <ul className={styles.trayList}>
        {panels.map((panel, at) => <li key={panel} className={styles.trayRow}>
          <span className="min-w-0 flex-1 truncate text-caption text-charcoal">{PANEL_NAME[panel]}</span>
          {!isConditionalPanel(panel) && <>
            <Button variant="ghost" shape="circle" aria-label={`Move ${PANEL_NAME[panel]} up`}
              disabled={at === 0 || isConditionalPanel(panels[at - 1])}
              onClick={() => set(movePanel(panels, panel, -1), panel)}><Arrow path={UP} /></Button>
            <Button variant="ghost" shape="circle" aria-label={`Move ${PANEL_NAME[panel]} down`}
              disabled={at === panels.length - 1 || isConditionalPanel(panels[at + 1])}
              onClick={() => set(movePanel(panels, panel, 1), panel)}>
              <Arrow path={DOWN} /></Button>
            <Button variant="tertiary" size="sm" disabled={ordinaryCount === 1}
              ref={(node) => { if (node) removeRefs.current.set(panel, node); else removeRefs.current.delete(panel); }}
              onClick={() => remove(panel)}>Remove</Button>
          </>}
        </li>)}
      </ul>
      {(available.length > 0 || COMING_PANELS.length > 0) && <>
        <h3 className={`m-0 ${CARD_SECTION}`}>Available</h3>
        <ul className={styles.trayList}>
          {available.map((panel) => <li key={panel} className={styles.trayRow}>
            <span className="min-w-0 flex-1 truncate text-caption text-charcoal">{PANEL_NAME[panel]}</span>
            <Button variant="secondary" size="sm"
              ref={(node) => { if (node) addRefs.current.set(panel, node); else addRefs.current.delete(panel); }}
              onClick={() => add(panel)}>Add</Button>
          </li>)}
          {COMING_PANELS.map((panel) => <li key={panel.id} className={styles.trayRow}>
            <span className="min-w-0 flex-1 truncate text-caption text-muted">{panel.name}</span>
            <span className={CARD_META}>Coming soon</span>
          </li>)}
        </ul>
      </>}
    </section>
  </Fold>;
}
