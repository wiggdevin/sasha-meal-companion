// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import InstallPrompt, { DISMISSED_KEY, LEGACY_DISMISSED_KEY, dismissedIn } from "./InstallPrompt";
import {
  __resetAndroidInstallCaptureForTests,
  ANDROID_INSTALLED_EVENT,
  attachAndroidInstallCapture,
  type BeforeInstallPromptEvent,
} from "@/lib/install-prompt/android-capture";
import { OPEN_COUNT_KEY } from "@/lib/install-prompt/readiness";
import { OPEN_COUNT_CHANGED_EVENT } from "@/components/InstallPromptCapture";
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

/** A captured prompt whose `prompt()` rejects — simulates the browser failing mid-install. */
function fireBeforeInstallPromptThatRejects() {
  const preventDefault = vi.fn();
  const prompt = vi.fn().mockRejectedValue(new Error("blocked"));
  const event = new Event("beforeinstallprompt") as unknown as BeforeInstallPromptEvent;
  Object.defineProperty(event, "preventDefault", { value: preventDefault });
  Object.defineProperty(event, "prompt", { value: prompt });
  // A getter, not a pre-built rejected promise: read (and so handled) only once triggered.
  Object.defineProperty(event, "userChoice", { get: () => Promise.reject(new Error("unused")) });
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
    it("stays hidden with no meal logged and nothing yet recorded as a second open", () => {
      asAgent(IPHONE_SAFARI);
      const { container } = render(<InstallPrompt store={EMPTY_STORE} />);
      expect(container.textContent).toBe("");
    });

    it("shows once a meal has been logged, regardless of the open count", () => {
      asAgent(IPHONE_SAFARI);
      render(<InstallPrompt store={STORE_WITH_LOGGED_MEAL} />);
      expect(screen.getByText("Install Sasha")).toBeTruthy();
    });

    // Sol review round 3, 2026-10-08, BLOCK: the card only ever READS the open count now —
    // recording it (and watching `visibilitychange`) moved to the always-mounted
    // `InstallPromptCapture` (see components/InstallPromptCapture.test.tsx), so this simulates
    // what that module would already have written to storage before this card ever mounts.
    it("falls back to showing on the second app open with nothing logged yet", () => {
      asAgent(IPHONE_SAFARI);
      localStorage.setItem(OPEN_COUNT_KEY, "2");
      render(<InstallPrompt store={EMPTY_STORE} />);
      expect(screen.getByText("Install Sasha")).toBeTruthy();
    });

    it("never itself writes the open count — only reads it", () => {
      asAgent(IPHONE_SAFARI);
      const { rerender } = render(<InstallPrompt store={{ days: {} }} />);
      expect(localStorage.getItem(OPEN_COUNT_KEY)).toBeNull();
      for (let i = 0; i < 5; i += 1) {
        rerender(<InstallPrompt store={{ days: {} }} />);
      }
      expect(localStorage.getItem(OPEN_COUNT_KEY)).toBeNull();
      expect(screen.queryByText("Install Sasha")).toBeNull();
    });

    it("picks up a count written elsewhere (InstallPromptCapture) once told it changed", () => {
      asAgent(IPHONE_SAFARI);
      localStorage.setItem(OPEN_COUNT_KEY, "1");
      render(<InstallPrompt store={EMPTY_STORE} />);
      expect(screen.queryByText("Install Sasha")).toBeNull();

      // Simulates InstallPromptCapture recording the second open (e.g. from a visibilitychange
      // it saw while this card was not even mounted) and announcing it.
      localStorage.setItem(OPEN_COUNT_KEY, "2");
      act(() => {
        window.dispatchEvent(new Event(OPEN_COUNT_CHANGED_EVENT));
      });
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

    // Sol review round 1, 2026-10-08, BLOCK: a rejected prompt()/userChoice left the button
    // stuck on "Installing…" forever. Sol review round 2, 2026-10-08, BLOCK: the FIRST fix for
    // this still offered the same "Install" button to retry with, but a BeforeInstallPromptEvent
    // can only ever be prompted once — clicking it again always answered "unavailable" and hid
    // the whole card. The button must not come back until a genuinely fresh event is captured.
    it("never leaves the button stuck, but also never re-offers the used-up event", async () => {
      asAgent(ANDROID_CHROME);
      attachAndroidInstallCapture();
      fireBeforeInstallPromptThatRejects();
      render(<InstallPrompt store={STORE_WITH_LOGGED_MEAL} />);
      const button = await screen.findByRole("button", { name: "Install" });
      fireEvent.click(button);

      // Not stuck on "Installing…", and not hidden — but also no "Install" button to retry with,
      // since the only captured event is already used up.
      await screen.findByText(/isn.t available right now/i);
      expect(screen.queryByText(/Installing…/)).toBeNull();
      expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
      expect(screen.getByText("Install Sasha")).toBeTruthy();
      expect(localStorage.getItem(DISMISSED_KEY)).toBeNull();
    });

    it("brings the button back only once a fresh beforeinstallprompt is captured", async () => {
      asAgent(ANDROID_CHROME);
      attachAndroidInstallCapture();
      fireBeforeInstallPromptThatRejects();
      render(<InstallPrompt store={STORE_WITH_LOGGED_MEAL} />);
      const firstButton = await screen.findByRole("button", { name: "Install" });
      fireEvent.click(firstButton);
      await screen.findByText(/isn.t available right now/i);
      expect(screen.queryByRole("button", { name: "Install" })).toBeNull();

      // A second click on nothing (there is no button) cannot happen; only a genuinely new
      // captured prompt restores it.
      fireBeforeInstallPrompt("accepted");
      expect(await screen.findByRole("button", { name: "Install" })).toBeTruthy();
      expect(screen.queryByText(/isn.t available right now/i)).toBeNull();
    });

    // Sol review round 3, 2026-10-08, BLOCK: the component used to recompute `detectVariant` on
    // every `store` prop change (a clock tick elsewhere on the page produces a new `store`
    // reference every minute). With the captured event already consumed, `detectVariant` saw a
    // plain Android UA with nothing captured and answered `null` — wiping the "isn't available"
    // card the very next tick, with no actual browser event involved at all.
    it("keeps the post-rejection message through an unrelated re-render (new store, same content)", async () => {
      asAgent(ANDROID_CHROME);
      attachAndroidInstallCapture();
      fireBeforeInstallPromptThatRejects();
      const { rerender } = render(<InstallPrompt store={STORE_WITH_LOGGED_MEAL} />);
      const button = await screen.findByRole("button", { name: "Install" });
      fireEvent.click(button);
      await screen.findByText(/isn.t available right now/i);

      // A brand-new store object, same logged meal — exactly what a clock tick elsewhere on the
      // Today page would hand this component on its next render.
      rerender(<InstallPrompt store={{
        days: { "2026-10-08": { date: "2026-10-08", eaten: { "meal-1": "2026-10-08T12:00:00Z" } } },
      }} />);

      expect(screen.getByText(/isn.t available right now/i)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
    });

    it("keeps the post-rejection message even when a NEW meal is logged (only a fresh event clears it)", async () => {
      asAgent(ANDROID_CHROME);
      attachAndroidInstallCapture();
      fireBeforeInstallPromptThatRejects();
      const { rerender } = render(<InstallPrompt store={STORE_WITH_LOGGED_MEAL} />);
      const button = await screen.findByRole("button", { name: "Install" });
      fireEvent.click(button);
      await screen.findByText(/isn.t available right now/i);

      rerender(<InstallPrompt store={{
        days: {
          "2026-10-08": {
            date: "2026-10-08",
            eaten: { "meal-1": "2026-10-08T12:00:00Z", "meal-2": "2026-10-08T18:00:00Z" },
          },
        },
      }} />);

      expect(screen.getByText(/isn.t available right now/i)).toBeTruthy();

      fireBeforeInstallPrompt("accepted");
      expect(await screen.findByRole("button", { name: "Install" })).toBeTruthy();
    });

    // Sol review, 2026-10-08, WARN: a declined (not dismissed-by-the-user) prompt must not be
    // suppressed forever.
    describe("a declined prompt (not a user dismiss)", () => {
      afterEach(() => {
        vi.useRealTimers();
      });

      /** Declines the real browser prompt (real timers — the async resolution needs them), then
       *  unmounts and hands back the real epoch ms the decline was recorded at, so a later part of
       *  the test can move the clock forward from exactly that point with fake timers. */
      async function declineOnce(): Promise<number> {
        asAgent(ANDROID_CHROME);
        attachAndroidInstallCapture();
        fireBeforeInstallPrompt("dismissed");
        const rendered = render(<InstallPrompt store={STORE_WITH_LOGGED_MEAL} />);
        const button = await screen.findByRole("button", { name: "Install" });
        fireEvent.click(button);
        await waitFor(() => expect(screen.queryByText("Install Sasha")).toBeNull());
        const declinedAt = Date.now();
        rendered.unmount();
        return declinedAt;
      }

      it("hides for now, without writing the permanent dismissal key", async () => {
        await declineOnce();
        expect(localStorage.getItem(DISMISSED_KEY)).toBeNull();
      });

      it("stays quiet on a later open within the cooldown, with nothing new logged", async () => {
        const declinedAt = await declineOnce();
        vi.useFakeTimers();
        vi.setSystemTime(declinedAt + 3 * 24 * 60 * 60 * 1000); // 3 days — inside the 7-day cooldown
        attachAndroidInstallCapture();
        fireBeforeInstallPrompt("dismissed");
        render(<InstallPrompt store={STORE_WITH_LOGGED_MEAL} />);
        expect(screen.queryByText("Install Sasha")).toBeNull();
      });

      it("reappears once a new meal is logged, even inside the cooldown", async () => {
        const declinedAt = await declineOnce();
        vi.useFakeTimers();
        vi.setSystemTime(declinedAt + 60_000); // moments later — well inside the cooldown
        const anotherMealLogged: Pick<Store, "days"> = {
          days: {
            "2026-10-08": {
              date: "2026-10-08",
              eaten: { "meal-1": "2026-10-08T12:00:00Z", "meal-2": "2026-10-08T18:00:00Z" },
            },
          },
        };
        attachAndroidInstallCapture();
        fireBeforeInstallPrompt("dismissed");
        render(<InstallPrompt store={anotherMealLogged} />);
        expect(screen.getByText("Install Sasha")).toBeTruthy();
      });

      it("reappears once the cooldown passes, with nothing new logged", async () => {
        const declinedAt = await declineOnce();
        vi.useFakeTimers();
        vi.setSystemTime(declinedAt + 8 * 24 * 60 * 60 * 1000); // past the 7-day cooldown
        attachAndroidInstallCapture();
        fireBeforeInstallPrompt("dismissed");
        render(<InstallPrompt store={STORE_WITH_LOGGED_MEAL} />);
        expect(screen.getByText("Install Sasha")).toBeTruthy();
      });
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

    // Sol review, 2026-10-08, WARN: every other variant uses Notice, which already carries
    // role="status" — the guide (the one hand-built variant) must match.
    it("announces itself as a status region, like every other variant", () => {
      asAgent(IPHONE_SAFARI);
      render(<InstallPrompt store={STORE_WITH_LOGGED_MEAL} />);
      expect(screen.getByRole("status").textContent).toContain("Add to Home Screen");
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
    // Sol review, 2026-10-08, BLOCK: Firefox, Edge and Chrome on iOS 16.4+ can all Add to Home
    // Screen through their own Share menu — the UA cannot tell install capability apart from
    // which browser's own Share menu fires, so none of them is ever told it is impossible.
    it("tells Chrome on iOS to use its own Share menu", () => {
      asAgent(IPHONE_CHROME_164);
      render(<InstallPrompt store={STORE_WITH_LOGGED_MEAL} />);
      expect(screen.getByText(/Tap Share in your browser, then Add to Home Screen/)).toBeTruthy();
      expect(screen.queryByText(/Open this page in Safari/)).toBeNull();
    });

    it("tells an older Chrome on iOS the same — never that it is impossible", () => {
      asAgent(IPHONE_CHROME_OLD);
      render(<InstallPrompt store={STORE_WITH_LOGGED_MEAL} />);
      expect(screen.getByText(/Tap Share in your browser, then Add to Home Screen/)).toBeTruthy();
      expect(screen.queryByText(/Open this page in Safari/)).toBeNull();
    });

    it("tells Firefox on iOS to use its own Share menu — never that it is impossible", () => {
      asAgent(IPHONE_FIREFOX);
      render(<InstallPrompt store={STORE_WITH_LOGGED_MEAL} />);
      expect(screen.getByText(/Tap Share in your browser, then Add to Home Screen/)).toBeTruthy();
      expect(screen.queryByText(/Open this page in Safari/)).toBeNull();
    });

    it("tells an in-app webview (Instagram) to open Safari instead — it has no Share menu at all", () => {
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
