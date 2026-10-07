// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindAccount } from "@/lib/device/account";
import { resetTestAccount } from "@/tests/helpers/account";
import type { Food } from "@/lib/foods";
import type { ResolvedSlot } from "@/lib/types";
import type { SwapAlternative } from "@/lib/today/swap-alternatives";

const listRecipes = vi.hoisted(() => vi.fn(async () => []));
const allRows = vi.hoisted(() => vi.fn(async () => []));
const loadEligible = vi.hoisted(() => vi.fn(async () => new Set([
  "chicken", "turkey", "salmon", "tofu", "beans", "eggs", "rice", "oil",
])));
vi.mock("@/lib/recipes-client", () => ({ listRecipes }));
vi.mock("@/lib/foods/eligible-client", () => ({ loadEligibleLocalFoodIds: loadEligible }));
vi.mock("@/lib/sync/idb", async (original) => ({
  ...(await original<typeof import("@/lib/sync/idb")>()), allRows,
}));

import MealSwapSheet from "@/components/MealSwapSheet";

const target = { kcal: 685, protein: 45, carbs: 70, fat: 20 };
const make = (id: string, role: Food["role"], perUnit: Food["perUnit"]): Food => ({
  id, name: id, role, perUnit, unit: "oz", status: "eats", updatedAt: "2026-09-26",
});
const foods = Object.fromEntries([
  ...["chicken", "turkey", "salmon", "tofu", "beans", "eggs"].map((id) =>
    [id, make(id, "protein", { protein: 10, carbs: 0, fat: 1 })]),
  ["rice", make("rice", "carb", { protein: 0, carbs: 10, fat: 0 })],
  ["oil", make("oil", "fat", { protein: 0, carbs: 0, fat: 5 })],
]) as Record<string, Food>;
const slot: ResolvedSlot = {
  slot: "meal-2", label: "Meal 2", time: "12:30", eaten: false,
  meal: { id: "compose:today", name: "Today meal", slot: "meal-2", components: [],
    macros: target, prepMinutes: 10, tags: [] },
  components: [], macros: target,
};

beforeEach(async () => {
  await resetTestAccount();
  listRecipes.mockClear(); allRows.mockClear(); loadEligible.mockClear();
});
afterEach(cleanup);

function open(currentOverride = false) {
  const onSelect = vi.fn(async (_option: SwapAlternative) => {});
  const onReset = vi.fn(async () => {});
  const onEdit = vi.fn();
  const onClose = vi.fn();
  render(<MealSwapSheet slot={slot} target={target} foods={foods}
    currentOverride={currentOverride} onSelect={onSelect} onReset={onReset}
    onEdit={onEdit} onClose={onClose} />);
  return { onSelect, onReset, onEdit, onClose };
}

/** A tap grows the card in place (U26); its own "Swap to this" applies it. */
async function choose(index = 0) {
  const card = (await screen.findAllByRole("button", { name: /calories/ }))[index];
  fireEvent.click(card);
  fireEvent.click(await screen.findByRole("button", { name: "Swap to this" }));
}

