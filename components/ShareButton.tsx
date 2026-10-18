"use client";

import { useEffect, useRef, useState } from "react";
import { generateWeekSummary } from "@/lib/summary";
import type { ResolvedDay } from "@/lib/types";
import Button from "@/components/ui/Button";
import { CONFIRM_MS, ERROR_MS } from "@/components/ui/useButtonStatus";

type ShareButtonProps = {
  weekDays: ResolvedDay[];
  /** ISO "yyyy-mm-dd" for "today" — passed straight through to the generator. */
  today: string;
};

export type ShareStatus = "idle" | "empty" | "copied" | "error";

/**
 * `generateWeekSummary` returns "" for an empty week (lib/summary.ts — nothing scoreable yet).
 * Pulled out so that "nothing to share" case is checkable without a DOM, mirroring
 * HealthSourcesSheet.tsx's `copyIssuedToken` / `CopyTokenButton` split.
 */
export function statusForEmptyShare(text: string): ShareStatus | null {
  return text ? null : "empty";
}

/** The label shown for each status — same split as above. */
export function shareButtonLabel(status: ShareStatus): string {
  switch (status) {
    case "empty":
      return "Nothing to share yet";
    case "copied":
      return "Copied — ready to paste";
    case "error":
      return "Couldn't copy — try again";
    default:
      return "Share my week";
  }
}

/**
 * What a failed `navigator.share` means (audit 2026-10-18 §11). A dismissed sheet is an
 * `AbortError`: the person chose not to share, so nothing is copied and nothing reads as a failure.
 * `NotAllowedError` (no user activation, or the platform refused) and `TypeError` (the data was not
 * accepted) fall back to the clipboard; anything else is a plain error.
 */
export function shareFailure(error: unknown): "cancelled" | "clipboard" | "error" {
  const name = error instanceof Error || (typeof error === "object" && error !== null && "name" in error)
    ? String((error as { name: unknown }).name)
    : "";
  if (name === "AbortError") return "cancelled";
  if (name === "NotAllowedError" || name === "TypeError") return "clipboard";
  return "error";
}

/**
 * "Share my week". PRD §6.2/§8 — no account, no server: this either
 * hands the OS share sheet a plain-text block (installed PWA / iOS Safari),
 * or, where `navigator.share` doesn't exist or refuses, copies the same text to the
 * clipboard so it can be pasted into a message instead.
 */
export default function ShareButton({ weekDays, today }: ShareButtonProps) {
  const [status, setStatus] = useState<ShareStatus>("idle");
  // One reset timer: a second tap clears the first tap's, and leaving the page clears it too.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  function show(next: ShareStatus, ms: number) {
    if (timer.current) clearTimeout(timer.current);
    setStatus(next);
    timer.current = setTimeout(() => { timer.current = null; setStatus("idle"); }, ms);
  }

  async function handleShare() {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    setStatus("idle");
    const text = generateWeekSummary(weekDays, today);
    const emptyStatus = statusForEmptyShare(text);
    if (emptyStatus) {
      show(emptyStatus, ERROR_MS);
      return;
    }

    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      try {
        await navigator.share({ text });
        return;
      } catch (error) {
        const failure = shareFailure(error);
        if (failure === "cancelled") return;
        if (failure === "error") {
          show("error", ERROR_MS);
          return;
        }
      }
    }

    try {
      await navigator.clipboard.writeText(text);
      show("copied", CONFIRM_MS);
    } catch {
      show("error", ERROR_MS);
    }
  }

  // The one action on the Week screen, so the primary; it confirms in itself (DESIGN.md §Buttons):
  // "Copied — ready to paste" for 1.6 s, or a shake and "Couldn't copy — try again". "Nothing to
  // share yet" goes through the error state so the button's live region reads it out.
  return (
    <Button variant="primary" block onClick={handleShare}
      status={status === "copied" ? "success" : status === "error" || status === "empty" ? "error" : "idle"}
      confirmLabel={shareButtonLabel("copied")}
      errorLabel={shareButtonLabel(status === "empty" ? "empty" : "error")}>
      {shareButtonLabel("idle")}
    </Button>
  );
}
