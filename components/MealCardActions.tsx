"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { CLEAR_AT, DELETE_AT, trayStrength } from "@/lib/today/swipe-detents";
import styles from "@/components/MealCardActions.module.css";

/**
 * Destructive actions stay behind the translated meal card until a swipe reveals them. Keyboard and
 * screen-reader users reach the same Clear and Delete through a More control that stays off the
 * visual surface until it takes focus (spec phase 15 R12).
 *
 * The tray fills exactly the space the card leaves as it slides: Clear first, as a faint see-through
 * olive that deepens to full colour as it opens, then Delete the same way in red, each a rounded pill
 * standing on the page background (never a square block behind the card's corner). Past the second
 * catch Delete takes the whole width and says a release deletes. Every label fits its pill at every
 * width: each pill shows the longest label it holds (MealCardActions.module.css).
 */
/** The settle after a release: quick, with a touch of overshoot so the catch feels springy. Under
 *  reduced motion the global rule in app/globals.css (`transition-duration: 0.01ms !important`, which
 *  beats this inline value) makes it an instant move, with no overshoot. */
export const SWIPE_SETTLE = "translate 280ms cubic-bezier(0.2, 0.9, 0.3, 1.12), width 280ms cubic-bezier(0.2, 0.9, 0.3, 1.12)";

export default function MealCardActions({ label, revealed, settle, onClear, onDelete, onToggle, children }: {
  label: string;
  revealed: number;
  /** Transition for the tray while no finger drives it (matches the card's settle). */
  settle?: string;
  onClear: () => void;
  onDelete: () => void;
  onToggle?: () => void;
  children: ReactNode;
}) {
  const travel = Math.max(0, revealed);
  // Reachability follows the same detents the paint uses (lib/today/swipe-detents.ts): Clear once it
  // is fully out, Delete once it is (audit b4b #8). Opening from More travels to DELETE_AT.
  const clearOut = travel >= CLEAR_AT;
  const deleteOut = travel >= DELETE_AT;
  const strength = trayStrength(travel);
  const armed = travel > DELETE_AT + 12;
  const clearWidth = Math.max(0, Math.min(travel, CLEAR_AT) - 6);
  const showDelete = travel > CLEAR_AT + 6;
  const olive = (pct: number) => `color-mix(in srgb, rgb(var(--primary-rgb)) ${pct}%, transparent)`;
  const red = (pct: number) => `color-mix(in srgb, var(--color-alert) ${pct}%, transparent)`;
  const actionsRef = useRef<HTMLDivElement>(null);
  const clearRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const focusClear = useRef(false);
  useEffect(() => {
    if (focusClear.current && deleteOut) {
      focusClear.current = false;
      clearRef.current?.focus();
      return;
    }
    // Clear/Delete close the tray (gesture.closeActions()) on click; the clicked button is now
    // aria-hidden and tabIndex=-1, but the browser leaves focus on it unless we move it back to
    // More ourselves. Any flag left pending from an in-flight open is stale once the tray closes.
    if (!clearOut && actionsRef.current?.contains(document.activeElement)) {
      focusClear.current = false;
      moreRef.current?.focus();
    }
  }, [clearOut, deleteOut]);
  return <div className="relative min-w-0 overflow-clip rounded-[32px]">
    <div ref={actionsRef} className="absolute inset-y-0 right-0 flex flex-row-reverse items-stretch overflow-hidden"
      style={{ width: travel, padding: travel > 0 ? "6px 6px 6px 0" : 0, transition: settle }} aria-hidden={!clearOut}>
      <button ref={clearRef} type="button" tabIndex={clearOut ? 0 : -1}
        aria-label={`Clear ${label}`} onClick={onClear}
        className={`tap flex shrink-0 items-center justify-center overflow-hidden whitespace-nowrap rounded-[24px] text-caption ${styles.pill}`}
        style={{ width: clearWidth, minWidth: 0, transition: settle, background: olive(18 + 82 * strength.clear),
          color: `color-mix(in srgb, var(--color-on-primary) ${Math.round(strength.clear * 100)}%, rgb(var(--primary-rgb)))` }}>
        <span aria-hidden="true" className={styles.labels}>
          <span className={`${styles.label} ${styles.clearLabel}`}>Clear</span>
        </span>
      </button>
      <button type="button" tabIndex={deleteOut ? 0 : -1} aria-hidden={clearOut && !deleteOut ? true : undefined}
        aria-label={`Delete ${label}`} onClick={onDelete}
        className={`tap flex min-w-0 flex-1 flex-col items-center justify-center gap-1 overflow-hidden whitespace-nowrap rounded-[24px] text-caption ${styles.pill}`}
        style={{ ...(showDelete ? { marginRight: 6 } : { flex: "0 0 0px", minWidth: 0, opacity: 0 }),
          background: red(18 + 82 * strength.del),
          color: `color-mix(in srgb, var(--color-on-primary) ${Math.round(strength.del * 100)}%, var(--color-alert))` }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v6m4-6v6" />
        </svg>
        {/* The longest label the pill's width holds (MealCardActions.module.css); never clipped. */}
        <span aria-hidden="true" className={styles.labels}>
          {armed ? <>
            <span className={`${styles.label} ${styles.releaseLong}`}>Release to delete</span>
            <span className={`${styles.label} ${styles.releaseShort}`}>Delete</span>
          </> : <span className={`${styles.label} ${styles.deleteLabel}`}>Delete</span>}
        </span>
      </button>
    </div>
    {children}
    {onToggle && <button ref={moreRef} type="button" aria-expanded={clearOut}
      aria-label={`More for ${label}`}
      onClick={() => { focusClear.current = !deleteOut; onToggle(); }}
      className="tap sr-only focus-visible:not-sr-only focus-visible:!absolute focus-visible:!left-3 focus-visible:!top-3 focus-visible:!z-20 focus-visible:!rounded-full focus-visible:!bg-primary focus-visible:!px-4 focus-visible:!py-2 focus-visible:!text-caption focus-visible:!text-on-primary">
      More
    </button>}
  </div>;
}
