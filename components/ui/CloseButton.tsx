"use client";

import type { Ref } from "react";

/** The close glyph every overlay shares: a linear X, 1.75 px stroke, never an emoji. */
export function CloseIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

/**
 * The one way out of an overlay: a 44 × 44 round X in the top-right of its header (the sheet's own
 * `.sheet-close`). Every sheet, picker and full-screen flow carries it, so nothing that opens over
 * the app has to be finished before the user can leave.
 */
export default function CloseButton({ onClick, label = "Close", disabled, buttonRef, className = "", onPhoto = false }: {
  onClick: () => void;
  /** Over a card's photo, top right (owner, 2026-10-05): a frosted ivory disc that reads on any
   *  photo. The card places it; the 44 px target is unchanged. */
  onPhoto?: boolean;
  label?: string;
  disabled?: boolean;
  buttonRef?: Ref<HTMLButtonElement>;
  className?: string;
}) {
  return (
    <button ref={buttonRef} type="button" onClick={onClick} aria-label={label} disabled={disabled}
      className={`${onPhoto ? "photo-close" : "sheet-close"} tap flex shrink-0 items-center justify-center disabled:opacity-40 ${className}`}>
      <CloseIcon />
    </button>
  );
}