describe("MealSwapSheet alternatives", () => {
  it("shows five or more alternatives as image cards with their own figures, never the slot target", async () => {
    open();
    expect(screen.getByRole("dialog", { name: "Swap Meal 2" })).toBeTruthy();
    // Every number in the flow is a suggestion's own; the slot's target is not shown as a figure.
    expect(screen.queryByText(/About 685 kcal/)).toBeNull();
    await waitFor(() => expect(allRows).toHaveBeenCalledTimes(1));
    const choices = screen.getAllByRole("button", { name: /calories/ });
    expect(choices.length).toBeGreaterThanOrEqual(5);
    const card = choices[0].closest("[data-recipe-card]")!;
    expect(card.textContent).toContain("kcal");
    expect(card.querySelector("[data-suggestion-photo]")).toBeTruthy();
    expect(card.textContent).toContain("Your foods");
    // A horizontal carousel that owns only x.
    const list = screen.getByRole("list", { name: "Meals to swap in" });
    expect(list.className).toMatch(/\boverflow-x-auto\b/);
    expect(list.className).toMatch(/\boverscroll-x-contain\b/);
    expect(list.className).not.toMatch(/overflow-y-auto|overscroll-contain\b/);
  });

  it("grows a card in place to its foods and writes nothing until Swap to this", async () => {
    const callbacks = open();
    expect(screen.queryByRole("button", { name: "Swap to this" })).toBeNull();
    const [first] = await screen.findAllByRole("button", { name: /calories/ });
    fireEvent.click(first);
    const card = screen.getByRole("list", { name: "Meals to swap in" }).querySelector("[data-open]") as HTMLElement;
    expect(await within(card).findByRole("button", { name: "Swap to this" })).toBeTruthy();
    expect(within(card).getByRole("list", { name: /foods$/ }).textContent).toContain("kcal");
    expect(callbacks.onSelect).not.toHaveBeenCalled();
  });

  it("saves the chosen alternative, confirms in the button, then closes", async () => {
    let finish!: () => void;
    const callbacks = open();
    callbacks.onSelect.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    await choose();
    await waitFor(() => expect(screen.getByRole("button", { name: "Swap to this" }).getAttribute("aria-busy")).toBe("true"));
    await waitFor(() => expect(callbacks.onSelect).toHaveBeenCalledTimes(1));
    expect(callbacks.onSelect.mock.calls[0][0]).toMatchObject({ source: "Your foods",
      components: expect.any(Array), macros: { kcal: expect.any(Number) } });
    await act(async () => { finish(); });
    expect(await screen.findByText("Swapped", { selector: '[role="status"]' })).toBeTruthy();
    expect(callbacks.onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(callbacks.onClose).toHaveBeenCalledTimes(1), { timeout: 3000 });
  });

  it("locks every action from the first saved swap until the flow closes", async () => {
    const callbacks = open(true);
    await choose();
    await screen.findByText("Swapped", { selector: '[role="status"]' });
    expect(callbacks.onSelect).toHaveBeenCalledTimes(1);
    // A second tap on the confirming button, or the way back, writes nothing more.
    fireEvent.click(screen.getByRole("button", { name: "Swap to this" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to the suggested meal" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit this meal" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(callbacks.onSelect).toHaveBeenCalledTimes(1);
    expect(callbacks.onReset).not.toHaveBeenCalled();
    expect(callbacks.onEdit).not.toHaveBeenCalled();
    expect(loadEligible).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(callbacks.onClose).toHaveBeenCalledTimes(1), { timeout: 3000 });
  });

  it("closes while a save runs, lets the save land, and does not close twice", async () => {
    let finish!: () => void;
    const callbacks = open();
    callbacks.onSelect.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    await choose();
    const closes = screen.getAllByRole("button", { name: "Close" });
    fireEvent.click(closes[closes.length - 1]);
    expect(callbacks.onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(callbacks.onSelect).toHaveBeenCalledTimes(1));
    await act(async () => { finish(); });
    await new Promise((resolve) => setTimeout(resolve, 1800));
    expect(callbacks.onClose).toHaveBeenCalledTimes(1);
  });

  it("offers back to suggested meal only for an override and keeps edit this meal available", async () => {
    const callbacks = open(true);
    fireEvent.click(screen.getByRole("button", { name: "Back to the suggested meal" }));
    await waitFor(() => expect(callbacks.onReset).toHaveBeenCalledTimes(1));
    expect(callbacks.onClose).toHaveBeenCalledTimes(1);
    cleanup();
    const plain = open();
    expect(screen.queryByRole("button", { name: "Back to the suggested meal" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit this meal" }));
    expect(plain.onEdit).toHaveBeenCalledTimes(1);
  });

  it("refuses a stale account's choice", async () => {
    const callbacks = open();
    await screen.findAllByRole("button", { name: /calories/ });
    bindAccount("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    await choose();
    await waitFor(() => expect(callbacks.onClose).toHaveBeenCalledTimes(1));
    expect(callbacks.onSelect).not.toHaveBeenCalled();
  });

  it("waits for verified eligibility and hides unsafe foods", async () => {
    let finish!: (ids: Set<string>) => void;
    loadEligible.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    open();
    expect(screen.queryByRole("button", { name: /calories/ })).toBeNull();
    finish(new Set(["chicken", "rice", "oil"]));
    await waitFor(() => expect(screen.getAllByRole("button", { name: /calories/ })).toHaveLength(1));
    expect(screen.queryByText("turkey")).toBeNull();
  });

  it("keeps swaps unavailable when the eligibility read fails", async () => {
    loadEligible.mockRejectedValueOnce(new Error("offline"));
    open();
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: /calories/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Edit this meal" })).toBeTruthy();
  });

  it("checks current rules again before saving a selected alternative", async () => {
    const callbacks = open();
    await choose();
    // The second eligibility read is a fresh check at the write boundary.
    await waitFor(() => expect(loadEligible).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(callbacks.onSelect).toHaveBeenCalledTimes(1));
  });

  it("refuses a choice when a food became ineligible after the sheet opened", async () => {
    loadEligible.mockResolvedValueOnce(new Set(Object.keys(foods)))
      .mockResolvedValueOnce(new Set());
    const callbacks = open();
    await choose();
    await screen.findByRole("alert");
    expect(callbacks.onSelect).not.toHaveBeenCalled();
  });
});
