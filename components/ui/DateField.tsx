"use client";

import { AnimatePresence } from "motion/react";
import { useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import DatePickerSheet, { formatFieldDate, validIsoDay } from "@/components/ui/DatePickerSheet";
import styles from "@/components/ui/DateField.module.css";

export type DateFieldProps = {
  /** ISO "YYYY-MM-DD"; "" or null is no date. */
  value: string | null | undefined;
  /** The chosen ISO day, or null once cleared. */
  onChange(value: string | null): void;
  min?: string | null;
  max?: string | null;
  /** The field's name: the sheet's title and the start of the button's accessible name. */
  label?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  id?: string;
  /** Submits the ISO value with a form, through a hidden input. */
  name?: string;
  className?: string;
  style?: CSSProperties;
  disabled?: boolean;
  placeholder?: string;
  /** Offers Clear in the sheet, for a date that may be left empty. */
  allowClear?: boolean;
  /** Today's ISO day; the device's own by default (tests pin it). */
  today?: string;
};

const noSubscribe = () => () => {};

function CalendarGlyph() {
  return <svg className={styles.glyph} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3.5" y="5" width="17" height="15.5" rx="3" /><path d="M3.5 10h17M8 3v4M16 3v4" />
  </svg>;
}

/**
 * The app's date field (2026-10-01), in place of `<input type="date">` and its browser pop-up. It
 * reads as a typed field showing "3 Sep 2026" (or a muted placeholder) with a calendar glyph; a tap
 * opens DatePickerSheet. A caller's `well` class is dropped: `button.well` is the quiet pill button,
 * and this field keeps the input look from its own module.
 */
export default function DateField({ value, onChange, min, max, label, "aria-label": ariaLabel,
  "aria-describedby": describedBy, id, name, className = "", style, disabled = false,
  placeholder = "Choose a date", allowClear = false, today }: DateFieldProps) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const client = useSyncExternalStore(noSubscribe, () => true, () => false);
  const iso = validIsoDay(value);
  const shown = iso ? formatFieldDate(iso) : placeholder;
  const fieldName = ariaLabel ?? label;
  const layout = className.split(/\s+/).filter((name) => name !== "well" && name !== "").join(" ");

  function close() {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  }

  return (
    <>
      <button ref={trigger} type="button" id={id} value={iso ?? ""} disabled={disabled}
        aria-label={fieldName ? `${fieldName}, ${iso ? shown : "no date chosen"}` : undefined}
        aria-describedby={describedBy} aria-haspopup="dialog" aria-expanded={open}
        onClick={() => setOpen(true)}
        className={`${styles.trigger} tap ${layout}`.trim()} style={style}>
        <span className={`${styles.value} ${iso ? "" : styles.placeholder}`.trim()}>{shown}</span>
        <CalendarGlyph />
      </button>
      {name && <input type="hidden" name={name} value={iso ?? ""} />}
      {client && createPortal(
        <AnimatePresence>
          {open && <DatePickerSheet key="date-picker" title={fieldName ?? "Choose a date"} value={iso}
            min={min} max={max} allowClear={allowClear} today={today}
            onCommit={(next) => { if (next !== iso) onChange(next); }} onClose={close} />}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}
