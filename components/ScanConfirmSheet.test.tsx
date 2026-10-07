// @vitest-environment jsdom
/**
 * FluidVoice F01-F09: a barcode save runs through the shared ActionFeedback. Success plays the
 * shared haptic before the sheet hands the entry to Today; a refusal shows the shared alert, keeps
 * the sheet and its edits, and never plays the success haptic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { BarcodeMatch, BarcodeResponse } from "@/lib/barcode/client";
import type { CommitResult } from "@/lib/log-commit-client";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { TEST_USER } from "@/tests/helpers/account";

const commit = vi.hoisted(() => ({ result: { status: "queued" } as unknown }));
vi.mock("@/lib/log-commit-client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  commitLogEntry: vi.fn(async () => commit.result),
}));

const ScanConfirmSheet = (await import("./ScanConfirmSheet")).default;

const MATCH: BarcodeMatch = {
  foodRefId: "11111111-1111-4111-8111-111111111111", catalogFoodId: 12, revisionId: 34,
  description: "Oat bar", brand: "Acme", source: "off", qualityClass: "crowd", qualityFlags: [],
  per100g: { energy_kcal: 400 },
  portions: [{ id: 5, description: "1 bar (40 g)", gramWeight: 40, isDefault: true }],
  ingredientsText: "Oats", allergenTags: [], attribution: "Data from Open Food Facts (ODbL)",
  policy: { verdict: "allowed" },
};
const RESPONSE: BarcodeResponse = { status: "resolved", gtin14: "05000000000000", cached: false, match: MATCH };
const vibrate = vi.fn(() => true);

beforeEach(() => {
  unbindAccount(); bindAccount(TEST_USER);
  vibrate.mockClear();
  Object.defineProperty(window.navigator, "vibrate", { configurable: true, value: vibrate });
});
afterEach(cleanup);

function open() {
  const onLogged = vi.fn();
  render(<ScanConfirmSheet response={RESPONSE} slot="meal-1" onLogged={onLogged} onClose={() => {}} />);
  return onLogged;
}

describe("ScanConfirmSheet save feedback", () => {
  it("confirms a saved scan with the shared haptic before Today takes the entry", async () => {
    commit.result = { status: "queued" } satisfies Partial<CommitResult>;
    const onLogged = open();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Log it" })); });
    expect(vibrate).toHaveBeenCalledTimes(1);
    expect(onLogged).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the sheet on a refusal, with the shared alert and no success haptic", async () => {
    commit.result = { status: "owned_elsewhere" };
    const onLogged = open();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Log it" })); });
    const alert = screen.getByRole("alert");
    expect(alert.querySelector('button[aria-label="Dismiss notification"]')).toBeTruthy();
    expect(alert.textContent?.length).toBeGreaterThan(0);
    expect(onLogged).not.toHaveBeenCalled();
    expect(vibrate).not.toHaveBeenCalled();
    const logIt = screen.getByRole("button", { name: "Log it" }) as HTMLButtonElement;
    expect(logIt.disabled).toBe(false);
  });
});
