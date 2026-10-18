// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { bindAccount, markAccountReady, unbindAccount } from "@/lib/device/account";
import ShoppingRoot from "@/components/ShoppingRoot";
import { shoppingDate, shoppingRange } from "@/lib/shopping/labels";
import { defaultShoppingDraft } from "@/components/ShoppingControls";

const mocks = vi.hoisted(() => ({
  Stale: class ShoppingStaleRevision extends Error {},
  listPeriods: vi.fn(), getPeriod: vi.fn(), listPantry: vi.fn(), preview: vi.fn(),
  accept: vi.fn(), createPeriod: vi.fn(), patchLine: vi.fn(), confirmPantry: vi.fn(), addManual: vi.fn(),
}));
vi.mock("@/lib/shopping-client", () => ({
  listShoppingPeriods: mocks.listPeriods, getShoppingPeriod: mocks.getPeriod,
  createShoppingPeriod: mocks.createPeriod,
  listPantry: mocks.listPantry, previewShopping: mocks.preview, acceptShopping: mocks.accept,
  patchShoppingLine: mocks.patchLine, confirmPantryForLine: mocks.confirmPantry,
  addManualShoppingLine: mocks.addManual,
  ShoppingStaleRevision: mocks.Stale,
}));

beforeEach(() => {
  window.localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  unbindAccount();
  const account = bindAccount("11111111-1111-4111-8111-111111111111");
  markAccountReady(account);
  const period = { ...defaultShoppingDraft("2026-09-27", "UTC"),
    id: "22222222-2222-4222-8222-222222222222", userId: account.userId,
    revision: 1, planRevision: 1 };
  mocks.listPeriods.mockResolvedValue([period]);
  mocks.getPeriod.mockResolvedValue({ period, lines: [] });
  mocks.listPantry.mockResolvedValue([]);
  mocks.preview.mockResolvedValue({ previewId: "proof", period, choices: [], lines: [],
    informationalIssues: [], blockingIssues: [], unmetPins: [] });
  mocks.createPeriod.mockResolvedValue(period);
});

it("lists saved periods outside the current date window and reopens one without previewing", async () => {
  const current = (await mocks.listPeriods())[0];
  const older = { ...current, id: "33333333-3333-4333-8333-333333333333",
    startDate: "2026-07-01", endDate: "2026-07-07" };
  mocks.listPeriods.mockResolvedValue([current, older]);
  mocks.getPeriod.mockImplementation(async (id: string) => ({ period: id === older.id ? older : current, lines: [] }));
  render(<ShoppingRoot />);
  expect(await screen.findByRole("heading", { name: "Shopping" })).toBeTruthy();
  expect(mocks.listPeriods).toHaveBeenCalledWith();
  fireEvent.click(screen.getByRole("combobox", { name: "Open shopping list" }));
  fireEvent.click(screen.getByRole("option", { name: shoppingRange("2026-07-01", "2026-07-07") }));
  await waitFor(() => expect(mocks.getPeriod).toHaveBeenCalledWith(older.id));
  await waitFor(() => expect((screen.getByLabelText("From") as HTMLInputElement).value).toBe("2026-07-01"));
  expect(mocks.preview).not.toHaveBeenCalled();
});

it("keeps the latest list selection when an earlier open finishes late", async () => {
  const current = (await mocks.listPeriods())[0];
  const older = { ...current, id: "33333333-3333-4333-8333-333333333333",
    startDate: "2026-07-01", endDate: "2026-07-07" };
  let rejectOlder: (error: Error) => void = () => {};
  const olderLoad = new Promise<never>((_, reject) => { rejectOlder = reject; });
  mocks.listPeriods.mockResolvedValue([current, older]);
  mocks.getPeriod.mockImplementation((id: string) => id === older.id
    ? olderLoad : Promise.resolve({ period: current, lines: [] }));
  render(<ShoppingRoot />);
  expect(await screen.findByRole("heading", { name: "Shopping" })).toBeTruthy();
  fireEvent.click(screen.getByRole("combobox", { name: "Open shopping list" }));
  fireEvent.click(screen.getByRole("option", { name: shoppingRange("2026-07-01", "2026-07-07") }));
  await waitFor(() => expect(mocks.getPeriod).toHaveBeenCalledWith(older.id));
  fireEvent.click(screen.getByRole("combobox", { name: "Open shopping list" }));
  fireEvent.click(screen.getByRole("option", { name: shoppingRange("2026-09-27", "2026-10-03") }));
  await waitFor(() => expect((screen.getByLabelText("From") as HTMLInputElement).value).toBe("2026-09-27"));
  await act(async () => { rejectOlder(new Error("Late failed request")); });
  expect(screen.queryByText("Late failed request")).toBeNull();
  expect((screen.getByLabelText("From") as HTMLInputElement).value).toBe("2026-09-27");
});

