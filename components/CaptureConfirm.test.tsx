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

describe("CaptureConfirm meal details (W125)", () => {
  const SPEC = { defaultClock: "08:15", clockSource: "photo" as const };

  it("offers an editable name, the photo's time and Save as recipe, and hands them to the save", async () => {
    const onSave = vi.fn(async () => ({ ok: true as const }));
    render(<CaptureConfirm draft={DRAFT} saving={false} details={SPEC} onSave={onSave} onDismiss={() => {}} />);
    expect(screen.getByText("Eaten at · From the photo")).toBeTruthy();
    const time = screen.getByLabelText("Eaten at") as HTMLInputElement;
    expect(time.value).toBe("08:15");
    fireEvent.change(screen.getByLabelText("Meal name"), { target: { value: "Banana break" } });
    fireEvent.change(time, { target: { value: "09:40" } });
    fireEvent.click(screen.getByRole("button", { name: "Save as recipe" }));
    const save = screen.getAllByRole("button").find((b) => /^Save \d/.test(b.textContent ?? ""));
    await act(async () => { fireEvent.click(save as HTMLButtonElement); });
    expect(onSave).toHaveBeenCalledWith({}, false, undefined,
      { title: "Banana break", clock: "09:40", saveAsRecipe: true });
  });

  it("leaves the time untouched (null) when the user does not change it", async () => {
    const onSave = vi.fn(async () => ({ ok: true as const }));
    render(<CaptureConfirm draft={DRAFT} saving={false} details={SPEC} onSave={onSave} onDismiss={() => {}} />);
    const save = screen.getAllByRole("button").find((b) => /^Save \d/.test(b.textContent ?? ""));
    await act(async () => { fireEvent.click(save as HTMLButtonElement); });
    expect(onSave).toHaveBeenCalledWith({}, false, undefined, { title: "", clock: null, saveAsRecipe: false });
  });
});
