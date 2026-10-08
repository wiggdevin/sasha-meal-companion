// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import InstallPromptCapture, { OPEN_COUNT_CHANGED_EVENT } from "./InstallPromptCapture";
import {
  __resetAndroidInstallCaptureForTests,
  readDeferredInstallPrompt,
} from "@/lib/install-prompt/android-capture";
import { OPEN_COUNT_KEY, __resetPageOpenTrackingForTests } from "@/lib/install-prompt/readiness";

/**
 * Sol review round 3, 2026-10-08, BLOCK: open and visibility tracking used to live in the inline
 * install card, which only mounts on today's Today view — a visibility change on any other route
 * or date was silently missed. Both now live here, in the layout-mounted capture, which is never
 * conditionally rendered.
 */
describe("InstallPromptCapture", () => {
  beforeEach(() => {
    localStorage.clear();
    __resetAndroidInstallCaptureForTests();
    __resetPageOpenTrackingForTests();
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });
  afterEach(() => {
    cleanup();
    __resetAndroidInstallCaptureForTests();
    __resetPageOpenTrackingForTests();
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    vi.useRealTimers();
  });

  function setVisibility(state: DocumentVisibilityState): void {
    Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
  }

  it("records exactly one open per mount", () => {
    render(<InstallPromptCapture />);
    expect(localStorage.getItem(OPEN_COUNT_KEY)).toBe("1");
  });

  it("attaches the beforeinstallprompt capture so the event is never missed", () => {
    render(<InstallPromptCapture />);
    const event = new Event("beforeinstallprompt");
    Object.defineProperty(event, "preventDefault", { value: () => {} });
    Object.defineProperty(event, "prompt", { value: () => Promise.resolve() });
    Object.defineProperty(event, "userChoice", { value: Promise.resolve({ outcome: "accepted", platform: "web" }) });
    window.dispatchEvent(event);
    expect(readDeferredInstallPrompt()).not.toBeNull();
  });

  it("announces the recorded open via the change event", () => {
    const onChanged = vi.fn();
    window.addEventListener(OPEN_COUNT_CHANGED_EVENT, onChanged);
    render(<InstallPromptCapture />);
    expect(onChanged).toHaveBeenCalledOnce();
    window.removeEventListener(OPEN_COUNT_CHANGED_EVENT, onChanged);
  });

  it("never records more than once within the same page load, however many times it remounts", () => {
    const { unmount } = render(<InstallPromptCapture />);
    expect(localStorage.getItem(OPEN_COUNT_KEY)).toBe("1");
    unmount();
    render(<InstallPromptCapture />);
    render(<InstallPromptCapture />);
    expect(localStorage.getItem(OPEN_COUNT_KEY)).toBe("1");
  });

  it("counts a reopen once hidden for at least 30 minutes, and announces it", () => {
    vi.useFakeTimers();
    render(<InstallPromptCapture />);
    expect(localStorage.getItem(OPEN_COUNT_KEY)).toBe("1");

    const onChanged = vi.fn();
    window.addEventListener(OPEN_COUNT_CHANGED_EVENT, onChanged);
    setVisibility("hidden");
    vi.advanceTimersByTime(31 * 60 * 1000);
    setVisibility("visible");

    expect(localStorage.getItem(OPEN_COUNT_KEY)).toBe("2");
    expect(onChanged).toHaveBeenCalledOnce();
    window.removeEventListener(OPEN_COUNT_CHANGED_EVENT, onChanged);
  });

  it("does not count a brief tab-switch under 30 minutes", () => {
    vi.useFakeTimers();
    render(<InstallPromptCapture />);
    expect(localStorage.getItem(OPEN_COUNT_KEY)).toBe("1");

    setVisibility("hidden");
    vi.advanceTimersByTime(5 * 60 * 1000);
    setVisibility("visible");

    expect(localStorage.getItem(OPEN_COUNT_KEY)).toBe("1");
  });

  // The whole point of this module: tracking runs independent of any route or viewed date, since
  // nothing here depends on props at all — it is mounted once from the root layout and stays
  // mounted no matter what page or date is on screen.
  it("tracks visibility with no dependency on any route or viewed date (it takes no props)", () => {
    vi.useFakeTimers();
    render(<InstallPromptCapture />);
    setVisibility("hidden");
    vi.advanceTimersByTime(45 * 60 * 1000);
    setVisibility("visible");
    expect(localStorage.getItem(OPEN_COUNT_KEY)).toBe("2");
  });

  it("renders nothing visible", () => {
    const { container } = render(<InstallPromptCapture />);
    expect(container.textContent).toBe("");
  });
});
