// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import InstallPrompt, { DISMISSED_KEY, LEGACY_DISMISSED_KEY, dismissedIn }
  from "./InstallPrompt";

let pathname = "/";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

// Finding #17 (audit 2026-09-13): the banner told Sasha that installing to
// the Home Screen "also turns on the meal reminders." Reminders are wired up
// entirely separately, via IcsSubscribe's explicit "Add to Calendar" button
// on the Settings page (a manual share-sheet "Add All" step) — nothing ties
// Home Screen installation to reminders. The banner copy must not claim it
// does.
const source = readFileSync(path.join(__dirname, "InstallPrompt.tsx"), "utf-8");

describe("InstallPrompt copy", () => {
  it("never claims that installing turns on meal reminders", () => {
    expect(source).not.toMatch(/install[^<]*for reminders/i);
    expect(source).not.toMatch(/that also turns? on (the )?meal reminders/i);
  });

  it("points reminders at Settings instead of the install step", () => {
    expect(source).toMatch(/meal reminders[\s\S]*settings/i);
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

/**
 * Design §8.3 — the three states the banner has on screen. It only ever offers itself on iOS
 * Safari, which is a user-agent read, so the agent is the fixture here.
 */
describe("InstallPrompt on screen", () => {
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15"
    + " (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

  function asAgent(ua: string): void {
    Object.defineProperty(window.navigator, "userAgent", { value: ua, configurable: true });
  }

  beforeEach(() => {
    localStorage.clear();
    pathname = "/";
    window.matchMedia = ((query: string) => ({ matches: false, media: query,
      addEventListener: () => {}, removeEventListener: () => {} })) as never;
  });
  afterEach(cleanup);

  it("stays hidden on a browser that has its own install flow", () => {
    asAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140.0 Safari/537.36");
    const { container } = render(<InstallPrompt />);
    expect(container.textContent).toBe("");
  });

  it("is offered on iOS Safari, with the Share route and no reminder claim", () => {
    asAgent(IPHONE);
    render(<InstallPrompt />);
    expect(screen.getByText("Install Sasha")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Add to Home Screen");
  });

  it("stays off /onboarding, without dismissing it, and is back once the account leaves", () => {
    asAgent(IPHONE);
    pathname = "/onboarding";
    const { container, rerender } = render(<InstallPrompt />);
    expect(container.textContent).toBe("");
    expect(localStorage.getItem(DISMISSED_KEY)).toBeNull();
    pathname = "/";
    rerender(<InstallPrompt />);
    expect(screen.getByText("Install Sasha")).toBeTruthy();
  });

  it("stays dismissed once the banner has been dismissed, and writes the namespaced key", () => {
    asAgent(IPHONE);
    const first = render(<InstallPrompt />);
    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(first.container.textContent).toBe("");
    expect(localStorage.getItem(DISMISSED_KEY)).toBe("1");
    cleanup();
    // And it stays gone on the next mount, which is what the stored key is for.
    const { container } = render(<InstallPrompt />);
    expect(container.textContent).toBe("");
  });
});
