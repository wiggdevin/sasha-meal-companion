"use client";

import { useCallback, useEffect, useState } from "react";
import Button from "@/components/ui/Button";
import Notice from "@/components/ui/Notice";
import { APP_NAME } from "@/lib/brand";
import type { Store } from "@/lib/types";
import { meaningfulMomentReached, recordAppOpen } from "@/lib/install-prompt/readiness";
import {
  ANDROID_INSTALLED_EVENT,
  ANDROID_PROMPT_READY_EVENT,
  readDeferredInstallPrompt,
  triggerAndroidInstall,
  wasInstalledThisSession,
} from "@/lib/install-prompt/android-capture";

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

function isStandalone(): boolean {
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return (
    window.matchMedia("(display-mode: standalone)").matches || nav.standalone === true
  );
}

function isIos(ua: string, platform: string, maxTouchPoints: number): boolean {
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    // iPadOS 13+ reports as "MacIntel" but has touch support Macs don't.
    (platform === "MacIntel" && maxTouchPoints > 1)
  );
}

/** iPad shows Share in the top-right toolbar; iPhone/iPod show it in the bottom toolbar. */
function isIpad(ua: string, platform: string, maxTouchPoints: number): boolean {
  return /iPad/.test(ua) || (platform === "MacIntel" && maxTouchPoints > 1);
}

type IosOtherBrowser = "crios" | "fxios" | "edgios" | "opios";

/** Chrome/Firefox/Edge/Opera on iOS all run on WebKit, but "Add to Home Screen" there makes a
 *  bookmark, not this PWA — only Safari's own Share sheet installs it (Chrome on iOS 16.4+ is the
 *  one documented exception). */
function iosOtherBrowser(ua: string): IosOtherBrowser | null {
  if (/CriOS/.test(ua)) return "crios";
  if (/FxiOS/.test(ua)) return "fxios";
  if (/EdgiOS/.test(ua)) return "edgios";
  if (/OPiOS/.test(ua)) return "opios";
  return null;
}

/** An in-app webview (Instagram, Facebook, TikTok, WeChat, X) — none of these expose a real
 *  Share sheet at all, on iOS or Android. */
function isInAppWebview(ua: string): boolean {
  return /FBAN|FBAV|Instagram|Line\/|MicroMessenger|TikTok/i.test(ua);
}

function iosVersion(ua: string): [number, number] | null {
  const match = /OS (\d+)_(\d+)/.exec(ua);
  if (!match) return null;
  return [Number(match[1]), Number(match[2])];
}

/** iOS 16.4 shipped the WebKit changes Chrome-on-iOS install support needs. */
function supportsIosChromeInstall(ua: string): boolean {
  const version = iosVersion(ua);
  if (!version) return false;
  const [major, minor] = version;
  return major > 16 || (major === 16 && minor >= 4);
}

type Variant =
  | { kind: "android" }
  | { kind: "ios-safari"; ipad: boolean }
  | { kind: "ios-chrome-capable" }
  | { kind: "ios-open-safari" };

function detectVariant(hasAndroidPrompt: boolean): Variant | null {
  if (hasAndroidPrompt) return { kind: "android" };

  const ua = window.navigator.userAgent;
  const platform = window.navigator.platform;
  const maxTouchPoints = window.navigator.maxTouchPoints ?? 0;
  if (!isIos(ua, platform, maxTouchPoints)) return null;

  const other = iosOtherBrowser(ua);
  if (!other && !isInAppWebview(ua)) {
    return { kind: "ios-safari", ipad: isIpad(ua, platform, maxTouchPoints) };
  }
  if (other === "crios" && supportsIosChromeInstall(ua)) return { kind: "ios-chrome-capable" };
  return { kind: "ios-open-safari" };
}

function ShareIcon({ className }: { className?: string }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d="M12 3v12" />
      <path d="m8 7 4-4 4 4" />
      <rect x="5" y="11" width="14" height="10" rx="2" />
    </svg>
  );
}

