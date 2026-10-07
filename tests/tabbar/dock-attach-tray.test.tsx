// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import TabBar from "@/components/TabBar";
import type { SpeechHandlers } from "@/lib/coach/speech-api";

/**
 * Grok audit 2026-10-02, finding 4: the dock's Camera and Upload tray tiles never checked
 * capabilities.captureMethods (the deleted page composer's own camera button gated on
 * captureMethods.includes("photo")), and the tray's five tiles laid an icon and a label out
 * side by side in one row, which overflows a 320-390 px phone.
 */

vi.mock("@/lib/coach/speech-api", () => ({
  micAvailable: () => true,
  startListening: (_handlers: SpeechHandlers) => ({ stop: vi.fn(), abort: vi.fn() }),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/coach",
  useRouter: () => ({ push: vi.fn() }),
}));

const capabilities = vi.hoisted(() => ({
  current: { coach: true, scan: true, captureMethods: ["photo"] as string[] },
}));
vi.mock("@/components/CapabilitiesProvider", () => ({
  useCapabilities: () => capabilities.current,
}));

afterEach(() => {
  cleanup();
  capabilities.current = { coach: true, scan: true, captureMethods: ["photo"] };
});

function openTray() {
  render(<TabBar />);
  fireEvent.click(screen.getByRole("button", { name: "Attach" }));
  return within(screen.getByRole("group", { name: "Add to your question" }));
}

describe("the dock's attach tray", () => {
  it("hides Camera and Upload when the server has not enabled photo capture", () => {
    capabilities.current = { coach: true, scan: true, captureMethods: [] };
    const tray = openTray();
    expect(tray.getAllByRole("button").map((button) => button.getAttribute("aria-label")))
      .toEqual(["Weigh in", "Open chat"]);
  });

  it("shows Camera and Upload once photo capture is enabled", () => {
    const tray = openTray();
    expect(tray.getAllByRole("button").map((button) => button.getAttribute("aria-label")))
      .toEqual(["Take a photo", "Upload a photo", "Weigh in", "Open chat"]);
  });

  // U18 (2026-10-04): no Scan tile; the camera reads a barcode out of the photo instead.
  it("offers no Scan tile even when barcode scanning is on", () => {
    const tray = openTray();
    expect(tray.queryByRole("button", { name: "Scan" })).toBeNull();
    const camera = document.querySelector<HTMLInputElement>('input[type="file"][capture]');
    expect(camera?.getAttribute("capture")).toBe("environment");
  });

  it("stacks each tile's icon over its label so the tiles fit a narrow phone", () => {
    const tray = openTray();
    for (const tile of tray.getAllByRole("button")) {
      expect(tile.className.split(/\s+/)).toEqual(expect.arrayContaining(["flex-col"]));
    }
  });
});
