// @vitest-environment jsdom
/** Render contract for Today cards and their asynchronous page states. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import SlotCard from "@/components/SlotCard";
import Today from "@/app/page";
import { generatedProteinAvailabilityForDay } from "@/lib/resolve";
import type { Macros, Meal, ResolvedDay, ResolvedSlot, Store, StoredDay } from "@/lib/types";
import { resetTestAccount } from "@/tests/helpers/account";
import { closeAccount } from "@/lib/device/account";
import { SYNCED_EVENT } from "@/lib/sync/client";
const mealEdit = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({})));
const eligible = vi.hoisted(() => vi.fn(async (_account: unknown,
  foods: Record<string, unknown>) => new Set(Object.keys(foods))));
const navigation = vi.hoisted(() => ({ push: vi.fn() }));
const resolvedEligibility = vi.hoisted(() => ({ values: [] as (ReadonlySet<string> | undefined)[] }));
const ZERO: Macros = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
/** A card flow mounts once the card's detail has blurred out (components/MealCardTray.tsx). */
const SLOW = { timeout: 3000 };

const MEAL: Meal = {
  id: "meal:oats", name: "Oats and berries", slot: "meal-1",
  components: [{ name: "Oats", qty: 80, unit: "g", role: "carb",
    macros: { kcal: 300, protein: 10, carbs: 54, fat: 6 } }],
  macros: { kcal: 300, protein: 10, carbs: 54, fat: 6 }, prepMinutes: 5, tags: [],
};

/** T1's `ResolvedSlot` (lanes/T1/handoff.md): an empty scheduled slot carries `meal: null`. */
const EMPTY_SLOT: ResolvedSlot = {
  slot: "meal-1", time: "08:00", label: "Breakfast", meal: null, components: [],
  macros: ZERO, eaten: false,
};

const PLANNED_SLOT: ResolvedSlot = {
  ...EMPTY_SLOT, meal: MEAL, components: MEAL.components, macros: MEAL.macros,
};

const pinned = vi.hoisted(() => ({
  store: null as unknown as Store,
  day: null as unknown as ResolvedDay,
  elsewhere: null as { date: string; count: number } | null,
  swapTarget: null as Macros | null,
  storedDay: null as StoredDay | null,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ back: () => {}, push: navigation.push, replace: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store")>();
  return { ...actual, loadStore: () => pinned.store, saveStore: () => {}, getDay: () => pinned.storedDay };
});

vi.mock("@/lib/resolve", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/resolve")>();
  // The pinned day is the day under test, but `TodayDayStrip` resolves 57 dates through the same
  // function and keys each button by its own date. Answering every request with the one pinned
  // date made those keys identical (React's duplicate-key error in the run output), so the fixture
  // keeps its day and takes the date it was asked for.
  return { ...actual, resolveDay: (_store: Store, date: string, _water: number,
    eligibleIds?: ReadonlySet<string>) => {
    resolvedEligibility.values.push(eligibleIds);
    return { ...pinned.day, date };
  },
    scaledSlotTarget: (store: Store, date: string, dayType: ResolvedDay["dayType"], slot: ResolvedSlot["slot"]) =>
      pinned.swapTarget ?? actual.scaledSlotTarget(store, date, dayType, slot) };
});

vi.mock("@/lib/plan-day-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/plan-day-client")>()),
  saveMealEdit: mealEdit,
}));
vi.mock("@/lib/foods/eligible-client", async (original) => ({ ...(await original<object>()), loadEligibleLocalFoodIds: eligible }));
vi.mock("@/lib/foods/today-starter", () => ({ refreshStarterGate: async () => "ready" }));

vi.mock("@/lib/log/today-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/log/today-state")>();
  return { ...actual, savingElsewhere: async () => pinned.elsewhere };
});

vi.mock("@/lib/log-commit-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/log-commit-client")>();
  return {
    ...actual,
    logEntryStates: async () => ({
      pending: new Set<string>(), stale: new Set<string>(),
      unsaved: new Set<string>(), lost: new Set<string>(),
    }),
  };
});

