// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CoachScreen from "@/app/coach/CoachScreen";
import { CapabilitiesProvider } from "@/components/CapabilitiesProvider";
import CoachChat from "@/components/CoachChat";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ back: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/components/BarcodeScanSheet", () => ({
  default: ({ onClose }: { onClose: () => void }) => <div role="dialog" aria-label="Scan">
    <button type="button" onClick={onClose}>Close scan</button>
  </div>,
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("coach composer integration", () => {
  it("consumes ?open=scan once and cleans the URL", async () => {
    window.history.replaceState(null, "", "/coach?open=scan&kept=1");
    render(<CapabilitiesProvider value={{ coach: true, scan: true, captureMethods: [] }}>
      <CoachChat userId="user-1" threadId={null} onOpenDraft={vi.fn()} onThreadSaved={vi.fn()} />
    </CapabilitiesProvider>);

    expect(await screen.findByRole("dialog", { name: "Scan" })).toBeTruthy();
    expect(window.location.pathname + window.location.search).toBe("/coach?kept=1");
    fireEvent.click(screen.getByRole("button", { name: "Close scan" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Scan" })).toBeNull());
    expect(screen.queryByRole("dialog", { name: "Scan" })).toBeNull();
  });

  it("renders the Coach header inside the exact-height shell slot", () => {
    render(<CapabilitiesProvider value={{ coach: false, scan: false, captureMethods: [] }}>
      <CoachScreen />
    </CapabilitiesProvider>);

    const heading = screen.getByRole("heading", { name: "Sasha" });
    expect(heading.closest('[data-testid="coach-shell"]')).toBeTruthy();
  });
});
