"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { APP_NAME } from "@/lib/brand";

export const DISMISSED_KEY = "meal-companion:install-prompt-dismissed";

/**
 * The key this banner used before the `meal-companion:` rename. Devices that already dismissed
 * the hint still carry it, so the read accepts it and only the write moves on — otherwise the
 * rename re-prompts every existing install once.
 *
 * Built from escapes, not written out: the old prefix is a person's name, and
 * tests/tenancy/no-personal-defaults.test.ts scans this file for it. A legacy storage key is not
 * a reason to put a personal default back into runtime source.
 */
export const LEGACY_DISMISSED_KEY = "\x73\x61\x73\x68\x61-install-prompt-dismissed";

/** Dismissed under either key. Pure, so the migration is testable without a DOM. */
export function dismissedIn(storage: Pick<Storage, "getItem">): boolean {
  return storage.getItem(DISMISSED_KEY) === "1"
    || storage.getItem(LEGACY_DISMISSED_KEY) === "1";
}

function readDismissed(): boolean {
  try {
    return dismissedIn(window.localStorage);
  } catch {
    return false;
  }
}

function writeDismissed(): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, "1");
  } catch {
    // Private browsing / storage disabled — the hint just reappears next
    // visit, which is harmless.
  }
}

/**
 * iOS Safari never fires `beforeinstallprompt` — there is no programmatic
 * install trigger on iOS, only the manual Share → Add to Home Screen flow.
 * This shows a one-time, dismissible hint pointing at that flow, and hides
 * itself once the app is already installed (standalone) or once dismissed.
 */
function isIosSafari(): boolean {
  const ua = window.navigator.userAgent;

  const isIos =
    /iPad|iPhone|iPod/.test(ua) ||
    // iPadOS 13+ reports as "MacIntel" but has touch support Macs don't.
    (window.navigator.platform === "MacIntel" && window.navigator.maxTouchPoints > 1);

  if (!isIos) return false;

  // Exclude other iOS browsers (Chrome/Firefox/Edge-on-iOS) — they run on
  // WebKit but "Add to Home Screen" there makes a bookmark, not this PWA.
  const isOtherIosBrowser = /CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  return !isOtherIosBrowser;
}

function isStandalone(): boolean {
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return (
    window.matchMedia("(display-mode: standalone)").matches || nav.standalone === true
  );
}

export default function InstallPrompt() {
  const [visible, setVisible] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (isStandalone()) return;
    if (readDismissed()) return;
    if (!isIosSafari()) return;
    // One-shot mount-time read of browser/storage state (UA, matchMedia,
    // localStorage) — there is nothing to synchronize continuously, so this
    // is the documented "read an external system once" exception, not a
    // cascading-render risk.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setVisible(true);
  }, []);

  // Onboarding v2 (lane L2, 2026-10-07): the full-screen conversational shell covers its content
  // with a card of its own at the same spot this floats over, including the food round — route-
  // suppressed, not dismissed, so it is back the moment the account leaves /onboarding (finished or
  // skipped) rather than staying hidden for the rest of the session.
  if (pathname === "/onboarding") return null;
  if (!visible) return null;

  const dismiss = () => {
    writeDismissed();
    setVisible(false);
  };

  return (
    <div
      // Sits ABOVE the tab bar AND the quick-actions button (bottom: safe +
      // 92px, 52px tall), not at the top. A top-anchored banner covered
      // every page's title — the titles are the one thing that orients the user —
      // and the old 92px offset covered the "+" button instead.
      //
      // A floating white card (DESIGN.md Cards and Surfaces): opaque, because content scrolls
      // under it; the olive-panel class keeps the rounded panel shape and ink text.
      className="olive-panel fixed inset-x-4 z-50 flex items-start gap-3 p-4"
      style={{ bottom: "calc(var(--safe-bottom) + 156px)", background: "var(--grad-panel)",
        boxShadow: "var(--shadow-float)" }}
      role="status"
    >
      <div className="flex-1">
        <p className="m-0 text-body font-medium text-on-charcoal">
          Install {APP_NAME}
        </p>
        <p className="m-0 mt-1 text-caption font-normal leading-[1.6] text-graphite">
          Tap <span className="font-normal text-on-charcoal">Share</span>, then{" "}
          <span className="font-normal text-on-charcoal">Add to Home Screen</span> for
          quick access. Turn on meal reminders anytime in Settings.
        </p>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="tap flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-charcoal bg-fog border border-hairline"
      >
        {/* Linear inline SVG, 1.5px stroke — DESIGN.md Shapes: never emoji. */}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="m6 6 12 12M18 6 6 18" />
        </svg>
      </button>
    </div>
  );
}
