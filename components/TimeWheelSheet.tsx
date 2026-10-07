"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { formatTime } from "@/components/SlotCard";
import { POPOVER_GUTTER } from "@/lib/dom/popover-place";
import { nextTrapFocus } from "@/lib/dom/sheet-a11y";
import { usePopoverPlacement } from "@/lib/dom/use-popover-placement";
import { quarterHours } from "@/lib/today/presentation";
import Button from "@/components/ui/Button";
import CloseButton from "@/components/ui/CloseButton";

export type TimeWheelSheetProps = {
  value: string;
  onChange(value: string): void;
  onClose(): void;
};

const HOURS = quarterHours();
/** One wheel row; the wheel is five rows tall with the chosen row in the middle. */
const ROW_PX = 44;
const FOCUSABLE = 'button:not([disabled]), input, [tabindex="0"]';

/** "7:30", "07:30" or "0730" → minutes since midnight; anything else is null. */
function minutesOf(value: string): number | null {
  const match = /^(\d{1,2}):?(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [hours, minutes] = [Number(match[1]), Number(match[2])];
  return hours <= 23 && minutes <= 59 ? hours * 60 + minutes : null;
}

/** A typed time, zero-padded to "HH:MM" without moving it; null when it is not a time. */
export function normalizeTime(value: string): string | null {
  const minutes = minutesOf(value);
  return minutes === null ? null
    : `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** The nearest quarter hour of the same day: 23:53 stays 23:45 rather than rolling to tomorrow. */
export function nearestQuarter(value: string): string | null {
  const minutes = minutesOf(value);
  return minutes === null ? null : HOURS[Math.min(HOURS.length - 1, Math.round(minutes / 15))];
}

/** Steps whole quarter hours, wrapping within the day (23:45 + 15 min = 00:00). */
export function stepQuarter(value: string, steps: number): string {
  const index = HOURS.indexOf(nearestQuarter(value) ?? "12:00");
  return HOURS[(((index + steps) % HOURS.length) + HOURS.length) % HOURS.length];
}

/**
 * The meal-time sheet (FluidVoice U05): a finger-scrollable wheel of the day's 96 quarter hours,
 * minus and plus steps, and a field for typing a time. An opaque pop-up card beside the button that
 * opened it, over a scrim, above the meal sheet.
 * Done hands the chosen time to `onChange`; Escape, the scrim and Close leave it unchanged.
 */
export default function TimeWheelSheet({ value, onChange, onClose }: TimeWheelSheetProps) {
  const [draft, setDraft] = useState(() => nearestQuarter(value) ?? "12:00");
  const [typed, setTyped] = useState(() => nearestQuarter(value) ?? value);
  const [typedError, setTypedError] = useState(false);
  const titleId = useId();
  const optionId = useId();
  const fieldId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const wheel = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const { placement } = usePopoverPlacement(dialog, card);
  const index = HOURS.indexOf(draft);

  function choose(next: string) {
    setDraft(next);
    setTyped(next);
    setTypedError(false);
  }

  function commitTyped() {
    const next = nearestQuarter(typed);
    if (next === null) { setTypedError(true); return; }
    choose(next);
  }

  // The chosen row sits in the middle of the wheel however it was chosen.
  useEffect(() => {
    const element = wheel.current;
    if (element && Math.round(element.scrollTop / ROW_PX) !== index) element.scrollTop = index * ROW_PX;
  }, [index]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    wheel.current?.focus({ preventScroll: true });
    return () => previous?.focus?.({ preventScroll: true });
  }, []);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId}
      className="sheet-popover-root fixed inset-0 z-[70] min-w-0 w-full max-w-full"
      onKeyDown={(event) => {
        // Handled here and stopped, so the meal sheet underneath neither closes nor steals focus.
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        } else if (event.key === "Tab") {
          event.stopPropagation();
          const focusable = Array.from(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
          const next = nextTrapFocus(focusable, document.activeElement as HTMLElement | null, event.shiftKey);
          if (next) { event.preventDefault(); next.focus(); }
        }
      }}>
      <button type="button" tabIndex={-1} aria-label="Close time picker" onClick={onClose}
        className="sheet-scrim-in sheet-popover-scrim absolute inset-0" />
      {/* A pop-up card beside the clock button that opened it (2026-10-03: no bottom sheets). */}
      <div ref={card} className="time-sheet-surface popover-pop absolute flex min-w-0 max-w-full flex-col gap-3 overflow-y-auto px-4 pb-5 pt-4"
        style={{ top: placement?.top ?? POPOVER_GUTTER, left: placement?.left ?? POPOVER_GUTTER,
          width: placement?.width ?? `calc(100% - ${POPOVER_GUTTER * 2}px)`, maxHeight: placement?.maxHeight,
          transformOrigin: placement ? `${placement.originX}px ${placement.originY}px` : "50% 50%" }}>
        <div className="flex items-center justify-between gap-3">
          <h2 id={titleId} className="m-0 text-heading-sm font-medium text-charcoal">Meal time</h2>
          <CloseButton onClick={onClose} />
        </div>
        <label htmlFor={fieldId} className="text-tiny text-muted">Type a time</label>
        <div className="-mt-2 flex min-w-0 items-center gap-2">
          <Button variant="tertiary" shape="circle" aria-label="15 minutes earlier" className="text-[20px] leading-none"
            onClick={() => choose(stepQuarter(draft, -1))}>−</Button>
          <input id={fieldId} type="text" inputMode="numeric" autoComplete="off" placeholder="HH:MM"
            value={typed} aria-invalid={typedError || undefined}
            onChange={(event) => { setTyped(event.target.value); setTypedError(false); }}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitTyped(); } }}
            onBlur={() => { if (typed !== draft) commitTyped(); }}
            className="well h-11 min-w-0 flex-1 px-4 text-center text-body-sm tabular-nums" />
          <Button variant="tertiary" shape="circle" aria-label="15 minutes later" className="text-[20px] leading-none"
            onClick={() => choose(stepQuarter(draft, 1))}>+</Button>
        </div>
        {typedError && <p role="alert" className="m-0 text-tiny text-alert">Type a time like 07:30.</p>}
        <div className="relative">
          <div aria-hidden="true" className="time-wheel-band pointer-events-none absolute inset-x-0 top-[88px] h-11" />
          <div ref={wheel} role="listbox" aria-label="Quarter hours" tabIndex={0}
            aria-activedescendant={`${optionId}-${index}`}
            className="time-wheel relative h-[220px] snap-y snap-mandatory overflow-y-auto overscroll-contain py-[88px] [scrollbar-width:none] focus-visible:outline-2 focus-visible:outline-primary [&::-webkit-scrollbar]:hidden"
            onScroll={(event) => {
              const next = HOURS[Math.max(0, Math.min(HOURS.length - 1, Math.round(event.currentTarget.scrollTop / ROW_PX)))];
              if (next !== draft) choose(next);
            }}
            onKeyDown={(event) => {
              const step = { ArrowDown: 1, ArrowUp: -1, PageDown: 4, PageUp: -4 }[event.key];
              if (step !== undefined) { event.preventDefault(); choose(stepQuarter(draft, step)); }
              if (event.key === "Home") { event.preventDefault(); choose(HOURS[0]); }
              if (event.key === "End") { event.preventDefault(); choose(HOURS[HOURS.length - 1]); }
            }}>
            {HOURS.map((hour, row) => (
              <div key={hour} id={`${optionId}-${row}`} role="option" data-value={hour}
                aria-selected={hour === draft} onClick={() => choose(hour)}
                className={`flex h-11 cursor-pointer snap-center items-center justify-center text-body-sm tabular-nums ${
                  hour === draft ? "font-medium text-charcoal" : "text-muted"}`}>
                {formatTime(hour)}
              </div>
            ))}
          </div>
        </div>
        <Button variant="primary" size="lg" block onClick={() => { onChange(draft); onClose(); }}>Done</Button>
      </div>
    </div>,
    document.body,
  );
}
