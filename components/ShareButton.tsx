"use client";

import { useState } from "react";
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
 * "Share my week". PRD §6.2/§8 — no account, no server: this either
 * hands the OS share sheet a plain-text block (installed PWA / iOS Safari),
 * or, where `navigator.share` doesn't exist, copies the same text to the
 * clipboard so it can be pasted into a message instead.
 */
export default function ShareButton({ weekDays, today }: ShareButtonProps) {
  const [status, setStatus] = useState<ShareStatus>("idle");

  async function handleShare() {
    const text = generateWeekSummary(weekDays, today);
    const emptyStatus = statusForEmptyShare(text);
    if (emptyStatus) {
      setStatus(emptyStatus);
      setTimeout(() => setStatus("idle"), ERROR_MS);
      return;
    }

    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      try {
        await navigator.share({ text });
        return;
      } catch {
        // Cancelled the sheet, or the platform refused it — fall back to
        // clipboard rather than leaving the user with nothing.
      }
    }

    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      setStatus("copied");
    } catch {
      setStatus("error");
    } finally {
      setTimeout(() => setStatus("idle"), copied ? CONFIRM_MS : ERROR_MS);
    }
  }

  // The one action on the Week screen, so the primary; it confirms in itself (DESIGN.md §Buttons):
  // "Copied — ready to paste" for 1.6 s, or a shake and "Couldn't copy — try again".
  return (
    <Button variant="primary" block onClick={handleShare}
      status={status === "copied" ? "success" : status === "error" ? "error" : "idle"}
      confirmLabel={shareButtonLabel("copied")} errorLabel={shareButtonLabel("error")}>
      {shareButtonLabel(status === "empty" ? "empty" : "idle")}
    </Button>
  );
}
