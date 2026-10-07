"use client";

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { ActionFeedbackPhase } from "@/components/ui/ActionFeedback";

/**
 * The one button (DESIGN.md §Buttons, KIT.md §5; 2026-10-04 owner: "a rule-based system … some are
 * too fat, some are too plain … if something's landed and saved, the button itself should confirm
 * it, not a toast").
 *
 * Variants, by job:
 * - `primary`   the one action that completes a flow (Save, Log it, Send). Olive, cream label.
 * - `secondary` the action on a card (Plan, Add a food, Connect). A tinted fill with a hairline, so
 *               it never reads as bare text; on a matte card it tints cream instead of ink.
 * - `tertiary`  the quieter neighbour of a secondary (Cancel, Log what you ate). The beige well.
 * - `ghost`     an inline text action inside a row (Undo, Edit, Show all). No fill until pressed.
 * - `danger`    a destructive action. Red ink; its own two-step confirm lives with the caller.
 * Legacy names stay accepted: `outline` = secondary, `quiet` = tertiary, `icon` = primary circle.
 *
 * Sizes are fixed: `sm` 36 px (a 44 px hit area around it), `md` 44 px, `lg` 52 px (sheet and panel
 * primaries only). Labels never wrap.
 *
 * Status is the button's own outcome language. `pending` hides the label (its width is kept) and
 * pulses three dots; `success` draws a tick and shows `confirmLabel` ("Saved", "Logged"); `error`
 * shakes once and shows `errorLabel` when one is given. The label, the confirmation and the error
 * share one grid cell, so the button is always as wide as the widest of them and never jumps.
 * A control handed `data-feedback-state` by `useActionFeedback` maps it onto the same status.
 */
export type ButtonVariant = "primary" | "secondary" | "tertiary" | "ghost" | "danger" | "outline" | "quiet" | "icon";
export type ButtonSize = "sm" | "md" | "lg";
export type ButtonStatus = "idle" | "pending" | "success" | "error";

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "btn-primary",
  secondary: "btn-secondary",
  outline: "btn-secondary",
  tertiary: "btn-tertiary",
  quiet: "btn-tertiary",
  ghost: "btn-ghost",
  danger: "btn-danger",
  icon: "btn-primary",
};

export function statusFromFeedback(phase: ActionFeedbackPhase | undefined | string): ButtonStatus {
  if (phase === "pending") return "pending";
  if (phase === "success" || phase === "changed") return "success";
  if (phase === "failed") return "error";
  return "idle";
}

export type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** A round button holding one glyph; give it an `aria-label`. */
  shape?: "pill" | "circle";
  /** Full width of its row (panel and sheet footers). */
  block?: boolean;
  status?: ButtonStatus;
  /** The verb shown on success: "Saved", "Logged", "Updated". Defaults to "Done". */
  confirmLabel?: string;
  /** Shown while an error holds; without it the button only shakes and returns. */
  errorLabel?: string;
  /** A glyph before the label (16–20 px, currentColor). */
  leading?: ReactNode;
  children?: ReactNode;
  "data-feedback-state"?: string;
};

function Dots() {
  return <span className="btn-dots" aria-hidden="true"><span /><span /><span /></span>;
}

function Tick() {
  return <svg className="btn-tick" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none"
    stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3.5 8.4 6.6 11.4 12.5 4.8" pathLength={1} />
  </svg>;
}

/**
 * The classes of a button, for the one place a button must be a link (`<a>` / `next/link`: Sign in on
 * a gate, Set up on the Day card). Same variants and sizes; a link has no outcome states.
 */
export function buttonClasses({ variant = "secondary", size = "md", shape, block = false, className = "" }: {
  variant?: ButtonVariant; size?: ButtonSize; shape?: "pill" | "circle"; block?: boolean; className?: string;
} = {}): string {
  const circle = shape === "circle" || variant === "icon";
  return ["btn", VARIANT_CLASS[variant], `btn-${size}`, circle ? "btn-circle" : "", block ? "btn-block" : "", className]
    .filter(Boolean).join(" ");
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({
  variant = "secondary", size = "md", shape, block = false, status, confirmLabel = "Done", errorLabel,
  leading, className = "", type = "button", children, disabled, ...rest
}, ref) {
  const circle = shape === "circle" || variant === "icon";
  const shown: ButtonStatus = status ?? statusFromFeedback(rest["data-feedback-state"]);
  const busy = shown === "pending";
  // A button that reports outcomes carries its own polite live region, mounted from the start so the
  // confirmation is announced; it sits beside the button because a button's children are not exposed.
  const tracksStatus = status !== undefined || "data-feedback-state" in rest;
  const classes = buttonClasses({ variant, size, shape, block, className });
  const button = (
    <button ref={ref} type={type} className={classes} data-status={shown === "idle" ? undefined : shown}
      aria-busy={busy || undefined} disabled={disabled || busy} {...rest}>
      <span className="btn-stack">
        <span className="btn-label">{leading}{children}</span>
        {busy && <Dots />}
        {tracksStatus && !circle && <span className="btn-confirm" aria-hidden="true"><Tick />{confirmLabel}</span>}
        {tracksStatus && !circle && errorLabel && <span className="btn-error" aria-hidden="true">{errorLabel}</span>}
      </span>
      {tracksStatus && circle && <span className="btn-circle-tick" aria-hidden="true"><Tick /></span>}
    </button>
  );
  if (!tracksStatus) return button;
  return <>
    {button}
    <span className="sr-only" role="status" aria-live="polite">
      {shown === "success" ? confirmLabel : shown === "error" ? (errorLabel ?? "That did not work.") : ""}
    </span>
  </>;
});

export default Button;