vi.mock("@/lib/estimator-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/estimator-client")>();
  return { ...actual, fetchProposals: async () => null };
});

// `OnboardingInvite` asks the account's own row whether to invite; the answer is "no row, no
// invitation", which is what a signed-out render is. Pinning it keeps Supabase out of this file.
vi.mock("@/lib/profile/onboarding-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/profile/onboarding-state")>();
  return { ...actual, readAccountOnboardingRow: async () => undefined };
});

vi.mock("@/lib/supabase/client", () => ({ browserClient: () => ({}) }));
vi.mock("@/lib/health/capability-client", () => ({ useBodyCapability: () => "enabled" }));
vi.mock("@/lib/coach-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coach-client")>()),
  postTurn: vi.fn(async () => { throw new Error("No coach in this card test"); }),
}));

function isoDaysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function resolvedDay(over: Partial<ResolvedDay> = {}): ResolvedDay {
  return {
    date: isoDaysAgo(0), dayType: "rest", isFloorDay: false, targets: null,
    slots: [PLANNED_SLOT], extras: [], consumed: ZERO, waterCups: 0, ...over,
  };
}

function todayStore(over: Partial<Store> = {}): Store {
  return {
    version: 1, firstOpenedAt: isoDaysAgo(2), days: {}, foods: {},
    settings: { trainingKcal: null, restKcal: null, proteinG: null, proteinLocked: true,
      slotTimes: {}, shiftMinutes: 0, changedAt: null },
    ...over,
  };
}

/**
 * jsdom implements neither scrolling nor `ResizeObserver`; the day strip centres itself on mount
 * and watches its own width (TodayDayStrip.tsx:68,133). Neither decides anything asserted here.
 */
beforeEach(() => {
  HTMLElement.prototype.scrollTo = () => {};
  vi.stubGlobal("ResizeObserver", class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
});

/** Mount Today and let its four effects settle, so the page is past its `mounted` skeleton. */
async function renderToday(state: {
  store?: Partial<Store>; day?: Partial<ResolvedDay>;
  storedDay?: StoredDay;
  elsewhere?: { date: string; count: number } | null;
} = {}): Promise<void> {
  pinned.store = todayStore(state.store);
  pinned.day = resolvedDay(state.day);
  pinned.elsewhere = state.elsewhere ?? null;
  pinned.swapTarget = null;
  pinned.storedDay = state.storedDay ?? null;
  await act(async () => { render(<Today />); });
}

function slotCard(slot: ResolvedSlot): string {
  return renderToStaticMarkup(
    <SlotCard slot={slot} variant="focus" canSwap
      onToggleEaten={() => {}} onOpenSwap={() => {}} onOpenEdit={() => {}}
      onClear={() => {}} onDelete={() => {}} />,
  );
}

describe("SlotCard", () => {
  it("keeps the title and the time on an empty scheduled slot, and offers the two ways in", () => {
    const markup = slotCard(EMPTY_SLOT);
    expect(markup).toContain("Breakfast");
    expect(markup).toContain("Nothing planned yet.");
    expect(markup).toContain("Plan with Sasha");
    expect(markup).toContain("Log what you ate");
  });

  it("shows no tick, swap or edit control until a meal exists", () => {
    const empty = slotCard(EMPTY_SLOT);
    expect(empty).not.toContain("Mark eaten, Breakfast");
    expect(empty).not.toContain("Swap Breakfast");
    expect(empty).not.toContain("Expand Breakfast");
    // And all three are there the moment the slot carries a meal, so this is a state, not a typo.
    const planned = slotCard(PLANNED_SLOT);
    expect(planned).toContain("Mark eaten, Breakfast");
    expect(planned).toContain("Swap Breakfast");
    expect(planned).toContain("Expand Breakfast");
  });

  it("draws the planned meal, its macros, tick and actions", () => {
    const markup = slotCard(PLANNED_SLOT);
    expect(markup).toContain("Oats and berries");
    expect(markup).toContain("300 calories: 10 grams protein, 54 grams carbs, 6 grams fat");
    expect(markup).toContain("Mark eaten, Breakfast");
    expect(markup).toContain("More for Breakfast");
    expect(markup).toContain("Clear Breakfast");
    expect(markup).toContain("Delete Breakfast");
    expect(markup).not.toContain("Nothing planned yet.");
  });

  it("rounds displayed meal macros without changing the slot values", () => {
    const slot = { ...PLANNED_SLOT,
      macros: { kcal: 440.2, protein: 31.6, carbs: 52.199999999999996, fat: 11.9 } };
    const markup = slotCard(slot);
    expect(markup).toContain('aria-label="440 calories: 32 grams protein, 52 grams carbs, 12 grams fat"');
    expect(slot.macros.carbs).toBe(52.199999999999996);
  });

  it("flips the tick's label once the slot is eaten", () => {
    const markup = slotCard({ ...PLANNED_SLOT, eaten: true, eatenAt: "2026-09-20T08:10:00.000Z" });
    expect(markup).toContain("Eaten, Breakfast. Undo");
  });

  it("keeps the collapsed meal card limited to its primary meal information", () => {
    const markup = slotCard({ ...PLANNED_SLOT, note: "Keep this private" });
    expect(markup).not.toContain("Not logged");
    expect(markup).not.toContain("Keep this private");
  });

  /* The reschedule gesture is a real hold on a real element: the hook arms a 450 ms timer on
     `pointerdown` and only then previews a time, which is what puts the card in its rescheduling
     state (components/useMealReschedule.ts:69-93). */
  it("marks the card rescheduling once the hold arms, and only then", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { container } = render(
      <SlotCard slot={PLANNED_SLOT} variant="focus" canSwap
        onToggleEaten={() => {}} onOpenSwap={() => {}} onTimeChange={() => {}} />);
    const card = container.querySelector(".shell") as HTMLElement;
    expect(card.getAttribute("data-rescheduling")).toBeNull();
    fireEvent.pointerDown(card, { pointerType: "mouse", button: 0, clientX: 10, clientY: 300 });
    act(() => { vi.advanceTimersByTime(500); });
    expect(card.getAttribute("data-rescheduling")).toBe("true");
    fireEvent.pointerUp(document, { pointerType: "mouse" });
    vi.useRealTimers();
    cleanup();
  });
});

