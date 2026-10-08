// @vitest-environment jsdom
/**
 * Phase 18 W6 UI: the swap sheet sends `swapped_away` + `picked`, sharing one slate and one
 * slateId, after the swap has already saved — never blocking, never surfacing a signal error.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import type { Food } from "@/lib/foods";
import type { SwapAlternative } from "@/lib/today/swap-alternatives";
import type { ResolvedSlot } from "@/lib/types";

const mocked = vi.hoisted(() => ({
  swapAlternatives: vi.fn(), loadEligibleLocalFoodIds: vi.fn(),
  foodSignal: vi.fn(), sendFoodSignals: vi.fn(),
}));
vi.mock("@/lib/today/swap-alternatives", async (importOriginal) => ({
  ...(await importOriginal<object>()), swapAlternatives: mocked.swapAlternatives,
}));
vi.mock("@/lib/foods/eligible-client", () => ({ loadEligibleLocalFoodIds: mocked.loadEligibleLocalFoodIds }));
vi.mock("@/lib/foods/prefs-client", () => ({ readPrefRefCache: () => ({}) }));
vi.mock("@/lib/recipes-client", () => ({ listRecipes: async () => [] }));
vi.mock("@/lib/sync/idb", () => ({ allRows: async () => [] }));
vi.mock("@/lib/foods/signals-client", () => ({
  foodSignal: (input: unknown, now?: Date) => mocked.foodSignal(input, now),
  sendFoodSignals: (events: unknown) => mocked.sendFoodSignals(events),
}));

import MealSwapSheet from "@/components/MealSwapSheet";

afterEach(cleanup);

const turkey: Food = { id: "turkey-1", name: "Turkey", role: "protein", unit: "oz",
  perUnit: { protein: 7, carbs: 0, fat: 1 }, status: "eats", updatedAt: "2026-10-01T00:00:00Z" };
const chicken: Food = { id: "chicken-1", name: "Chicken", role: "protein", unit: "oz",
  perUnit: { protein: 7, carbs: 0, fat: 1 }, status: "eats", updatedAt: "2026-10-01T00:00:00Z" };
const foods: Record<string, Food> = { "turkey-1": turkey, "chicken-1": chicken };

const slot: ResolvedSlot = {
  slot: "meal-2", time: "12:30", label: "Meal 2",
  meal: { id: "meal-x", name: "Turkey plate", slot: "meal-2", prepMinutes: 0, tags: [],
    components: [{ name: "Turkey", qty: 6, unit: "oz", role: "protein",
      macros: { kcal: 260, protein: 40, carbs: 0, fat: 5 }, foodKey: "food:turkey-1" }],
    macros: { kcal: 260, protein: 40, carbs: 0, fat: 5 } },
  components: [{ name: "Turkey", qty: 6, unit: "oz", role: "protein",
    macros: { kcal: 260, protein: 40, carbs: 0, fat: 5 }, foodKey: "food:turkey-1" }],
  macros: { kcal: 260, protein: 40, carbs: 0, fat: 5 }, eaten: false,
};

const chickenOption: SwapAlternative = { id: "plate:chicken", name: "Chicken plate", source: "Your foods",
  components: [{ name: "Chicken", qty: 6, unit: "oz", role: "protein",
    macros: { kcal: 250, protein: 42, carbs: 0, fat: 5 } }],
  macros: { kcal: 250, protein: 42, carbs: 0, fat: 5 }, proteinKey: "chicken-1", foodIds: ["chicken-1"] };

/** Expand the lone offered card (SuggestionCarousel: a tap grows it in place), then tap its own
 *  "Swap to this" inside the opened group. */
async function tapSwap() {
  const toggle = await screen.findByRole("button", { expanded: false });
  fireEvent.click(toggle);
  const open = await screen.findByRole("group", { name: "Chicken plate" });
  fireEvent.click(within(open).getByRole("button", { name: "Swap to this" }));
}

beforeEach(() => {
  mocked.swapAlternatives.mockReset().mockReturnValue([chickenOption]);
  mocked.loadEligibleLocalFoodIds.mockReset().mockResolvedValue(new Set(["turkey-1", "chicken-1"]));
  mocked.foodSignal.mockReset().mockImplementation((input) => ({ ...input, clientEventId: "evt", at: "2026-10-06T12:30:00Z" }));
  mocked.sendFoodSignals.mockReset().mockResolvedValue(true);
  bindAccount("account-a");
});
afterEach(() => { unbindAccount(); });

