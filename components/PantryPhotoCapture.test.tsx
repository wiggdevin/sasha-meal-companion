/** @vitest-environment jsdom */
/**
 * Phase 18 W12 (docs/specs/phase-18-open-world-foods.md §W12; CONTRACT W12, coordination board).
 *
 * Acceptance 8: the privacy notice is present before the camera ever opens, every time this
 * mounts open -- reuses components/ui/PhotoPrivacyNotice.tsx unchanged, same as every other
 * photo-capture entry point (CaptureSheet, the Plan sheet, RecipeHub).
 *
 * The rest pins the confirm-first flow against the backend's own wire shapes
 * (lib/server/pantry-photo.ts): draft (names only, nothing written), an editable draft (rename,
 * remove, add), confirm (writes, rule-marks never hidden), and a per-item failed result shown by
 * name and reason rather than discarded.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  upload: vi.fn(async () => "media/pantry-1.jpg"),
  draft: vi.fn(async () => ["Carrots", "Greek yogurt"]),
  confirm: vi.fn(),
}));
vi.mock("@/lib/shopping/pantry-photo-client", () => ({
  uploadPantryPhoto: mocked.upload,
  draftPantryPhoto: mocked.draft,
  confirmPantryPhoto: mocked.confirm,
  PantryPhotoError: class PantryPhotoError extends Error {},
}));
vi.mock("@/lib/device/account", () => ({ accountHandle: () => ({ userId: "user-1", epoch: 1 }) }));
// jsdom has no createImageBitmap/canvas; a fake photo blob stands in for whatever PhotoCapture's
// own resize step (lib/media/resize.ts, tested on its own) would have handed back.
vi.mock("@/components/PhotoCapture", () => ({
  default: ({ label, onReady }: { label: string; onReady: (photo: Blob) => void }) =>
    <button type="button" onClick={() => onReady(new Blob(["x"], { type: "image/jpeg" }))}>{label}</button>,
}));

import PantryPhotoCapture from "@/components/PantryPhotoCapture";

afterEach(() => { cleanup(); vi.clearAllMocks(); });

function open() {
  render(<PantryPhotoCapture onConfirmed={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Add from a photo" }));
}

describe("PantryPhotoCapture's privacy notice (acceptance 8)", () => {
  it("is present before the camera control is ever tapped", () => {
    open();
    expect(screen.getByText(/keep medicines, prescriptions and labels/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Photograph your pantry" })).toBeTruthy();
    expect(mocked.upload).not.toHaveBeenCalled();
  });

  it("shows the notice again on a second open, not just the first (never a one-time notice)", () => {
    render(<PantryPhotoCapture onConfirmed={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Add from a photo" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Add from a photo" }));
    expect(screen.getByText(/keep medicines, prescriptions and labels/i)).toBeTruthy();
  });
});

describe("PantryPhotoCapture's draft (acceptance 1)", () => {
  it("writes nothing while reading the photo -- only draftPantryPhoto and uploadPantryPhoto run", async () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Photograph your pantry" }));
    await waitFor(() => expect(screen.getByDisplayValue("Carrots")).toBeTruthy());
    expect(mocked.upload).toHaveBeenCalledTimes(1);
    expect(mocked.draft).toHaveBeenCalledWith(expect.anything(), "media/pantry-1.jpg");
    expect(mocked.confirm).not.toHaveBeenCalled();
  });

  it("lets the draft be renamed, removed and added to before confirming", async () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Photograph your pantry" }));
    await waitFor(() => expect(screen.getByDisplayValue("Carrots")).toBeTruthy());
    fireEvent.change(screen.getByDisplayValue("Carrots"), { target: { value: "Baby carrots" } });
    fireEvent.click(screen.getByRole("button", { name: "Remove Greek yogurt" }));
    fireEvent.change(screen.getByLabelText("Add an item"), { target: { value: "Butter" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    mocked.confirm.mockResolvedValue({ items: [], failed: [] });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(mocked.confirm).toHaveBeenCalledTimes(1));
    const [, , items] = mocked.confirm.mock.calls[0];
    expect(items).toEqual([{ name: "Baby carrots", grams: null }, { name: "Butter", grams: null }]);
  });
});

describe("PantryPhotoCapture's confirmed result (acceptance 2, 3)", () => {
  it("shows a blocked item's rule mark, never hidden", async () => {
    mocked.confirm.mockResolvedValue({
      items: [{ id: "p1", userId: "u", name: "Carrots", identity: { foodRefId: null, foodDbId: null,
        catalogFoodRevisionId: null, purchaseState: "as_purchased", variantKey: "carrots" },
        confirmedGrams: null, confirmedAt: "2026-10-07T00:00:00Z", revision: 1, source: "photo",
        ruleMark: { verdict: "blocked", reason: "On your Avoid list" } }],
      failed: [],
    });
    const onConfirmed = vi.fn();
    render(<PantryPhotoCapture onConfirmed={onConfirmed} />);
    fireEvent.click(screen.getByRole("button", { name: "Add from a photo" }));
    fireEvent.click(screen.getByRole("button", { name: "Photograph your pantry" }));
    await waitFor(() => expect(screen.getByDisplayValue("Carrots")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(screen.getAllByText("Carrots").length).toBeGreaterThan(0));
    expect(screen.getByText("On your Avoid list")).toBeTruthy();
    expect(onConfirmed).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ id: "p1" }),
    ]));
  });

  it("lists a failed item by name and reason instead of discarding it", async () => {
    mocked.confirm.mockResolvedValue({
      items: [],
      failed: [{ name: "Milk", status: 409, code: "pantry_identity_exists", message: "Already in your pantry." }],
    });
    open();
    fireEvent.click(screen.getByRole("button", { name: "Photograph your pantry" }));
    await waitFor(() => expect(screen.getByDisplayValue("Carrots")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(screen.getByText(/didn.t save/)).toBeTruthy());
    expect(screen.getByText("Milk: Already in your pantry.")).toBeTruthy();
  });
});