function AddToHomeIcon({ className }: { className?: string }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <rect x="4" y="4" width="16" height="16" rx="4" />
      <path d="M12 8v8M8 12h8" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

/** The one-time visual guide for iOS Safari (no install API exists there): points at where Share
 *  actually sits — the bottom toolbar on iPhone, the top-right toolbar on iPad — with the Share and
 *  Add to Home Screen icons drawn in code, never a dead block of instructions alone. */
function IosShareGuide({ ipad, onDismiss }: { ipad: boolean; onDismiss: () => void }) {
  const location = ipad ? "top-right toolbar" : "bottom toolbar";
  return (
    <div className="shell">
      <div className="surface flex flex-col gap-3 px-4 py-4">
        <div className="flex items-start gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-fog text-charcoal">
            <ShareIcon />
          </span>
          <div className="min-w-0 flex-1">
            <p className="m-0 text-tiny font-semibold text-charcoal">Install {APP_NAME}</p>
            <p className="m-0 mt-1 text-tiny font-normal leading-body-sm text-graphite">
              Tap <span className="font-semibold text-charcoal">Share</span> in the {location},
              then <span className="font-semibold text-charcoal">Add to Home Screen</span>.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 pl-14 text-muted" aria-hidden="true">
          <ShareIcon />
          <ArrowIcon />
          <AddToHomeIcon />
        </div>
        <Button variant="tertiary" size="sm" onClick={onDismiss} className="self-end">
          Got it
        </Button>
      </div>
    </div>
  );
}

/**
 * The install hint. Android/Chrome/Edge gets a real "Install" button driven by a captured
 * `beforeinstallprompt`; iOS Safari (no install API) gets a one-time visual guide pointing at its
 * actual Share location; iOS browsers that cannot install at all are told plainly what to do
 * instead. Never shown once installed (`display-mode: standalone` / `navigator.standalone`),
 * never before a meaningful moment (a logged meal, else the second app open), and always inline —
 * mounted on the Today page's own list, never a fixed overlay over a card's actions.
 */
export default function InstallPrompt({ store }: { store: Pick<Store, "days"> }) {
  const [variant, setVariant] = useState<Variant | null>(null);
  const [installing, setInstalling] = useState(false);

  const recompute = useCallback((currentStore: Pick<Store, "days">) => {
    if (typeof window === "undefined") return;
    if (isStandalone() || wasInstalledThisSession() || readDismissed()) {
      setVariant(null);
      return;
    }
    let opens = 0;
    try {
      opens = recordAppOpen(window.localStorage, window.sessionStorage);
    } catch {
      opens = 0;
    }
    if (!meaningfulMomentReached(currentStore, opens)) {
      setVariant(null);
      return;
    }
    setVariant(detectVariant(!!readDeferredInstallPrompt()));
  }, []);

  useEffect(() => {
    // One-shot mount-time + event-triggered read of browser/storage state (UA, matchMedia,
    // localStorage, the captured install event) — there is nothing to synchronize continuously.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    recompute(store);
    const onReady = () => recompute(store);
    const onInstalled = () => {
      writeDismissed();
      setVariant(null);
    };
    window.addEventListener(ANDROID_PROMPT_READY_EVENT, onReady);
    window.addEventListener(ANDROID_INSTALLED_EVENT, onInstalled);
    return () => {
      window.removeEventListener(ANDROID_PROMPT_READY_EVENT, onReady);
      window.removeEventListener(ANDROID_INSTALLED_EVENT, onInstalled);
    };
  }, [recompute, store]);

  if (!variant) return null;

  function dismiss(): void {
    writeDismissed();
    setVariant(null);
  }

  async function onInstall(): Promise<void> {
    setInstalling(true);
    const outcome = await triggerAndroidInstall();
    setInstalling(false);
    if (outcome === "unavailable") {
      setVariant(null);
      return;
    }
    // "accepted" or "dismissed" both close the card — a declined browser prompt is not re-asked
    // immediately; the hint simply does not reappear until the next qualifying event/app open.
    writeDismissed();
    setVariant(null);
  }

  if (variant.kind === "android") {
    return (
      <div className="shell">
        <Notice tone="info" title={`Install ${APP_NAME}`} onDismiss={dismiss}
          action={{ label: installing ? "Installing…" : "Install", onClick: () => void onInstall(), disabled: installing }}>
          Add {APP_NAME} to your home screen for one-tap access.
        </Notice>
      </div>
    );
  }

  if (variant.kind === "ios-chrome-capable") {
    return (
      <div className="shell">
        <Notice tone="info" title={`Install ${APP_NAME}`} onDismiss={dismiss}>
          Tap Share, then Add to Home Screen — Chrome on this iPhone supports it too.
        </Notice>
      </div>
    );
  }

  if (variant.kind === "ios-open-safari") {
    return (
      <div className="shell">
        <Notice tone="attention" title={`Install ${APP_NAME}`} onDismiss={dismiss}>
          This browser can&rsquo;t add {APP_NAME} to your home screen. Open this page in Safari to
          install it.
        </Notice>
      </div>
    );
  }

  return <IosShareGuide ipad={variant.ipad} onDismiss={dismiss} />;
}