describe("MealSwapSheet signals (Phase 18 W6)", () => {
  it("sends swapped_away and picked sharing one slateId after a successful swap", async () => {
    const onSelect = vi.fn().mockResolvedValue(undefined);
    render(<MealSwapSheet slot={slot} date="2026-10-06"
      target={{ kcal: 260, protein: 40, carbs: 0, fat: 5 }} foods={foods} currentOverride={false}
      onSelect={onSelect} onReset={async () => {}} onEdit={() => {}} onClose={() => {}} />);

    await tapSwap();

    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(chickenOption));
    await waitFor(() => expect(mocked.sendFoodSignals).toHaveBeenCalledTimes(1));

    const sentEvents = mocked.sendFoodSignals.mock.calls[0][0];
    expect(sentEvents).toHaveLength(2);
    const [away, picked] = sentEvents;
    expect(away).toMatchObject({ surface: "swap_sheet", kind: "swapped_away", chosenKey: "food:turkey-1",
      offeredKeys: ["food:chicken-1", "food:turkey-1"], occasion: "lunch" });
    expect(picked).toMatchObject({ surface: "swap_sheet", kind: "picked", chosenKey: "food:chicken-1",
      offeredKeys: ["food:chicken-1", "food:turkey-1"], occasion: "lunch" });
    expect(away.slateId).toBe(picked.slateId);
  });

  it("stamps both events with the tap's own time, not the save's completion time " +
    "(Sol review r4 requested check: a slow swap that straddles midnight)", async () => {
    let resolveSelect: (() => void) | undefined;
    const onSelect = vi.fn().mockImplementation(() => new Promise<void>((resolve) => { resolveSelect = resolve; }));
    render(<MealSwapSheet slot={slot} date="2026-10-06"
      target={{ kcal: 260, protein: 40, carbs: 0, fat: 5 }} foods={foods} currentOverride={false}
      onSelect={onSelect} onReset={async () => {}} onEdit={() => {}} onClose={() => {}} />);

    const toggle = await screen.findByRole("button", { expanded: false });
    fireEvent.click(toggle);
    const open = await screen.findByRole("group", { name: "Chicken plate" });

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-06T23:59:30Z"));
      fireEvent.click(within(open).getByRole("button", { name: "Swap to this" }));
      // `onSelect` is only invoked after `write()`'s own first await (loadEligibleLocalFoodIds)
      // actually runs a microtask tick; resolving before that would resolve nothing.
      await waitFor(() => expect(onSelect).toHaveBeenCalled());
      vi.setSystemTime(new Date("2026-10-07T00:00:30Z"));
      resolveSelect?.();
      await waitFor(() => expect(mocked.sendFoodSignals).toHaveBeenCalledTimes(1));
    } finally { vi.useRealTimers(); }

    expect(mocked.foodSignal).toHaveBeenCalledTimes(2);
    for (const call of mocked.foodSignal.mock.calls) {
      expect(call[1]).toBeInstanceOf(Date);
      expect((call[1] as Date).toISOString()).toBe("2026-10-06T23:59:30.000Z");
    }
  });

  it("sends nothing when the swap fails (the write never committed)", async () => {
    const onSelect = vi.fn().mockRejectedValue(new Error("Your food rules changed. Reopen swaps to see safe choices."));
    render(<MealSwapSheet slot={slot} date="2026-10-06"
      target={{ kcal: 260, protein: 40, carbs: 0, fat: 5 }} foods={foods} currentOverride={false}
      onSelect={onSelect} onReset={async () => {}} onEdit={() => {}} onClose={() => {}} />);

    await tapSwap();

    await waitFor(() => expect(onSelect).toHaveBeenCalled());
    expect(mocked.sendFoodSignals).not.toHaveBeenCalled();
  });

  it("still sends signals with no viewed date prop: localDate comes from the phone's clock at " +
    "the tap (foodSignal), not from the viewed plan date", async () => {
    const onSelect = vi.fn().mockResolvedValue(undefined);
    render(<MealSwapSheet slot={slot} target={{ kcal: 260, protein: 40, carbs: 0, fat: 5 }}
      foods={foods} currentOverride={false} onSelect={onSelect} onReset={async () => {}}
      onEdit={() => {}} onClose={() => {}} />);

    await tapSwap();

    await waitFor(() => expect(onSelect).toHaveBeenCalled());
    await waitFor(() => expect(mocked.sendFoodSignals).toHaveBeenCalledTimes(1));
  });
});

describe("MealSwapSheet with no target (UI audit 2026-10-07)", () => {
  it("says why there is nothing to swap in, rather than showing an empty body", async () => {
    render(<MealSwapSheet slot={slot} date="2026-10-06" target={undefined} foods={foods} currentOverride={false}
      onSelect={async () => {}} onReset={async () => {}} onEdit={() => {}} onClose={() => {}} />);
    expect(await screen.findByText(/sized to your daily targets, which appear once your profile is complete/)).toBeTruthy();
    expect(screen.queryByRole("status", { name: /Checking/ })).toBeNull();
  });
});
