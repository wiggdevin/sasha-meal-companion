// @vitest-environment jsdom
/**
 * FluidVoice F01-F09: the capture confirm sheet runs its save through the shared ActionFeedback.
 * A save the server keeps plays the shared haptic; one it refuses shows the shared alert, keeps
 * the draft on screen, and never plays the success haptic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import CaptureConfirm from "./CaptureConfirm";
import type { ProposeResponse } from "@/lib/capture/types";

const DRAFT: ProposeResponse = {
  draftId: "3b1f0c62-3d2c-4a52-9a1e-0c2f5d8a7b10", method: "text", notes: [],
  spend: { usedToday: 4, softCap: 30 },
  items: [{
    seq: 1, label: "Banana, raw", foodRefId: "11111111-1111-4111-8111-111111111111",
    catalogFoodRevisionId: 910, grams: 120, qty: 1, unit: "each", portionId: null,
    confidence: 0.9, policy: { verdict: "allowed" }, alternatives: [], autoResolved: true,
  }],
};
const vibrate = vi.fn(() => true);

beforeEach(() => {
  vibrate.mockClear();
  Object.defineProperty(window.navigator, "vibrate", { configurable: true, value: vibrate });
});
afterEach(cleanup);

function saveButton(): HTMLButtonElement {
  return screen.getAllByRole("button").find((button) => /^Save/.test(button.textContent ?? "")) as HTMLButtonElement;
}

describe("CaptureConfirm save feedback", () => {
  it("confirms a kept save with the shared haptic", async () => {
    const onSave = vi.fn(async () => ({ ok: true as const }));
    render(<CaptureConfirm draft={DRAFT} saving={false} onSave={onSave} onDismiss={() => {}} />);
    await act(async () => { fireEvent.click(saveButton()); });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(vibrate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a refused save as the shared alert, keeps the draft, and plays no haptic", async () => {
    const onSave = vi.fn(async () => ({ ok: false as const, message: "That did not log. Try again." }));
    render(<CaptureConfirm draft={DRAFT} saving={false} onSave={onSave} onDismiss={() => {}} />);
    await act(async () => { fireEvent.click(saveButton()); });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("That did not log. Try again.");
    expect(alert.querySelector('button[aria-label="Dismiss notification"]')).toBeTruthy();
    expect(screen.getByText(/Banana/)).toBeTruthy();
    expect(vibrate).not.toHaveBeenCalled();
  });
});