it("saves a blank list for manual items through the period API and only shows it after success", async () => {
  const saved = (await mocks.listPeriods())[0];
  mocks.listPeriods.mockResolvedValueOnce([]).mockResolvedValue([saved]);
  mocks.getPeriod.mockResolvedValue({ period: saved, lines: [] });
  render(<ShoppingRoot />);
  expect(await screen.findByRole("heading", { name: "Shopping" })).toBeTruthy();
  expect(screen.getByText(/No saved lists yet/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Start an empty list" }));
  await waitFor(() => expect(mocks.createPeriod).toHaveBeenCalled());
  await waitFor(() => expect(mocks.getPeriod).toHaveBeenCalledWith(saved.id));
  expect(screen.queryByText(/No saved lists yet/)).toBeNull();
  expect(await screen.findByText("Shopping list started.")).toBeTruthy();
});

it("does not claim an unsaved blank list is saved after a failed create", async () => {
  mocks.listPeriods.mockResolvedValue([]);
  mocks.createPeriod.mockRejectedValue(new Error("Shopping is unavailable"));
  render(<ShoppingRoot />);
  expect(await screen.findByRole("heading", { name: "Shopping" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Start an empty list" }));
  expect(await screen.findByText("Shopping is unavailable")).toBeTruthy();
  expect(screen.getByText(/No saved lists yet/)).toBeTruthy();
  expect(mocks.getPeriod).not.toHaveBeenCalled();
});

it("clears an old account's pending blank-save state on account switch", async () => {
  const oldPeriod = (await mocks.listPeriods())[0];
  mocks.listPeriods.mockResolvedValue([]);
  let completeOld: (value: unknown) => void = () => {};
  mocks.createPeriod.mockReturnValue(new Promise((resolve) => { completeOld = resolve; }));
  render(<ShoppingRoot />);
  expect(await screen.findByRole("heading", { name: "Shopping" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Start an empty list" }));
  await waitFor(() => expect(mocks.createPeriod).toHaveBeenCalled());
  expect(screen.getByRole("button", { name: "Starting list…" })).toHaveProperty("disabled", true);
  unbindAccount();
  markAccountReady(bindAccount("44444444-4444-4444-8444-444444444444"));
  expect(await screen.findByRole("button", { name: "Start an empty list" })).toHaveProperty("disabled", false);
  await act(async () => { completeOld(oldPeriod); });
  expect(screen.queryByText(/List saved/)).toBeNull();
});

it("keeps area and store notes under the current account's device key", async () => {
  mocks.listPeriods.mockResolvedValue([]);
  render(<ShoppingRoot />);
  expect(await screen.findByRole("heading", { name: "Shopping" })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Shopping area (optional)"), { target: { value: "80202" } });
  fireEvent.change(screen.getByLabelText("Preferred stores (optional notes)"),
    { target: { value: "My usual grocer" } });
  expect(window.localStorage.getItem("shopping-location:11111111-1111-4111-8111-111111111111"))
    .toBe("80202");
  expect(window.localStorage.getItem("shopping-stores:11111111-1111-4111-8111-111111111111"))
    .toBe("My usual grocer");
  expect(window.localStorage.getItem("shopping-stores:22222222-2222-4222-8222-222222222222"))
    .toBeNull();
});
it("starts this week's list through addItems when none is selected, then adds each item with its own key", async () => {
  const saved = (await mocks.listPeriods())[0];
  mocks.listPeriods.mockResolvedValueOnce([]).mockResolvedValue([saved]);
  mocks.getPeriod.mockResolvedValue({ period: saved, lines: [] });
  mocks.createPeriod.mockResolvedValue(saved);
  mocks.addManual.mockImplementation(async (periodId: string, name: string) => ({
    id: `manual-${name}`, periodId, origin: "manual", name, identity: null, category: "manual",
    needGrams: null, confirmedStockGrams: null, buyGrams: null, packageGrams: null,
    purchaseConversionStatus: "unknown", sources: [], pinned: false, checked: false, note: null, revision: 1,
  }));
  render(<ShoppingRoot />);
  expect(await screen.findByRole("heading", { name: "Shopping" })).toBeTruthy();
  expect(screen.getByText(/No saved lists yet/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Add items"), { target: { value: "Soap, Rice" } });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  await waitFor(() => expect(mocks.createPeriod).toHaveBeenCalled());
  await waitFor(() => expect(mocks.addManual).toHaveBeenCalledTimes(2));
  expect(mocks.addManual.mock.calls[0][0]).toBe(saved.id);
  expect(mocks.addManual.mock.calls[0][1]).toBe("Soap");
  expect(mocks.addManual.mock.calls[1][1]).toBe("Rice");
  const requestIds = mocks.addManual.mock.calls.map((call) => call[2]);
  expect(new Set(requestIds).size).toBe(2);
  expect(await screen.findByText("2 items added.")).toBeTruthy();
  expect(screen.queryByText(/No saved lists yet/)).toBeNull();
});
afterEach(() => { cleanup(); vi.clearAllMocks(); unbindAccount(); });

it("loads the account period and pantry, then asks the preview API without writing a list", async () => {
  render(<ShoppingRoot />);
  expect(await screen.findByRole("heading", { name: "Shopping" })).toBeTruthy();
  expect(mocks.listPeriods).toHaveBeenCalledOnce();
  expect(mocks.getPeriod).toHaveBeenCalledOnce();
  expect(mocks.listPantry).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
  await waitFor(() => expect(mocks.preview).toHaveBeenCalledOnce());
  expect(mocks.preview.mock.calls[0][0]).toMatchObject({ draft: expect.objectContaining({
    effort: "standard", mealCoverage: ["dinner"],
  }), basket: [] });
  expect(mocks.accept).not.toHaveBeenCalled();
});

it("reports an accepted commit honestly when the follow-up refresh fails", async () => {
  const period = (await mocks.listPeriods())[0];
  mocks.accept.mockResolvedValue({ period, lines: [] });
  mocks.listPeriods.mockResolvedValueOnce([period]).mockRejectedValueOnce(new Error("offline"));
  const updated = vi.fn();
  window.addEventListener("recipe-plan-accepted", updated);
  render(<ShoppingRoot />);
  expect(await screen.findByRole("heading", { name: "Shopping" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
  expect(await screen.findByRole("button", { name: "Accept plan and list" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Accept plan and list" }));
  await waitFor(() => expect(mocks.accept).toHaveBeenCalledOnce());
  expect(await screen.findByText(/Plan accepted\. The latest shopping list could not refresh yet/)).toBeTruthy();
  expect(updated).toHaveBeenCalledOnce();
  expect(screen.queryByRole("button", { name: "Accept plan and list" })).toBeNull();
  window.removeEventListener("recipe-plan-accepted", updated);
});

it("keeps a just-accepted list selected after its first refresh fails", async () => {
  const saved = (await mocks.listPeriods())[0];
  mocks.listPeriods.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue([saved]);
  mocks.accept.mockResolvedValue({ period: saved, lines: [] });
  render(<ShoppingRoot />);
  expect(await screen.findByRole("heading", { name: "Shopping" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
  fireEvent.click(await screen.findByRole("button", { name: "Accept plan and list" }));
  expect(await screen.findByText(/Plan accepted\. The latest shopping list could not refresh yet/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(mocks.getPeriod).toHaveBeenCalledWith(saved.id));
  expect(screen.getByRole("combobox", { name: "Open shopping list" }).textContent).toContain(shoppingDate("2026-09-27"));
});

it("keeps an unchanged preview open after a tab-return refresh", async () => {
  render(<ShoppingRoot />);
  expect(await screen.findByRole("heading", { name: "Shopping" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
  expect(await screen.findByText("Review the list change")).toBeTruthy();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  fireEvent(document, new Event("visibilitychange"));
  await waitFor(() => expect(mocks.getPeriod).toHaveBeenCalledTimes(2));
  expect(screen.getByText("Review the list change")).toBeTruthy();
});

it("ignores a late plan acceptance after the account switches", async () => {
  const oldPeriod = (await mocks.listPeriods())[0];
  let finish!: (snapshot: { period: typeof oldPeriod; lines: [] }) => void;
  mocks.accept.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  render(<ShoppingRoot />);
  expect(await screen.findByRole("heading", { name: "Shopping" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
  fireEvent.click(await screen.findByRole("button", { name: "Accept plan and list" }));
  await waitFor(() => expect(mocks.accept).toHaveBeenCalledOnce());
  unbindAccount();
  mocks.listPeriods.mockResolvedValue([]);
  markAccountReady(bindAccount("44444444-4444-4444-8444-444444444444"));
  expect(await screen.findByRole("button", { name: "Start an empty list" })).toBeTruthy();
  await act(async () => { finish({ period: oldPeriod, lines: [] }); });
  expect(screen.queryByRole("combobox", { name: "Open shopping list" })).toBeNull();
  expect(screen.getByRole("button", { name: "Start an empty list" })).toBeTruthy();
  expect(screen.queryByText(/Plan accepted/)).toBeNull();
});

it("reloads a stale line before telling the user to retry the edit", async () => {
  const period = (await mocks.listPeriods())[0];
  const staleLine = { id: "line-1", periodId: period.id, origin: "manual", name: "Soap", identity: null,
    category: "manual", needGrams: null, confirmedStockGrams: null, buyGrams: null,
    packageGrams: null, purchaseConversionStatus: "unknown", sources: [],
    pinned: false, checked: false, note: null, revision: 1 };
  const latest = { ...staleLine, revision: 2 };
  mocks.getPeriod.mockResolvedValueOnce({ period, lines: [staleLine] })
    .mockResolvedValue({ period, lines: [latest] });
  mocks.patchLine.mockRejectedValueOnce(new mocks.Stale()).mockResolvedValue(latest);
  render(<ShoppingRoot />);
  expect(await screen.findByRole("checkbox", { name: "Soap, to buy" })).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: "Soap, to buy" }));
  expect(await screen.findByText(/latest list loaded; retry the edit/)).toBeTruthy();
  expect(mocks.getPeriod).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("checkbox", { name: "Soap, to buy" }));
  await waitFor(() => expect(mocks.patchLine).toHaveBeenLastCalledWith(
    expect.objectContaining({ revision: 2 }), { checked: true }));
});
