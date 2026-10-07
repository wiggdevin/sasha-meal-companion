// @vitest-environment jsdom
/**
 * Phase 18 W6 UI: the Plan sheet's "Not this" and "Add" each send a signal event after the tap has
 * already done its work, reporting the tap's own time rather than whenever a slow save resolves.
 * An idea the server could not ground to a food (no `foodKey`, components/signals/composed-meal-signals.ts)
 * sends nothing — proven here alongside the keyed case that proves the wiring itself is correct.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetTestAccount } from "@/tests/helpers/account";
import type { ComposedMeal } from "@/lib/coach/compose";
import type { ResolvedSlot } from "@/lib/types";

const postTurn = vi.hoisted(() => vi.fn());
const applyCoachAction = vi.hoisted(() => vi.fn());
const mocked = vi.hoisted(() => ({ foodSignal: vi.fn(), sendFoodSignals: vi.fn() }));
vi.mock("@/lib/coach-client", async (original) => ({
  ...(await original<typeof import("@/lib/coach-client")>()), postTurn,
}));
vi.mock("@/lib/coach/apply-client", async (original) => ({
  ...(await original<typeof import("@/lib/coach/apply-client")>()), applyCoachAction,
}));
vi.mock("@/lib/recipe-access-client", async (original) => ({
  ...(await original<typeof import("@/lib/recipe-access-client")>()),
  useRecipeAccess: () => ({ enabled: false, loading: false, unavailable: false, retry: vi.fn() }),
}));
vi.mock("@/lib/foods/signals-client", () => ({
  foodSignal: (input: unknown, now?: Date) => mocked.foodSignal(input, now),
  sendFoodSignals: (events: unknown) => mocked.sendFoodSignals(events),
}));

import PlanSheet from "@/components/PlanSheet";

const slot: ResolvedSlot = {
  slot: "meal-2", label: "Meal 2", time: "12:30", meal: null, components: [],
  macros: { kcal: 0, protein: 0, carbs: 0, fat: 0 }, eaten: false,
};

function meal(wish: string, foodKey?: string): ComposedMeal {
  return {
    wish, slot: "meal-2", flagged: [], fitsTarget: true,
    target: { kcal: 620, protein: 45, carbs: 70, fat: 18 },
    totals: { kcal: 615, protein: 46, carbs: 68, fat: 17 },
    items: [{ name: "Eggs", grams: 150, foodRefId: "food-1", catalogFoodRevisionId: 12,
      kcalPer100g: 140, proteinPer100g: 12, carbsPer100g: 1, fatPer100g: 9,
      macros: { kcal: 210, protein: 18, carbs: 1.5, fat: 13.5 }, verdict: "allowed",
      ...(foodKey ? { foodKey } : {}) } as ComposedMeal["items"][number]],
  };
}

function response(meals: ComposedMeal[]) {
  return { threadId: "thread-1", messages: [{ id: "assistant-1", role: "assistant", content: "Here are some options." }],
    composed: meals, suggestions: [], actions: [], draft: null };
}

function open() {
  render(<PlanSheet date="2026-10-06" slot={slot}
    target={{ kcal: 620, protein: 45, carbs: 70, fat: 18 }}
    onClose={vi.fn()} onPlaced={vi.fn()} />);
}

beforeEach(async () => {
  await resetTestAccount();
  applyCoachAction.mockReset().mockResolvedValue({ status: "applied", token: {} });
  mocked.foodSignal.mockReset().mockImplementation((input) => ({ ...input, clientEventId: "evt", at: "2026-10-06T18:00:00Z" }));
  mocked.sendFoodSignals.mockReset().mockResolvedValue(true);
});
afterEach(cleanup);

describe("Plan sheet signals", () => {
  it("'Not this' sends nothing today: a free-text idea has no resolvable food key", async () => {
    postTurn.mockReset().mockResolvedValue(response([meal("Egg and rice bowl")]));
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Not this: Egg and rice bowl" }));
    expect(mocked.sendFoodSignals).not.toHaveBeenCalled();
  });

  it("'Add' sends nothing today: a free-text idea has no resolvable food key", async () => {
    postTurn.mockReset().mockResolvedValue(response([meal("Egg and rice bowl")]));
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Put it in Meal 2" }));
    await waitFor(() => expect(applyCoachAction).toHaveBeenCalled());
    expect(mocked.sendFoodSignals).not.toHaveBeenCalled();
  });

  it("sends not_this with the shown slate's keys once ideas carry a resolvable key", async () => {
    const eggs = meal("Egg and rice bowl", "food:11111111-1111-4111-8111-111111111111");
    const salmon = meal("Salmon bowl", "catalog:42");
    postTurn.mockReset().mockResolvedValue(response([eggs, salmon]));
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Not this: Egg and rice bowl" }));

    expect(mocked.sendFoodSignals).toHaveBeenCalledTimes(1);
    const [event] = mocked.sendFoodSignals.mock.calls[0][0];
    expect(event).toMatchObject({ surface: "plan_sheet", kind: "not_this",
      chosenKey: "food:11111111-1111-4111-8111-111111111111",
      offeredKeys: ["food:11111111-1111-4111-8111-111111111111", "catalog:42"],
      occasion: "lunch" });
  });

  it("'Add' sends nothing when the save fails (never fire added on the tap alone, Sol review r1 WARN)", async () => {
    const eggs = meal("Egg and rice bowl", "food:11111111-1111-4111-8111-111111111111");
    postTurn.mockReset().mockResolvedValue(response([eggs]));
    applyCoachAction.mockReset().mockResolvedValue({ status: "failed", reason: "Couldn’t save this meal. Try again." });
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Put it in Meal 2" }));
    await waitFor(() => expect(applyCoachAction).toHaveBeenCalled());
    expect(mocked.sendFoodSignals).not.toHaveBeenCalled();
  });

  it("'Add' sends added only once the placement actually applies, with the full shown slate", async () => {
    const eggs = meal("Egg and rice bowl", "food:11111111-1111-4111-8111-111111111111");
    const salmon = meal("Salmon bowl", "catalog:42");
    postTurn.mockReset().mockResolvedValue(response([eggs, salmon]));
    open();
    fireEvent.click((await screen.findAllByRole("button", { name: /^Put it in Meal 2$/ }))[0]);
    await waitFor(() => expect(mocked.sendFoodSignals).toHaveBeenCalledTimes(1));
    const [event] = mocked.sendFoodSignals.mock.calls[0][0];
    expect(event).toMatchObject({ surface: "plan_sheet", kind: "added",
      chosenKey: "food:11111111-1111-4111-8111-111111111111",
      offeredKeys: ["food:11111111-1111-4111-8111-111111111111", "catalog:42"] });
  });

  it("stamps 'added' with the tap's own time, not the save's completion time " +
    "(Sol review r4 WARN: a slow save that straddles midnight)", async () => {
    const eggs = meal("Egg and rice bowl", "food:11111111-1111-4111-8111-111111111111");
    postTurn.mockReset().mockResolvedValue(response([eggs]));
    let resolveApply: ((value: { status: string; token: Record<string, never> }) => void) | undefined;
    applyCoachAction.mockReset().mockImplementation(() => new Promise((resolve) => { resolveApply = resolve; }));
    open();
    const button = await screen.findByRole("button", { name: "Put it in Meal 2" });

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-06T23:59:30Z"));
      fireEvent.click(button);
      // The save takes long enough to cross midnight before it resolves.
      vi.setSystemTime(new Date("2026-10-07T00:00:30Z"));
      resolveApply?.({ status: "applied", token: {} });
      await vi.waitFor(() => expect(mocked.sendFoodSignals).toHaveBeenCalledTimes(1));
    } finally { vi.useRealTimers(); }

    const tappedAt = mocked.foodSignal.mock.calls[0][1];
    expect(tappedAt).toBeInstanceOf(Date);
    expect((tappedAt as Date).toISOString()).toBe("2026-10-06T23:59:30.000Z");
  });

  it("keeps one slateId's offeredKeys the same full shown set across two 'Not this' taps " +
    "in the same showing (Sol review r1 WARN: a shrinking slate under one slateId)", async () => {
    const a = meal("A", "food:11111111-1111-4111-8111-111111111111");
    const b = meal("B", "catalog:42");
    const c = meal("C", "catalog:43");
    postTurn.mockReset().mockResolvedValue(response([a, b, c]));
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Not this: A" }));
    fireEvent.click(await screen.findByRole("button", { name: "Not this: B" }));

    expect(mocked.sendFoodSignals).toHaveBeenCalledTimes(2);
    const [firstEvent] = mocked.sendFoodSignals.mock.calls[0][0];
    const [secondEvent] = mocked.sendFoodSignals.mock.calls[1][0];
    expect(firstEvent.slateId).toBe(secondEvent.slateId);
    expect(firstEvent.offeredKeys).toEqual(secondEvent.offeredKeys);
    expect(firstEvent.offeredKeys).toEqual(["food:11111111-1111-4111-8111-111111111111", "catalog:42", "catalog:43"]);
  });

  it("never offers a meal the reply did not make selectable (Sol review r2 BLOCK: a shown slate " +
    "built from the raw response, not from what was actually rendered as a card)", async () => {
    const shown = meal("Shown idea", "food:11111111-1111-4111-8111-111111111111");
    const unselectable = meal("Flagged idea", "catalog:99");
    unselectable.flagged = ["egg allergy"];
    postTurn.mockReset().mockResolvedValue(response([shown, unselectable]));
    open();
    // Only the selectable idea renders as a card; the flagged one is never shown.
    expect(screen.queryByText("Flagged idea")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Not this: Shown idea" }));

    expect(mocked.sendFoodSignals).toHaveBeenCalledTimes(1);
    const [event] = mocked.sendFoodSignals.mock.calls[0][0];
    expect(event.offeredKeys).toEqual(["food:11111111-1111-4111-8111-111111111111"]);
  });

  it("never attaches a failed idea's added signal to a later, unrelated placement " +
    "(Sol review r2 BLOCK: a stale placingMeal ref surviving a failure)", async () => {
    const first = meal("First idea", "food:11111111-1111-4111-8111-111111111111");
    const second = meal("Second idea", "catalog:42");
    postTurn.mockReset().mockResolvedValue(response([first, second]));
    applyCoachAction.mockReset().mockResolvedValueOnce({ status: "failed", reason: "Try again." })
      .mockResolvedValueOnce({ status: "applied", token: {} });
    open();
    const buttons = await screen.findAllByRole("button", { name: /^Put it in Meal 2$/ });
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(applyCoachAction).toHaveBeenCalledTimes(1));
    expect(mocked.sendFoodSignals).not.toHaveBeenCalled();

    fireEvent.click(buttons[1]);
    await waitFor(() => expect(mocked.sendFoodSignals).toHaveBeenCalledTimes(1));
    const [event] = mocked.sendFoodSignals.mock.calls[0][0];
    expect(event.chosenKey).toBe("catalog:42");
  });
});
