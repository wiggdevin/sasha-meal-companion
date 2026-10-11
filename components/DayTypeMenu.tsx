"use client";

import { useEffect, useRef } from "react";
import { motion } from "motion/react";
import { dayTypeChoices, dayTypeNowNote, type DayTypeChoice } from "@/lib/plan-day";
import type { DayType } from "@/lib/types";

const CHECK = <path d="M20 6 9 17l-5-5" />;

/**
 * The day-type dropdown: drops in place under the header chip instead of a bottom sheet. All three
 * rows are always offered, so they never move under a finger; the type in force carries the check.
 * While a save is in flight every row is disabled. A failed save keeps the menu open with the error
 * above the rows — tapping a row again is the retry. Escape or a tap outside `anchor` closes it.
 */
export default function DayTypeMenu({
  id,
  anchor,
  date,
  dayType,
  locked,
  saving,
  error,
  onChoose,
  onClose,
  quickMeals,
  onQuickMeals,
}: {
  id?: string;
  /** The wrapper holding the chip and this menu; a pointer-down outside it closes the menu. */
  anchor?: React.RefObject<HTMLElement | null>;
  date: string;
  dayType: DayType;
  locked: boolean;
  saving: boolean;
  error?: string | null;
  onChoose: (choice: DayTypeChoice) => void;
  onClose: () => void;
  quickMeals?: boolean;
  onQuickMeals?: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const choices = dayTypeChoices(dayType, date, locked);

  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus({ preventScroll: true });
    function onKey(event: KeyboardEvent) { if (event.key === "Escape") onClose(); }
    function onDown(event: PointerEvent) {
      const root = anchor?.current ?? menu.current;
      if (root && event.target instanceof Node && !root.contains(event.target)) onClose();
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [anchor, onClose]);

  return (
    <motion.div ref={menu} id={id} role="menu" aria-label="Day type" aria-busy={saving ? true : undefined}
      initial={{ opacity: 0, y: -6, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -6, scale: 0.97 }} transition={{ duration: 0.16, ease: [0.23, 1, 0.32, 1] }}
      className="menu-glass absolute right-0 top-[calc(100%+8px)] z-40 flex w-64 origin-top-right flex-col p-1.5">
      {error && <p role="alert" className="px-3 py-2 text-tiny text-alert">{error}</p>}
      {choices.map((choice) => (
        <button key={choice.id} type="button" role="menuitemradio" aria-checked={choice.current}
          disabled={saving} onClick={() => onChoose(choice)}
          className="tap flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left hover:bg-fog focus-visible:bg-fog focus-visible:outline-none disabled:opacity-60">
          <span className="min-w-0">
            <span className="block text-body-sm text-charcoal">{choice.label}</span>
            <span className="block text-tiny text-muted">{choice.note}</span>
          </span>
          {choice.current && (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"
              stroke="var(--color-primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {CHECK}
            </svg>
          )}
        </button>
      ))}
      {onQuickMeals && <>
        <div aria-hidden="true" className="mx-3 my-1 h-px bg-hairline" />
        <button type="button" role="menuitemcheckbox" aria-checked={quickMeals ?? false}
          disabled={saving} onClick={onQuickMeals}
          className="tap flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left hover:bg-fog focus-visible:bg-fog focus-visible:outline-none disabled:opacity-60">
          <span className="min-w-0">
            <span className="block text-body-sm text-charcoal">Quick meals</span>
            <span className="block text-tiny text-muted">Suggests meals ready in about 15 minutes</span>
          </span>
          {quickMeals && (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"
              stroke="var(--color-primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {CHECK}
            </svg>
          )}
        </button>
      </>}
      <p className="px-3 pb-1 pt-1.5 text-tiny text-muted">Now: {dayTypeNowNote(dayType, locked)}</p>
    </motion.div>
  );
}