describe("Today, the page", () => {
  it("keeps health data in the overview without rendering the displaced Body card", async () => {
    await renderToday({ day: { targets: { kcal: 2_000, protein: 150, carbs: 200, fat: 70 } } });
    fireEvent.click(screen.getByRole("tab", { name: "Overview" })); // the face switch opens it
    for (const name of ["Active burn", "Sleep and recovery"]) expect(screen.getByRole("region", { name })).toBeTruthy();
    expect(document.querySelector('main section.shell a[href="/body"]')).toBeNull();
  });

  it("explains when changed Eats leave a slot with no protein at all", async () => {
    await resetTestAccount();
    const base = todayStore();
    const protein = (id: string) => ({ id, name: id, status: "eats" as const,
      role: "protein" as const, unit: "oz" as const,
      perUnit: { protein: 10, carbs: 0, fat: 1 }, updatedAt: "2026-09-27" });
    const store = { foods: { tofu: protein("tofu"), lentils: protein("lentils") },
      settings: { ...base.settings, ruleReviewReady: true, mealsPerDay: 3,
        activeTargetProfile: { revision: 1,
          training: { kcal: 1800, protein: 120, carbs: 180, fat: 60 },
          rest: { kcal: 1800, protein: 120, carbs: 180, fat: 60 } } } };
    expect(generatedProteinAvailabilityForDay(todayStore(store), isoDaysAgo(0),
      new Set(["tofu", "lentils"]))).toEqual({ available: 2, required: 2 }); // D5: A B A
    await renderToday({ store,
    day: { slots: [EMPTY_SLOT, { ...EMPTY_SLOT, slot: "meal-2" }, { ...EMPTY_SLOT, slot: "meal-3" }] } });
    expect(screen.queryByText(/eligible proteins? for/)).toBeNull();
    pinned.store = { ...pinned.store, foods: {} }; // D5: one protein repeats; none is short.
    await act(async () => { window.dispatchEvent(new Event(SYNCED_EVENT)); });
    const notice = await screen.findByText(/0 eligible proteins for 3 meals\./);
    expect(notice.textContent).toBe("0 eligible proteins for 3 meals. Star a protein you like in Foods › Favorites.");
    expect(within(notice).getByRole("link", { name: "Foods › Favorites" }).getAttribute("href")).toBe("/foods#eats");
  });

  afterEach(cleanup);

  it("rechecks eligible foods when sync hydrates Eats after the first Today read", async () => {
    await resetTestAccount();
    eligible.mockClear();
    await renderToday();
    await waitFor(() => expect(eligible).toHaveBeenCalledWith(expect.anything(), {}));
    const tofu = { id: "tofu", name: "Tofu", status: "eats" as const,
      role: "protein" as const, unit: "oz" as const,
      perUnit: { protein: 10, carbs: 0, fat: 1 }, updatedAt: "2026-09-27" };
    pinned.store = { ...pinned.store, foods: { tofu } };
    await act(async () => { window.dispatchEvent(new Event(SYNCED_EVENT)); });
    await waitFor(() => expect(eligible).toHaveBeenCalledWith(expect.anything(), { tofu }));
    expect(screen.queryByText(/Your foods are not yet verified/)).toBeNull();
  });

  it("does not start another eligible-food check while its account is closing", async () => {
    await resetTestAccount();
    eligible.mockClear();
    await renderToday();
    await waitFor(() => expect(eligible).toHaveBeenCalledTimes(1));
    eligible.mockClear();
    await act(async () => { closeAccount(); window.dispatchEvent(new Event(SYNCED_EVENT)); });
    expect(eligible).not.toHaveBeenCalled();
  });

  it("keeps the last good eligible IDs when a later sync check fails (item 4)", async () => {
    await resetTestAccount();
    const tofu = { id: "tofu", name: "Tofu", status: "eats" as const,
      role: "protein" as const, unit: "oz" as const,
      perUnit: { protein: 10, carbs: 0, fat: 1 }, updatedAt: "2026-09-27" };
    resolvedEligibility.values.length = 0;
    await renderToday({ store: { foods: { tofu } } });
    await waitFor(() => expect(resolvedEligibility.values.at(-1)?.has("tofu")).toBe(true));
    eligible.mockRejectedValueOnce(new Error("offline"));
    await act(async () => { window.dispatchEvent(new Event(SYNCED_EVENT)); });
    await waitFor(() => expect(screen.getByText(/couldn’t verify your food rules/)).toBeTruthy());
    expect(resolvedEligibility.values.at(-1)?.has("tofu")).toBe(true);
  });

  /** Empty accounts render scheduled slots without inherited meals. */
  it("draws empty slots, each with its two ways in, on a day with nothing planned", async () => {
    await renderToday({ day: { slots: [EMPTY_SLOT] } });
    expect(screen.getAllByText("Nothing planned yet.").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Plan with Sasha").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Log what you ate").length).toBeGreaterThan(0);
    expect(screen.queryByText(/That is not fat/)).toBeNull();
  });

  it("opens meal alternatives and writes components plus title to the viewed slot", async () => {
    await resetTestAccount();
    mealEdit.mockClear();
    const make = (id: string, role: "protein" | "carb" | "fat", perUnit: { protein: number; carbs: number; fat: number }) =>
      ({ id, name: id, role, unit: "oz" as const, perUnit, status: "eats" as const, updatedAt: "2026-09-26" });
    const foods = Object.fromEntries([
      ...["chicken", "turkey", "salmon", "tofu", "beans", "eggs"].map((id) =>
        [id, make(id, "protein", { protein: 10, carbs: 0, fat: 1 })]),
      ["rice", make("rice", "carb", { protein: 0, carbs: 10, fat: 0 })],
      ["oil", make("oil", "fat", { protein: 0, carbs: 0, fat: 5 })],
    ]);
    await renderToday({ store: { foods }, day: { slots: [PLANNED_SLOT] } });
    pinned.swapTarget = { kcal: 685, protein: 45, carbs: 70, fat: 20 };
    fireEvent.click(screen.getByRole("button", { name: "Swap Breakfast" }));
    const dialog = await screen.findByRole("region", { name: "Swap Breakfast" }, SLOW);
    expect(dialog.closest("[data-card-tray]")).toBeTruthy(); // in the card, in the detail's place
    fireEvent.click((await within(dialog).findAllByRole("button", { name: /calories/ }))[0]);
    fireEvent.click(await within(dialog).findByRole("button", { name: "Swap to this" }));
    await waitFor(() => expect(mealEdit).toHaveBeenCalledTimes(1));
    expect(mealEdit.mock.calls[0].slice(0, 2)).toEqual([pinned.day.date, "meal-1"]);
    expect(mealEdit.mock.calls[0][3]).toMatchObject({
      components: expect.arrayContaining([expect.objectContaining({ role: "protein" })]),
      title: expect.any(String),
    });
  });

  it("clears the override and title when returning to the suggested meal", async () => {
    await resetTestAccount();
    mealEdit.mockClear();
    await renderToday({ day: { slots: [PLANNED_SLOT] }, storedDay: { date: isoDaysAgo(0),
      itemOverrides: { "meal-1": { baseMealId: "meal:oats", components: MEAL.components, title: "Last choice" } } } });
    pinned.swapTarget = { kcal: 685, protein: 45, carbs: 70, fat: 20 };
    fireEvent.click(screen.getByRole("button", { name: "Swap Breakfast" }));
    fireEvent.click(await screen.findByRole("button", { name: "Back to the suggested meal" }, SLOW));
    await waitFor(() => expect(mealEdit).toHaveBeenCalledTimes(1));
    expect(mealEdit.mock.calls[0][3]).toMatchObject({ components: null, title: null });
  });

  it("opens the planning sheet over an empty meal without routing to Coach", async () => {
    navigation.push.mockClear();
    await renderToday({ day: { slots: [EMPTY_SLOT] } });
    fireEvent.click(screen.getByRole("button", { name: "Plan with Sasha" }));
    expect(screen.getByRole("region", { name: /Plan Meal 1 · 8:00 am/ })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Today's plan" })).toBeTruthy();
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it("shows a cleared fourth meal's planning target while other cards stay rebalanced", async () => {
    const date = isoDaysAgo(0);
    const store = todayStore();
    await renderToday({ store: { settings: { ...store.settings, mealsPerDay: 4,
      activeTargetProfile: { revision: 1,
        training: { kcal: 1800, protein: 120, carbs: 180, fat: 60 },
        rest: { kcal: 1800, protein: 120, carbs: 180, fat: 60 } } },
      days: { [date]: { date, itemOverrides: {
        "meal-4": { baseMealId: null, components: [], cleared: true },
      } } } },
    day: { slots: [{ ...EMPTY_SLOT, slot: "meal-4", label: "Meal 4", time: "20:00" }] } });
    expect(screen.getByRole("button", { name: "Plan with Sasha" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Plan with Sasha" }));
    // Room left, never as the meal's own numbers; no target chips inside the card.
    expect(await screen.findByText(/room left for this meal: about 450 kcal and 30 g protein/, {}, SLOW)).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Target for this meal" })).toBeNull();
    expect(screen.queryByText("Your targets will appear after your profile is ready")).toBeNull();
  });

  it("raises the saving elsewhere banner for meals filed under another day", async () => {
    await renderToday({ elsewhere: { date: isoDaysAgo(1), count: 2 } });
    expect(screen.getByText(/still saving\. Tap to see them\./)).toBeTruthy();
  });

  it("raises the floor-day banner only while quick meals are on", async () => {
    await renderToday({ day: { isFloorDay: true } });
    expect(screen.getByText(/Quick meals on\./)).toBeTruthy();
    cleanup();
    await renderToday();
    expect(screen.queryByText(/Quick meals on\./)).toBeNull();
  });
});
