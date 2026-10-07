// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import TabBar from "@/components/TabBar";
import type { SpeechHandlers } from "@/lib/coach/speech-api";

/**
 * Grok audit 2026-10-02, finding 5: weightUnit was read once when the persistent dock mounted, so
 * a kg/lb change made in Settings was ignored until the dock remounted; and `weighing` was never
 * cleared when the field itself closed, so the popover could outlive it.
 */

vi.mock("@/lib/coach/speech-api", () => ({
  micAvailable: () => true,
  startListening: (_handlers: SpeechHandlers) => ({ stop: vi.fn(), abort: vi.fn() }),
}));

const nav = vi.hoisted(() => ({ path: "/coach" }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.path,
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/components/CapabilitiesProvider", () => ({
  useCapabilities: () => ({ coach: true, scan: true, captureMethods: ["photo"] }),
}));

const store = vi.hoisted(() => ({ weightUnit: "lb" as "lb" | "kg" }));
vi.mock("@/lib/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/store")>(),
  loadStore: () => ({ settings: { weightUnit: store.weightUnit } }),
}));

afterEach(() => {
  cleanup();
  nav.path = "/coach";
  store.weightUnit = "lb";
});

const form = () => screen.getByRole("searchbox", { name: "Ask Sasha" }).closest("form")!;

describe("the dock's Weigh-in popover", () => {
  it("reads the preferred weight unit again each time it opens", async () => {
    render(<TabBar />);
    fireEvent.click(screen.getByRole("button", { name: "Attach" }));
    fireEvent.click(screen.getByRole("button", { name: "Weigh in" }));
    expect(screen.getByRole("textbox", { name: "Weight in lb" })).toBeTruthy();

    // Close the popover (Escape, with the tray already folded), change the setting, reopen it.
    fireEvent.keyDown(screen.getByRole("searchbox", { name: "Ask Sasha" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("textbox", { name: /Weight in/ })).toBeNull());
    store.weightUnit = "kg";
    fireEvent.click(screen.getByRole("button", { name: "Attach" }));
    fireEvent.click(screen.getByRole("button", { name: "Weigh in" }));
    expect(screen.getByRole("textbox", { name: "Weight in kg" })).toBeTruthy();
  });

  it("closes the weigh-in popover when the field itself folds back to a bubble", async () => {
    nav.path = "/";
    render(<TabBar />);
    fireEvent.click(screen.getByRole("button", { name: "Ask Sasha" }));
    fireEvent.click(screen.getByRole("button", { name: "Attach" }));
    fireEvent.click(screen.getByRole("button", { name: "Weigh in" }));
    expect(screen.getByRole("textbox", { name: /Weight in/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Show all tabs" }));
    expect(form().hasAttribute("inert")).toBe(true);
    await waitFor(() => expect(screen.queryByRole("textbox", { name: /Weight in/ })).toBeNull());
  });

  // U19 (2026-10-04, owner): closing mid-entry keeps the number for next time.
  it("keeps the typed number when the card is closed and opened again", async () => {
    render(<TabBar />);
    fireEvent.click(screen.getByRole("button", { name: "Attach" }));
    fireEvent.click(screen.getByRole("button", { name: "Weigh in" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Weight in lb" }), { target: { value: "181.4" } });
    fireEvent.click(screen.getByRole("button", { name: "Close weigh-in" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Attach" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: /Weight in/ })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Attach" }));
    fireEvent.click(screen.getByRole("button", { name: "Weigh in" }));
    expect((screen.getByRole("textbox", { name: "Weight in lb" }) as HTMLInputElement).value).toBe("181.4");
  });

  // Grok audit 2026-10-02 (final round): folding hid the popover but kept `weighing` (and the
  // tray) set, so the next opening sprang straight back into them.
  it("opens fresh after a fold: no weigh-in and no tray left over", async () => {
    nav.path = "/";
    render(<TabBar />);
    fireEvent.click(screen.getByRole("button", { name: "Ask Sasha" }));
    fireEvent.click(screen.getByRole("button", { name: "Attach" }));
    fireEvent.click(screen.getByRole("button", { name: "Weigh in" }));
    fireEvent.click(screen.getByRole("button", { name: "Show all tabs" }));
    fireEvent.click(screen.getByRole("button", { name: "Ask Sasha" }));
    // The card that was open folds away on its spring; it is not opened again.
    await waitFor(() => expect(screen.queryByRole("textbox", { name: /Weight in/ })).toBeNull());
    expect(screen.getByRole("button", { name: "Attach" }).getAttribute("aria-expanded")).toBe("false");
  });
});

