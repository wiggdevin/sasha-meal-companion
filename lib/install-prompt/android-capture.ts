"use client";

/**
 * Android/Chrome/Edge install capture. `beforeinstallprompt` fires once per page load when the
 * browser decides the app is installable, and a browser never replays it to a listener attached
 * later — so this listener is attached as early as the root layout mounts (`InstallPromptCapture`),
 * well before the Today page's visible card exists to react to it. The captured event is kept here,
 * module-scoped, and the visible card reads it (and is told to re-check via the two events below).
 */

export type BeforeInstallPromptChoice = { outcome: "accepted" | "dismissed"; platform: string };

export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<BeforeInstallPromptChoice>;
}

/** Fired once a deferred prompt is ready to show. */
export const ANDROID_PROMPT_READY_EVENT = "meal-companion:android-install-ready";
/** Fired once the browser reports the app was installed. */
export const ANDROID_INSTALLED_EVENT = "meal-companion:android-installed";

let deferred: BeforeInstallPromptEvent | null = null;
let installed = false;
let attached = false;

function onBeforeInstallPrompt(event: Event): void {
  // Keep the event instead of letting the browser show its own mini-infobar — the app's own
  // "Install" card drives it instead (requirement 1).
  event.preventDefault();
  deferred = event as BeforeInstallPromptEvent;
  window.dispatchEvent(new Event(ANDROID_PROMPT_READY_EVENT));
}

function onAppInstalled(): void {
  installed = true;
  deferred = null;
  window.dispatchEvent(new Event(ANDROID_INSTALLED_EVENT));
}

export function attachAndroidInstallCapture(): void {
  if (attached || typeof window === "undefined") return;
  attached = true;
  window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
  window.addEventListener("appinstalled", onAppInstalled);
}

export function readDeferredInstallPrompt(): BeforeInstallPromptEvent | null {
  return deferred;
}

export function wasInstalledThisSession(): boolean {
  return installed;
}

/**
 * Fires the captured prompt and reads `userChoice`. A missing deferred event (never captured,
 * already used, or already installed) answers `"unavailable"` rather than throwing — the card
 * treats that the same as dismissed. A rejected `prompt()` or `userChoice` (Sol review, 2026-10-08,
 * BLOCK: the button was left stuck on "Installing…") answers `"error"` instead of throwing, so the
 * caller never has to guess whether it is safe to re-render.
 */
export async function triggerAndroidInstall(): Promise<"accepted" | "dismissed" | "unavailable" | "error"> {
  const event = deferred;
  if (!event) return "unavailable";
  deferred = null;
  try {
    await event.prompt();
    const choice = await event.userChoice;
    return choice.outcome;
  } catch {
    return "error";
  }
}

/** Test-only: resets module state between specs. */
export function __resetAndroidInstallCaptureForTests(): void {
  if (attached && typeof window !== "undefined") {
    window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.removeEventListener("appinstalled", onAppInstalled);
  }
  attached = false;
  deferred = null;
  installed = false;
}
