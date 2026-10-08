// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetAndroidInstallCaptureForTests,
  ANDROID_INSTALLED_EVENT,
  ANDROID_PROMPT_READY_EVENT,
  attachAndroidInstallCapture,
  readDeferredInstallPrompt,
  triggerAndroidInstall,
  wasInstalledThisSession,
  type BeforeInstallPromptEvent,
} from "./android-capture";

function fireBeforeInstallPrompt(choice: "accepted" | "dismissed" = "accepted"): {
  preventDefault: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
} {
  const preventDefault = vi.fn();
  const prompt = vi.fn().mockResolvedValue(undefined);
  const event = new Event("beforeinstallprompt") as unknown as BeforeInstallPromptEvent;
  Object.defineProperty(event, "preventDefault", { value: preventDefault });
  Object.defineProperty(event, "prompt", { value: prompt });
  Object.defineProperty(event, "userChoice", {
    value: Promise.resolve({ outcome: choice, platform: "web" }),
  });
  window.dispatchEvent(event);
  return { preventDefault, prompt };
}

describe("android install capture", () => {
  beforeEach(() => {
    __resetAndroidInstallCaptureForTests();
    attachAndroidInstallCapture();
  });
  afterEach(() => {
    __resetAndroidInstallCaptureForTests();
  });

  it("prevents the browser's own mini-infobar and keeps the event", () => {
    expect(readDeferredInstallPrompt()).toBeNull();
    const { preventDefault } = fireBeforeInstallPrompt();
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(readDeferredInstallPrompt()).not.toBeNull();
  });

  it("announces readiness so a mounted card can react even though it missed the event", () => {
    const onReady = vi.fn();
    window.addEventListener(ANDROID_PROMPT_READY_EVENT, onReady);
    fireBeforeInstallPrompt();
    expect(onReady).toHaveBeenCalledOnce();
    window.removeEventListener(ANDROID_PROMPT_READY_EVENT, onReady);
  });

  it("drives the real prompt and reads userChoice", async () => {
    const { prompt } = fireBeforeInstallPrompt("accepted");
    const outcome = await triggerAndroidInstall();
    expect(prompt).toHaveBeenCalledOnce();
    expect(outcome).toBe("accepted");
    // Used once — a second call has nothing left to fire.
    expect(await triggerAndroidInstall()).toBe("unavailable");
  });

  it("reports a declined prompt as dismissed, not an error", async () => {
    fireBeforeInstallPrompt("dismissed");
    expect(await triggerAndroidInstall()).toBe("dismissed");
  });

  it("answers unavailable when nothing was ever captured", async () => {
    expect(await triggerAndroidInstall()).toBe("unavailable");
  });

  it("marks installed and fires the installed event on appinstalled", () => {
    fireBeforeInstallPrompt();
    expect(wasInstalledThisSession()).toBe(false);
    const onInstalled = vi.fn();
    window.addEventListener(ANDROID_INSTALLED_EVENT, onInstalled);
    window.dispatchEvent(new Event("appinstalled"));
    expect(wasInstalledThisSession()).toBe(true);
    expect(readDeferredInstallPrompt()).toBeNull();
    expect(onInstalled).toHaveBeenCalledOnce();
    window.removeEventListener(ANDROID_INSTALLED_EVENT, onInstalled);
  });

  it("attaches its listeners only once", () => {
    attachAndroidInstallCapture();
    attachAndroidInstallCapture();
    const { preventDefault } = fireBeforeInstallPrompt();
    expect(preventDefault).toHaveBeenCalledOnce();
  });
});
