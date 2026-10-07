// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { bindAccount, markAccountReady, unbindAccount } from "@/lib/device/account";
import ShoppingRoot from "@/components/ShoppingRoot";
import { defaultShoppingDraft } from "@/components/ShoppingControls";
import type { ShoppingLine } from "@/lib/shopping/types";

const mocks = vi.hoisted(() => ({
  Stale: class ShoppingStaleRevision extends Error {},
  listPeriods: vi.fn(), getPeriod: vi.fn(), listPantry: vi.fn(), patchLine: vi.fn(), preview: vi.fn(),
}));
vi.mock("@/lib/shopping-client", () => ({
  listShoppingPeriods: mocks.listPeriods, getShoppingPeriod: mocks.getPeriod, listPantry: mocks.listPantry,
  patchShoppingLine: mocks.patchLine, createShoppingPeriod: vi.fn(), previewShopping: mocks.preview,
  acceptShopping: vi.fn(), confirmPantryForLine: vi.fn(), addManualShoppingLine: vi.fn(),
  deleteShoppingLine: vi.fn(), removePantryItem: vi.fn(), patchShoppingPurchaseWindow: vi.fn(),
  ShoppingStaleRevision: mocks.Stale,
}));

const blocked = { verdict: "blocked", reason: "Tahini has sesame, which your rules exclude." } as const;

beforeEach(() => {
  window.localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  unbindAccount();
  markAccountReady(bindAccount("11111111-1111-4111-8111-111111111111"));
});
afterEach(() => { cleanup(); unbindAccount(); });

const period = { ...defaultShoppingDraft("2026-09-27", "UTC"), id: "22222222-2222-4222-8222-222222222222",
  userId: "11111111-1111-4111-8111-111111111111", revision: 1, planRevision: 1 };
const plain: ShoppingLine = { id: "l1", periodId: period.id, origin: "manual", name: "Tahini", identity: null,
  category: "manual", needGrams: null, confirmedStockGrams: null, buyGrams: null, packageGrams: null,
  purchaseConversionStatus: "unknown", sources: [], pinned: false, checked: false, note: null,
  revision: 1, ruleMark: null };

it("shows the mark a line edit comes back with, even before the list reloads", async () => {
  mocks.listPeriods.mockResolvedValue([period]);
  mocks.listPantry.mockResolvedValue([]);
  mocks.getPeriod.mockResolvedValueOnce({ period, lines: [plain] })
    .mockRejectedValue(new Error("Shopping could not refresh."));
  mocks.patchLine.mockResolvedValue({ ...plain, checked: true, revision: 2, ruleMark: blocked });
  render(<ShoppingRoot />);
  const row = await screen.findByRole("checkbox", { name: "Tahini, to buy" });
  expect(within(row).queryByText("Off your rules")).toBeNull();
  fireEvent.click(row);
  await waitFor(() => expect(mocks.patchLine).toHaveBeenCalled());
  await waitFor(() => expect(screen.getByText("Off your rules")).toBeTruthy());
  expect(screen.getByText("Tahini")).toBeTruthy();
});

it("closes an open preview when a refresh brings only new marks", async () => {
  mocks.listPeriods.mockResolvedValue([period]);
  mocks.listPantry.mockResolvedValue([]);
  // Same revision both times: only the mark moved (a rule changed elsewhere).
  mocks.getPeriod.mockResolvedValueOnce({ period, lines: [plain] })
    .mockResolvedValue({ period, lines: [{ ...plain, ruleMark: blocked }] });
  mocks.preview.mockResolvedValue({ previewId: "proof", period, choices: [], lines: [plain],
    informationalIssues: [], blockingIssues: [], unmetPins: [] });
  render(<ShoppingRoot />);
  await screen.findByRole("checkbox", { name: "Tahini, to buy" });
  fireEvent.click(screen.getByRole("button", { name: /Plan meals to fill this list/ }));
  fireEvent.click(screen.getByRole("button", { name: "Preview plan and list changes" }));
  expect(await screen.findByText("Review the list change")).toBeTruthy();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  fireEvent(document, new Event("visibilitychange"));
  await waitFor(() => expect(mocks.getPeriod).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByText("Review the list change")).toBeNull());
  expect(screen.getByRole("checkbox", { name: new RegExp(`^Tahini, to buy\\. Off your rules`) })).toBeTruthy();
});
