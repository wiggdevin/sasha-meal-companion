"use client";
/**
 * The one inline message card (2026-10-04, owner: "Messages, failed processes and alerts should have
 * their own toast box that fits the UI"). A soft wash card, 16 px corners, a round tone mark, a
 * title and/or a body line, an optional action ("Try again") and an optional dismiss. It grows in on
 * the house spring (`SPRINGS.smooth`); reduced motion: it simply arrives.
 *
 * Tones (globals.css `.notice[data-tone]`, DESIGN.md §Colors and §Contrast):
 *   info       sage wash, sage-ink mark: a fact about what is shown ("Still saving this meal…")
 *   attention  Dijon wash, Dijon-ink mark: needs a look ("Some foods are hidden…")
 *   error      red wash, red-ink mark: something failed; announced as an alert
 *   success    sage wash, a filled sage tick: it worked
 *   neutral    beige, a muted dot: nothing here yet ("No ready meal options yet")
 * Text is always ink on the light wash, so it stays readable inside a matte card too.
 */
import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { spring } from "@/lib/design/motion";

export type NoticeTone = "info" | "attention" | "error" | "success" | "neutral";

export type NoticeAction = { label: string; onClick: () => void; disabled?: boolean };

const ICON = {
  width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
  strokeWidth: 2.2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true,
} as const;

function ToneIcon({ tone }: { tone: NoticeTone }) {
  if (tone === "error") return <svg {...ICON}><path d="M12 7v6" /><path d="M12 17h.01" /></svg>;
  if (tone === "attention") return <svg {...ICON}><path d="M12 6v8" /><path d="M12 18h.01" /></svg>;
  if (tone === "success") return <svg {...ICON}><path d="m6 12.5 4 4 8-9" /></svg>;
  // A calm dot: a minus in a ring read as "remove" or "collapse" (Kimi K7, 2026-10-04).
  if (tone === "neutral") return <svg {...ICON} data-notice-mark="dot"><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" /></svg>;
  return <svg {...ICON}><path d="M12 11v6" /><path d="M12 7h.01" /></svg>;
}

/** Errors interrupt (an alert); everything else is a polite status. */
export function noticeRole(tone: NoticeTone): "alert" | "status" {
  return tone === "error" ? "alert" : "status";
}

export default function Notice({ tone = "info", title, children, action, onDismiss, icon, className = "" }: {
  tone?: NoticeTone;
  /** The one line that says what happened. */
  title?: ReactNode;
  /** A second line: why, or what to do. */
  children?: ReactNode;
  action?: NoticeAction;
  onDismiss?: () => void;
  /** Replaces the tone's own glyph inside the mark. */
  icon?: ReactNode;
  className?: string;
}) {
  const reduce = useReducedMotion();
  return <motion.div role={noticeRole(tone)} data-tone={tone}
    className={`notice flex min-w-0 items-start gap-3 p-3 ${className}`.trim()}
    initial={reduce ? false : { opacity: 0, y: 6, scale: 0.98 }}
    animate={{ opacity: 1, y: 0, scale: 1 }}
    transition={spring("smooth", reduce)}>
    <span className="notice-mark mt-px">{icon ?? <ToneIcon tone={tone} />}</span>
    <div className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
      {title && <p className="notice-title m-0 text-caption font-semibold">{title}</p>}
      {children && <p className="m-0 text-caption text-graphite">{children}</p>}
      {action && <button type="button" onClick={action.onClick} disabled={action.disabled}
        className="btn-ink tap mt-2 min-h-11 px-4 text-caption disabled:opacity-40">{action.label}</button>}
    </div>
    {onDismiss && <button type="button" onClick={onDismiss} aria-label="Dismiss"
      className="tap -my-2.5 -mr-2 flex size-11 shrink-0 items-center justify-center text-muted">
      <svg {...ICON} width={16} height={16} strokeWidth={1.8}><path d="m6 6 12 12M18 6 6 18" /></svg>
    </button>}
  </motion.div>;
}
