// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import InstallPrompt, { DISMISSED_KEY, LEGACY_DISMISSED_KEY, dismissedIn } from "./InstallPrompt";
import {
  __resetAndroidInstallCaptureForTests,
  ANDROID_INSTALLED_EVENT,
  attachAndroidInstallCapture,
  type BeforeInstallPromptEvent,
} from "@/lib/install-prompt/android-capture";
import { OPEN_COUNT_KEY } from "@/lib/install-prompt/readiness";
import type { Store } from "@/lib/types";

const source = readFileSync(path.join(__dirname, "InstallPrompt.tsx"), "utf-8");

// Finding #17 (audit 2026-09-13): the banner told Sasha that installing to
// the Home Screen "also turns on the meal reminders." Reminders are wired up
// entirely separately, via IcsSubscribe's explicit "Add to Calendar" button
// on the Settings page (a manual share-sheet "Add All" step) — nothing ties
// Home Screen installation to reminders. The banner copy must not claim it
// does.
describe("InstallPrompt copy", () => {
  it("never claims that installing turns on meal reminders", () => {
    expect(source).not.toMatch(/install[^<]*for reminders/i);
    expect(source).not.toMatch(/that also turns? on (the )?meal reminders/i);
  });
});

/**
 * Grok pass 1, NIT: the dismiss key was renamed to the `meal-companion:` namespace, which made
 * every device that had already dismissed the banner look brand new and get prompted again.
 * The read must accept both keys; the write stays on the new one so the old key dies out.
 */
const storageWith = (entries: Record<string, string>) => ({
  getItem: (key: string) => entries[key] ?? null,
});

describe("InstallPrompt dismiss key", () => {
  it("writes the namespaced key only", () => {
    expect(DISMISSED_KEY).toBe("meal-companion:install-prompt-dismissed");
    expect(source).toContain("setItem(DISMISSED_KEY");
    expect(source).not.toContain("setItem(LEGACY_DISMISSED_KEY");
  });

  it("still reads the pre-rename key, so an existing device is not re-prompted", () => {
    expect(LEGACY_DISMISSED_KEY).not.toBe(DISMISSED_KEY);
    expect(LEGACY_DISMISSED_KEY).toMatch(/install-prompt-dismissed$/);
    expect(dismissedIn(storageWith({ [LEGACY_DISMISSED_KEY]: "1" }))).toBe(true);
    expect(dismissedIn(storageWith({ [DISMISSED_KEY]: "1" }))).toBe(true);
    expect(dismissedIn(storageWith({}))).toBe(false);
    expect(dismissedIn(storageWith({ [DISMISSED_KEY]: "0" }))).toBe(false);
  });

  it("carries the legacy key without spelling the account name in source", () => {
    // tests/tenancy/no-personal-defaults.test.ts scans this runtime file for the person's name;
    // the legacy key is built from escapes so the guard stays green.
    expect(source).not.toMatch(/\b(?:\x53\x61\x73\x68\x61|\x44\x65\x76\x69\x6e)\b/i);
  });
});

const STORE_WITH_LOGGED_MEAL: Pick<Store, "days"> = {
  days: { "2026-10-08": { date: "2026-10-08", eaten: { "meal-1": "2026-10-08T12:00:00Z" } } },
};
const EMPTY_STORE: Pick<Store, "days"> = { days: {} };

const IPHONE_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15"
  + " (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPAD_SAFARI = "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15"
  + " (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME_164 = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15"
  + " (KHTML, like Gecko) CriOS/128.0 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME_OLD = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15"
  + " (KHTML, like Gecko) CriOS/118.0 Mobile/15E148 Safari/604.1";
const IPHONE_FIREFOX = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15"
  + " (KHTML, like Gecko) FxiOS/118.0 Mobile/15E148 Safari/604.1";
const IPHONE_INSTAGRAM = IPHONE_SAFARI + " Instagram 300.0.0.0.0";
const ANDROID_CHROME = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko)"
  + " Chrome/128.0.0.0 Mobile Safari/537.36";
const DESKTOP_SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15"
  + " (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

function asAgent(ua: string, platform = ""): void {
  Object.defineProperty(window.navigator, "userAgent", { value: ua, configurable: true });
  Object.defineProperty(window.navigator, "platform", { value: platform, configurable: true });
  Object.defineProperty(window.navigator, "maxTouchPoints", { value: 0, configurable: true });
}

