// @vitest-environment jsdom
/**
 * Saved lists on Shopping (UI makeover W7, PR #237 review): a list delete outlives a reload, a
 * closed page and an account switch; Undo restores a list without switching the open one; deleting
 * the last list starts a fresh draft; a lost create answer never makes a second list.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { bindAccount, markAccountReady, unbindAccount } from "@/lib/device/account";
import ShoppingRoot from "@/components/ShoppingRoot";
import { defaultShoppingDraft } from "@/components/ShoppingControls";

const mocks = vi.hoisted(() => ({
  Stale: class ShoppingStaleRevision extends Error {},
  Failed: class ShoppingRequestFailed extends Error {
    constructor(message: string, readonly status: number) { super(message); }
  },
  listPeriods: vi.fn(), getPeriod: vi.fn(), listPantry: vi.fn(), createPeriod: vi.fn(),
  deletePeriod: vi.fn(), renamePeriod: vi.fn(),
}));
vi.mock("@/lib/foods/eligible-client", () => ({ loadEligibleLocalFoodIds: () => Promise.reject(new Error("offline")) }));
vi.mock("@/lib/foods/taste-client", () => ({ loadTaste: async () => ({ status: "unavailable" }) }));
vi.mock("@/lib/favorites-client", () => ({ listFavorites: async () => [] }));
vi.mock("@/components/MyFoods.favorites", () => ({
  useFoodFavorites: () => ({ isStarred: () => false, toggle: async () => {}, error: null }) }));
vi.mock("@/components/shopping/BuildListSlot", () => ({ default: () => null }));
vi.mock("@/lib/shopping/list-client", () => ({
  deleteShoppingPeriod: mocks.deletePeriod, renameShoppingPeriod: mocks.renamePeriod }));
vi.mock("@/lib/shopping-client", () => ({
  listShoppingPeriods: mocks.listPeriods, getShoppingPeriod: mocks.getPeriod,
  createShoppingPeriod: mocks.createPeriod, listPantry: mocks.listPantry,
  previewShopping: vi.fn(), acceptShopping: vi.fn(), patchShoppingLine: vi.fn(), confirmPantryForLine: vi.fn(),
  addManualShoppingLine: vi.fn(), deleteShoppingLine: vi.fn(), patchShoppingPurchaseWindow: vi.fn(),
  removePantryItem: vi.fn(),
  ShoppingStaleRevision: mocks.Stale, ShoppingRequestFailed: mocks.Failed,
}));

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "44444444-4444-4444-8444-444444444444";
const pendingKey = (user = USER) => `shopping-pending-deletes:${user}`;
const pending = (user = USER) => JSON.parse(window.localStorage.getItem(pendingKey(user)) ?? "[]");
const list = (id: string, startDate: string, title: string) => ({
  ...defaultShoppingDraft(startDate, "UTC"), id, userId: USER, revision: 3, planRevision: 1, title,
  updatedAt: `${startDate}T09:00:00Z` });
const today = new Date().toISOString().slice(0, 10);
const A = list("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", today, "Weekly shop");
const B = list("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "2026-07-01", "Party");

let rows: ReturnType<typeof list>[] = [];
beforeEach(() => {
  window.localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  unbindAccount();
  markAccountReady(bindAccount(USER));
  rows = [A, B];
  mocks.listPeriods.mockImplementation(async () => rows);
  mocks.getPeriod.mockImplementation(async (id: string) => ({ period: rows.find((row) => row.id === id) ?? null, lines: [] }));
  mocks.listPantry.mockResolvedValue([]);
  mocks.deletePeriod.mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

async function deleteFromSheet(name: string) {
  fireEvent.click(screen.getByRole("button", { name: /Open your saved lists/ }));
  fireEvent.click(await screen.findByRole("button", { name: `Delete ${name}` }));
  fireEvent.click(screen.getByRole("button", { name: "Delete list" }));
}
const openListName = () => screen.getByRole("navigation", { name: "Saved lists" }).textContent ?? "";

it("sends a delete left on the device by a reload, and keeps that list hidden", async () => {
  window.localStorage.setItem(pendingKey(), JSON.stringify([{ id: B.id, revision: 3, requestId: "req-1", at: Date.now() }]));
  mocks.deletePeriod.mockImplementation(async (id: string) => { rows = rows.filter((row) => row.id !== id); });
  render(<ShoppingRoot />);
  await waitFor(() => expect(mocks.deletePeriod).toHaveBeenCalledWith(B.id, 3, "req-1", expect.anything()));
  await waitFor(() => expect(pending()).toEqual([]));
  fireEvent.click(await screen.findByRole("button", { name: /Open your saved lists/ }));
  expect(screen.queryByRole("button", { name: "Delete Party" })).toBeNull();
});

it("keeps a delete on the device until the server answers, and keeps it after a dropped connection", async () => {
  mocks.deletePeriod.mockRejectedValue(new TypeError("Failed to fetch"));
  const view = render(<ShoppingRoot />);
  await screen.findByRole("navigation", { name: "Saved lists" });
  await deleteFromSheet("Party");
  expect(pending().map((row: { id: string }) => row.id)).toEqual([B.id]);
  view.unmount();
  await waitFor(() => expect(mocks.deletePeriod).toHaveBeenCalledTimes(1));
  // A failed send keeps it for the next open.
  expect(pending().map((row: { id: string }) => row.id)).toEqual([B.id]);
});

it("forgets a delete the server refused for a stale revision and brings the list back", async () => {
  mocks.deletePeriod.mockRejectedValue(new mocks.Stale("changed"));
  window.localStorage.setItem(pendingKey(), JSON.stringify([{ id: B.id, revision: 2, requestId: "req-2", at: Date.now() }]));
  render(<ShoppingRoot />);
  expect(await screen.findByText("A list was not deleted. It is back in your lists.")).toBeTruthy();
  expect(pending()).toEqual([]);
});

it("Undo on a list that was not open restores it and keeps the open list open", async () => {
  render(<ShoppingRoot />);
  await waitFor(() => expect(openListName()).toContain("Weekly shop"));
  await deleteFromSheet("Party");
  fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
  await waitFor(() => expect(pending()).toEqual([]));
  expect(openListName()).toContain("Weekly shop");
  expect(mocks.getPeriod).not.toHaveBeenCalledWith(B.id);
  expect(mocks.deletePeriod).not.toHaveBeenCalled();
});

it("deleting the only list starts a fresh draft, not one with the deleted list's dates", async () => {
  rows = [B];
  render(<ShoppingRoot />);
  await waitFor(() => expect((screen.getByLabelText("From") as HTMLInputElement).value).toBe("2026-07-01"));
  rows = [];
  await deleteFromSheet("Party");
  await waitFor(() => expect((screen.getByLabelText("From") as HTMLInputElement).value).toBe(
    defaultShoppingDraft(new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(new Date()), "UTC").startDate));
});

it("an account switch inside the hold keeps the delete for that account, never sends it as another", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  render(<ShoppingRoot />);
  await screen.findByRole("navigation", { name: "Saved lists" });
  await deleteFromSheet("Party");
  act(() => { unbindAccount(); markAccountReady(bindAccount(OTHER)); });
  await act(async () => { vi.advanceTimersByTime(7_000); });
  expect(mocks.deletePeriod).not.toHaveBeenCalled();
  expect(pending(USER).map((row: { id: string }) => row.id)).toEqual([B.id]);
});

it("a new list whose answer was lost is retried under the same request id", async () => {
  mocks.createPeriod.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValue(A);
  render(<ShoppingRoot />);
  await screen.findByRole("navigation", { name: "Saved lists" });
  fireEvent.click(screen.getByRole("button", { name: /Open your saved lists/ }));
  fireEvent.click(await screen.findByRole("button", { name: "New list" }));
  fireEvent.change(screen.getByLabelText("Name (optional)"), { target: { value: "Camping" } });
  fireEvent.click(screen.getByRole("button", { name: "Start list" }));
  expect(await screen.findByText("Failed to fetch")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Start list" }));
  await waitFor(() => expect(mocks.createPeriod).toHaveBeenCalledTimes(2));
  const [first, second] = mocks.createPeriod.mock.calls;
  expect(second[1]).toBe(first[1]);
  expect(first[0]).toMatchObject({ title: "Camping", people: expect.any(Number) });
  expect(first[0].people).toBeGreaterThanOrEqual(1);
  expect(first[0].mealCoverage.length).toBeGreaterThan(0);
});
