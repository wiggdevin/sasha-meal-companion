"use client";

/**
 * Onboarding v2 question-set beats: one row of tap-only chips. Single choice reads as a radio group
 * (`aria-checked`); multi choice as toggle buttons (`aria-pressed`). A chosen chip carries a check
 * as well as the olive fill, so the state never rests on colour alone. Every chip is ≥ 48px.
 */
import type { ReactNode } from "react";
import styles from "./ChoiceChips.module.css";

export type ChipOption<T extends string | number> = { value: T; label: ReactNode; hint?: string };

function Check() {
  return <svg className={styles.check} viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"
      strokeLinejoin="round" />
  </svg>;
}

export default function ChoiceChips<T extends string | number>({
  label, options, value, onChange, multiple = false, block = false,
}: {
  /** The group's accessible name. */
  label: string;
  options: readonly ChipOption<T>[];
  /** One value (single) or every chosen value (multiple). */
  value: T | null | readonly T[];
  onChange: (value: T) => void;
  multiple?: boolean;
  /** One full-width chip per row (long labels). */
  block?: boolean;
}) {
  const chosen = (option: T) => Array.isArray(value) ? value.includes(option) : value === option;
  return <div role={multiple ? "group" : "radiogroup"} aria-label={label}
    className={block ? "flex w-full flex-col gap-2" : "flex flex-wrap gap-2"}>
    {options.map((option) => {
      const on = chosen(option.value);
      return <button key={String(option.value)} type="button"
        role={multiple ? undefined : "radio"}
        aria-pressed={multiple ? on : undefined}
        aria-checked={multiple ? undefined : on}
        onClick={() => onChange(option.value)}
        className={`${styles.chip} ${block ? styles.block : ""} text-body-sm font-medium text-charcoal`}>
        {on && <Check />}
        <span>{option.label}</span>
      </button>;
    })}
  </div>;
}