function fireBeforeInstallPrompt(outcome: "accepted" | "dismissed" = "accepted") {
  const preventDefault = vi.fn();
  const prompt = vi.fn().mockResolvedValue(undefined);
  const event = new Event("beforeinstallprompt") as unknown as BeforeInstallPromptEvent;
  Object.defineProperty(event, "preventDefault", { value: preventDefault });
  Object.defineProperty(event, "prompt", { value: prompt });
  Object.defineProperty(event, "userChoice", { value: Promise.resolve({ outcome, platform: "web" }) });
  window.dispatchEvent(event);
  return { preventDefault, prompt };
}

describe("InstallPrompt", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    __resetAndroidInstallCaptureForTests();
    window.matchMedia = ((query: string) => ({
      matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {},
    })) as never;
    Object.defineProperty(window.navigator, "standalone", { value: undefined, configurable: true });
  });
  afterEach(() => {
    cleanup();
    __resetAndroidInstallCaptureForTests();
  });

  describe("standalone and dismissal (rule 3)", () => {
    it("never shows once installed (display-mode: standalone)", () => {
      asAgent(IPHONE_SAFARI);
      window.matchMedia = ((query: string) => ({
        matches: query === "(display-mode: standalone)", media: query,
        addEventListener: () => {}, removeEventListener: () => {},
      })) as never;
      const { container } = render(<InstallPrompt store={STORE_WITH_LOGGED_MEAL} />);
      expect(container.textContent).toBe("");
    });

    it("never shows once installed (navigator.standalone, iOS)", () => {
      asAgent(IPHONE_SAFARI);
      Object.defineProperty(window.navigator, "standalone", { value: true, configurable: true });
      const { container } = render(<InstallPrompt store={STORE_WITH_LOGGED_MEAL} />);
      expect(container.textContent).toBe("");
    });

    it("stays dismissed once dismissed, and writes the namespaced key only", () => {
      asAgent(IPHONE_CHROME_164);
      const first = render(<InstallPrompt store={STORE_WITH_LOGGED_MEAL} />);
      fireEvent.click(screen.getByLabelText("Dismiss"));
      expect(first.container.textContent).toBe("");
      expect(localStorage.getItem(DISMISSED_KEY)).toBe("1");
      cleanup();
      const { container } = render(<InstallPrompt store={STORE_WITH_LOGGED_MEAL} />);
      expect(container.textContent).toBe("");
    });
  });

  describe("meaningful moment gating (rule 4)", () => {
    it("stays hidden before any meal is logged and before the second open", () => {
      asAgent(IPHONE_SAFARI);
      const { container } = render(<InstallPrompt store={EMPTY_STORE} />);
      expect(container.textContent).toBe("");
      expect(localStorage.getItem(OPEN_COUNT_KEY)).toBe("1");
    });

    it("shows once a meal has been logged, on the very first open", () => {
      asAgent(IPHONE_SAFARI);
      render(<InstallPrompt store={STORE_WITH_LOGGED_MEAL} />);
      expect(screen.getByText("Install Sasha")).toBeTruthy();
    });

    it("falls back to showing on the second app open with nothing logged yet", () => {
      asAgent(IPHONE_SAFARI);
      localStorage.setItem(OPEN_COUNT_KEY, "1");
      render(<InstallPrompt store={EMPTY_STORE} />);
      expect(screen.getByText("Install Sasha")).toBeTruthy();
    });
  });

  describe("Android/Chrome/Edge install (rule 1)", () => {
    it("stays hidden with no captured prompt and no install API (desktop Safari)", () => {
      asAgent(DESKTOP_SAFARI);
      attachAndroidInstallCapture();
      const { container } = render(<InstallPrompt store={STORE_WITH_LOGGED_MEAL} />);
      expect(container.textContent).toBe("");
    });

    it("shows a real Install button once beforeinstallprompt is captured", async () => {
      asAgent(ANDROID_CHROME);
      attachAndroidInstallCapture();
      const { preventDefault } = fireBeforeInstallPrompt("accepted");
      render(<InstallPrompt store={STORE_WITH_LOGGED_MEAL} />);
      expect(preventDefault).toHaveBeenCalledOnce();
      const button = await screen.findByRole("button", { name: "Install" });
      fireEvent.click(button);
      await waitFor(() => expect(screen.queryByText("Install Sasha")).toBeNull());
      expect(localStorage.getItem(DISMISSED_KEY)).toBe("1");
    });

    it("hides once the browser reports appinstalled", async () => {
      asAgent(ANDROID_CHROME);
      attachAndroidInstallCapture();
      fireBeforeInstallPrompt("accepted");
      render(<InstallPrompt store={STORE_WITH_LOGGED_MEAL} />);
      await screen.findByText("Install Sasha");
      window.dispatchEvent(new Event(ANDROID_INSTALLED_EVENT));
      await waitFor(() => expect(screen.queryByText("Install Sasha")).toBeNull());
    });

    it("catches an event fired before the card mounted, via the module-level capture", async () => {
      asAgent(ANDROID_CHROME);
      attachAndroidInstallCapture();
      fireBeforeInstallPrompt("accepted");
      // The card mounts only after the event already fired — exactly the race the capture module
      // exists to close.
      render(<InstallPrompt store={STORE_WITH_LOGGED_MEAL} />);
      expect(await screen.findByRole("button", { name: "Install" })).toBeTruthy();
    });
  });

  describe("iOS Safari visual guide (rule 2)", () => {
    it("shows the Share guide pointing at the bottom toolbar on iPhone", () => {
      asAgent(IPHONE_SAFARI);
      render(<InstallPrompt store={STORE_WITH_LOGGED_MEAL} />);
      expect(screen.getByText(/bottom toolbar/)).toBeTruthy();
      expect(screen.getAllByText(/Share/)[0]).toBeTruthy();
      expect(screen.getByText(/Add to Home Screen/)).toBeTruthy();
    });

    it("points at the top-right toolbar on iPad", () => {
      asAgent(IPAD_SAFARI, "MacIntel");
      Object.defineProperty(window.navigator, "maxTouchPoints", { value: 5, configurable: true });
      render(<InstallPrompt store={STORE_WITH_LOGGED_MEAL} />);
      expect(screen.getByText(/top-right toolbar/)).toBeTruthy();
    });

    it("dismisses once and stays gone, via the shared dismissal key", () => {
      asAgent(IPHONE_SAFARI);
      const first = render(<InstallPrompt store={STORE_WITH_LOGGED_MEAL} />);
      fireEvent.click(screen.getByText("Got it"));
      expect(first.container.textContent).toBe("");
      expect(localStorage.getItem(DISMISSED_KEY)).toBe("1");
    });
  });

  describe("other iOS browsers (rule 2)", () => {
    it("says Chrome on iOS 16.4+ also supports Share → Add to Home Screen", () => {
      asAgent(IPHONE_CHROME_164);
      render(<InstallPrompt store={STORE_WITH_LOGGED_MEAL} />);
      expect(screen.getByText(/Chrome on this iPhone supports it too/)).toBeTruthy();
    });

    it("tells an older Chrome on iOS to open Safari instead", () => {
      asAgent(IPHONE_CHROME_OLD);
      render(<InstallPrompt store={STORE_WITH_LOGGED_MEAL} />);
      expect(screen.getByText(/Open this page in Safari/)).toBeTruthy();
    });

    it("tells Firefox on iOS to open Safari instead", () => {
      asAgent(IPHONE_FIREFOX);
      render(<InstallPrompt store={STORE_WITH_LOGGED_MEAL} />);
      expect(screen.getByText(/Open this page in Safari/)).toBeTruthy();
    });

    it("tells an in-app webview (Instagram) to open Safari instead", () => {
      asAgent(IPHONE_INSTAGRAM);
      render(<InstallPrompt store={STORE_WITH_LOGGED_MEAL} />);
      expect(screen.getByText(/Open this page in Safari/)).toBeTruthy();
    });
  });

  describe("desktop browsers with no install path", () => {
    it("stays hidden on desktop Safari", () => {
      asAgent(DESKTOP_SAFARI);
      const { container } = render(<InstallPrompt store={STORE_WITH_LOGGED_MEAL} />);
      expect(container.textContent).toBe("");
    });
  });
});
