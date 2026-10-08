"use client";

import { useEffect } from "react";
import { attachAndroidInstallCapture } from "@/lib/install-prompt/android-capture";
import {
  noteVisibilityHidden,
  noteVisibilityVisible,
  recordPageOpenOnce,
} from "@/lib/install-prompt/readiness";

/** Fired whenever the durable open count changes, so the inline card (which only ever reads it,
 *  never records it) can pick up a change made while it was not mounted at all. */
export const OPEN_COUNT_CHANGED_EVENT = "meal-companion:install-prompt-opens-changed";

/**
 * Renders nothing. Mounted once from the root layout — never conditionally, unlike the visible
 * card — so three things happen regardless of which route or date is on screen:
 *
 * 1. Android/Chrome/Edge's `beforeinstallprompt` is captured as early as possible; the visible
 *    install card would miss it entirely if nothing was listening before it mounted.
 * 2. The one open this page load counts is recorded exactly once.
 * 3. `visibilitychange` is always watched, so a tab hidden for 30+ minutes while viewing a past
 *    date, or any other route, still counts as a reopen (Sol review round 3, 2026-10-08, BLOCK:
 *    this used to live in the visible card, which only mounts on today's Today view — a visibility
 *    change anywhere else was silently missed).
 *
 * The visible card (`components/InstallPrompt.tsx`) only ever reads the count this module
 * records, through `readOpenCount` and this event; it never calls `recordPageOpenOnce` or the
 * `noteVisibility*` functions itself.
 */
export default function InstallPromptCapture() {
  useEffect(() => {
    attachAndroidInstallCapture();
    if (typeof window === "undefined") return;

    try {
      const recorded = recordPageOpenOnce(window.localStorage);
      if (recorded !== null) window.dispatchEvent(new Event(OPEN_COUNT_CHANGED_EVENT));
    } catch {
      // Private browsing / storage disabled — the open simply is not recorded this load.
    }

    function onVisibilityChange(): void {
      if (document.visibilityState === "hidden") {
        noteVisibilityHidden();
        return;
      }
      try {
        const recorded = noteVisibilityVisible(window.localStorage);
        if (recorded !== null) window.dispatchEvent(new Event(OPEN_COUNT_CHANGED_EVENT));
      } catch {
        // Harmless: the reopen simply is not recorded.
      }
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);
  return null;
}
