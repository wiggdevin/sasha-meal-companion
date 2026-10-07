"use client";

import { useCallback, useId, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import DayTypeChip from "@/components/DayTypeChip";
import DayTypeMenu from "@/components/DayTypeMenu";
import { dayTypeChoicePatch, savePlanDay, toggleFloorDay } from "@/lib/plan-day-client";
import {
  createChoiceGate, nextChoiceAction, type ChoiceGate, type DayTypeChoice,
} from "@/lib/plan-day";
import type { DayType } from "@/lib/types";

const SAVE_ERROR = "Couldn't save. Try again.";

/**
 * The header chip and its dropdown menu, together, because the two share one piece of
 * state that matters: whether the menu is open. Extracted from app/page.tsx
 * (which is over the 400-line limit) so the write, the failure and the close
 * all live in one place.
 *
 * The save is awaited. While it is in flight the menu stays open, and if it
 * rejects the menu stays open with the error under the rows — tapping a row
 * again is the retry. Nothing closes on a write that did not happen.
 *
 * The gate is a ref, so it shuts synchronously: a second tap before the save
 * settles cannot be judged against the day the sheet still has on screen (see
 * `nextChoiceAction`), and cannot queue a second op for the same date.
 */
export default function DayTypeToggle({
  date,
  dayType,
  override,
  onSaved,
  quickMeals,
}: {
  date: string;
  quickMeals?: boolean;
  dayType: DayType;
  override: DayType | undefined;
  /** Called after a successful write so the screen re-derives targets. */
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const gateRef = useRef<ChoiceGate | null>(null);
  gateRef.current ??= createChoiceGate();
  const gate = gateRef.current;
  const locked = override !== undefined;
  const wrapper = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const close = useCallback(() => setOpen(false), []);

  async function choose(choice: DayTypeChoice) {
    const action = nextChoiceAction({ saving: gate.saving(), dayType, locked }, choice);
    if (action === "ignore") return; // a save is already in flight — its result stands
    if (action === "close") {
      setOpen(false); // already the day in force — nothing to write
      return;
    }
    gate.claim();
    setSaving(true);
    setError(null);
    try {
      await savePlanDay(date, dayTypeChoicePatch(choice));
    } catch {
      setError(SAVE_ERROR);
      return;
    } finally {
      gate.release();
      setSaving(false);
    }
    setOpen(false);
    onSaved();
  }

  async function changeQuickMeals() {
    if (gate.saving()) return;
    gate.claim();
    setSaving(true);
    setError(null);
    try {
      await toggleFloorDay(date);
      onSaved();
    } catch {
      setError(SAVE_ERROR);
    } finally {
      gate.release();
      setSaving(false);
    }
  }

  function toggleMenu() {
    setError(null);
    setOpen((was) => !was);
  }

  return (
    <div ref={wrapper} className="relative">
      <DayTypeChip dayType={dayType} override={override} open={open} onOpen={toggleMenu} menuId={menuId} />
      <AnimatePresence>
        {open && (
          <DayTypeMenu
            key={`day-type-${date}`}
            id={menuId}
            anchor={wrapper}
            date={date}
            dayType={dayType}
            locked={locked}
            saving={saving}
            error={error}
            quickMeals={quickMeals}
            onQuickMeals={quickMeals === undefined ? undefined : () => void changeQuickMeals()}
            onChoose={choose}
            onClose={close}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
