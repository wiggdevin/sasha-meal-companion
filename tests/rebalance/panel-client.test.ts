/**
 * Phase 19 R2 / §7 "Flag" and "Re-read": useRebalancePanel fails closed on every answer but an
 * explicit `{ enabled: true }`, and re-reads the store (no projected value, no cache) on every
 * render.
 */
// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { clearMeal } from "@/lib/today/meal-actions";
import { loadStore, saveStore } from "@/lib/store";
import { SYNCED_EVENT } from "@/lib/sync/client";
import { useRebalancePanel } from "@/lib/rebalance/panel-client";
import { resolveDay } from "@/lib/resolve";
import { starterChoices, starterDefaultIds, starterFood } from "@/lib/foods/starter";
import { todayResolveInputs, type TodayLive } from "@/lib/today/resolve-inputs";
import type { AcceptedRecipeSelection } from "@/lib/shopping/preview-contract";
import type { ResolvedDay, Store } from "@/lib/types";

afterEach(cleanup);

const reads = vi.hoisted(() => ({ access: vi.fn() }));
vi.mock("@/lib/device/account", async (original) => ({
  ...(await original<typeof import("@/lib/device/account")>()),
  accountFetch: reads.access,
}));

// A call-through capture of every resolveDay the hook runs: the real function, recorded.
const captured = vi.hoisted(() => ({ days: [] as unknown[] }));
vi.mock("@/lib/resolve", async (original) => {
  const actual = await original<typeof import("@/lib/resolve")>();
  return { ...actual, resolveDay: (...args: Parameters<typeof actual.resolveDay>) => {
    const day = actual.resolveDay(...args);
    captured.days.push(day);
    return day;
  } };
});

const DATE = "2026-10-06";

/** An onboarded account whose Eats are the reviewed starter foods, so meals really generate. */
function starterAccount(ruleReviewReady: boolean): { store: Store; foods: Record<string, unknown> } {
  const rules = { avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [], conditions: [], notes: null };
  const foods = Object.fromEntries(starterDefaultIds(starterChoices([], rules)).map((id) => {
    const food = starterFood(id, "eats"); return [food.id, food];
  }));
  const store = loadStore();
  store.foods = foods as Store["foods"];
  store.settings = { ...store.settings, onboardedAt: "2026-09-26T12:00:00Z", trainingWeekdays: [],
    mealsPerDay: 3, ruleReviewReady,
    activeTargetProfile: { revision: 1,
      training: { kcal: 2000, protein: 140, carbs: 180, fat: 72 },
      rest: { kcal: 2000, protein: 140, carbs: 180, fat: 72 },
      pins: { trainingKcal: null, restKcal: null, proteinG: null } } } as Store["settings"];
  delete store.days[DATE];
  return { store, foods };
}

/** One accepted recipe for Meal 2 on DATE, with every macro known. */
function acceptedRow(): AcceptedRecipeSelection {
  const nutrient = (value: number) => ({ value, status: "known" as const, sourceRevisionId: 1 });
  return { id: "sel-1", localDate: DATE, slotId: "meal-2", recipeId: "r-1", recipeRevisionId: "rr-1",
    recipeName: "Test stew", servingFraction: 1, ingredientSnapshot: [],
    nutritionSnapshot: { kcal: nutrient(777), protein: nutrient(41), carbs: nutrient(80), fat: nutrient(22) },
    exactFitAvailable: true, approximateFitAvailable: true, evidenceIssues: [], planRevision: 1 };
}

const slotKcal = (day: ResolvedDay, slot: string) => day.slots.find((entry) => entry.slot === slot)?.macros.kcal ?? 0;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  bindAccount("11111111-1111-4111-8111-111111111111");
  reads.access.mockReset();
  // The panel hides itself off the device's local today (classifyDay's `hidden` row), read from
  // a real `new Date()` inside the hook — this file never mocked it. Root-caused 2026-10-06
  // against main CI run 37549462257 and PR #476's run 37553362941: CI runs in UTC, and once
  // Pacific evening has rolled past midnight UTC, the device's real local "today" is one day
  // ahead of the hardcoded `DATE` below, so the panel reads every date here as not-today and
  // stays hidden forever — confirmed in a Linux/UTC repro: `readRebalanceAccess` still resolves
  // `enabled: true`, but `classifyDay`'s date check hides it before that matters. Pinning the
  // clock to local noon on `DATE` (no "Z": parsed in whatever zone the process runs in, the same
  // zone the hook's own `new Date()` reads) keeps the test's notion of "today" correct in every
  // timezone, not just the ones near UTC — a UTC pin broke at UTC+12 (Sol R1 review).
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${DATE}T12:00:00`));
});
afterEach(() => { vi.useRealTimers(); unbindAccount(); });

describe("fail-closed gate", () => {
  it("shows once an explicit enabled: true answers", async () => {
    reads.access.mockResolvedValue(json({ enabled: true }));
    const { result } = renderHook(() => useRebalancePanel(DATE));
    expect(result.current).toEqual({ show: false });
    await waitFor(() => expect(result.current.show).toBe(true));
  });

  it.each([
    ["401 signed out", () => json({ error: "unauthorized" }, 401)],
    ["404 route not deployed yet", () => json({}, 404)],
    ["500 other non-ok", () => json({}, 500)],
    ["malformed body", () => new Response("not json", { status: 200 })],
    ["enabled missing", () => json({})],
    ["enabled false", () => json({ enabled: false })],
    ["enabled not a boolean", () => json({ enabled: "yes" })],
  ])("stays hidden on %s", async (_label, respond) => {
    reads.access.mockResolvedValue(respond());
    const { result } = renderHook(() => useRebalancePanel(DATE));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(result.current).toEqual({ show: false });
  });

  it("stays hidden on a timeout", async () => {
    reads.access.mockRejectedValue(new Error("No answer within 6000 ms."));
    const { result } = renderHook(() => useRebalancePanel(DATE));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(result.current).toEqual({ show: false });
  });

  it("never falls back to on in a development/localhost environment", async () => {
    vi.stubEnv("NODE_ENV", "development");
    try {
      reads.access.mockResolvedValue(json({}, 404));
      const { result } = renderHook(() => useRebalancePanel(DATE));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(result.current).toEqual({ show: false });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("re-read", () => {
  it("reflects a clear made through the same clearMeal + saveStore path Today uses, with no cache", async () => {
    reads.access.mockResolvedValue(json({ enabled: true }));
    const store = loadStore();
    store.settings = { ...store.settings, trainingWeekdays: [], mealsPerDay: 3, ruleReviewReady: true,
      activeTargetProfile: { revision: 1,
        training: { kcal: 2000, protein: 100, carbs: 200, fat: 70 },
        rest: { kcal: 2000, protein: 100, carbs: 200, fat: 70 },
        pins: { trainingKcal: null, restKcal: null, proteinG: null } } } as typeof store.settings;
    store.days[DATE] = { date: DATE, itemOverrides: {
      "meal-1": { baseMealId: null, title: "Oats", components: [{ name: "Oats", qty: 1, unit: "whole",
        role: "free", macros: { kcal: 500, protein: 25, carbs: 62, fat: 11 } }] },
      "meal-2": { baseMealId: null, title: "Lunch", components: [{ name: "Lunch", qty: 1, unit: "whole",
        role: "free", macros: { kcal: 600, protein: 30, carbs: 75, fat: 13 } }] },
    } };
    saveStore(store);

    const { result, rerender } = renderHook(() => useRebalancePanel(DATE));
    await waitFor(() => expect(result.current.show).toBe(true));
    expect(result.current.show && result.current.cards.some((card) => card.slot === "meal-2")).toBe(true);

    const before = loadStore();
    const cleared = { ...before,
      days: { ...before.days, [DATE]: { ...before.days[DATE],
        itemOverrides: { ...before.days[DATE].itemOverrides,
          "meal-2": clearMeal(before.days[DATE].itemOverrides?.["meal-2"], null) } } } };
    saveStore(cleared);
    rerender();

    expect(result.current.show && result.current.cards.some((card) => card.slot === "meal-2")).toBe(false);
  });

  it("resolves a generated slot's kcal with the same eligibleFoodIds Today used (Sol R2 round 1, WARN)", async () => {
    // mockImplementation, not mockResolvedValue: each render here mounts its own hook, and a
    // Response's body can only be read once — a single shared instance would starve the second.
    reads.access.mockImplementation(async () => json({ enabled: true }));
    const { store, foods } = starterAccount(true);
    saveStore(store);

    // Without eligibleFoodIds (as it was before this fix), the generator has nothing to build
    // from: every meal slot's kcal reads as 0.
    const empty = renderHook(() => useRebalancePanel(DATE));
    await waitFor(() => expect(empty.result.current.show).toBe(true));
    const cardsEmpty = empty.result.current.show ? empty.result.current.cards : [];
    expect(cardsEmpty.length).toBeGreaterThan(0);
    expect(cardsEmpty.every((card) => card.kcal === 0)).toBe(true);

    // The same set Today's own resolveDay call already resolved with: every slot generates a real
    // meal, and the panel's cards carry the same kcal Today's own cards would.
    const withIds = renderHook(() => useRebalancePanel(DATE, { eligibleFoodIds: new Set(Object.keys(foods)),
      accepted: null, recipeAccessEnabled: false, ruleReviewReady: true }));
    await waitFor(() => expect(withIds.result.current.show).toBe(true));
    const cardsWithIds = withIds.result.current.show ? withIds.result.current.cards : [];
    expect(cardsWithIds.length).toBeGreaterThan(0);
    expect(cardsWithIds.some((card) => card.kcal > 0)).toBe(true);
  });

  it("re-renders on SYNCED_EVENT", async () => {
    reads.access.mockResolvedValue(json({ enabled: true }));
    const { result } = renderHook(() => useRebalancePanel(DATE));
    await waitFor(() => expect(result.current.show).toBe(true));
    act(() => { window.dispatchEvent(new Event(SYNCED_EVENT)); });
    // The hook re-ran its pipeline rather than throwing or going stale.
    expect(result.current.show).toBe(true);
  });
});

describe("Today and the panel resolve the same day (Sol R2 re-plan)", () => {
  type Eligible = "absent" | "empty" | "populated";
  type Accepted = "disabled" | "current-date" | "stale-date";
  const live = (foods: Record<string, unknown>, eligible: Eligible, accepted: Accepted, ready: boolean): TodayLive => ({
    eligibleFoodIds: eligible === "absent" ? undefined
      : eligible === "empty" ? new Set<string>() : new Set(Object.keys(foods)),
    accepted: { date: accepted === "stale-date" ? "2026-10-05" : DATE, rows: [acceptedRow()] },
    recipeAccessEnabled: accepted !== "disabled",
    ruleReviewReady: ready,
  });
  const matrix: [Eligible, Accepted, boolean][] = [];
  for (const eligible of ["absent", "empty", "populated"] as const) {
    for (const accepted of ["disabled", "current-date", "stale-date"] as const) {
      for (const ready of [true, false]) matrix.push([eligible, accepted, ready]);
    }
  }

  it.each(matrix)("eligible %s, accepted %s, live ready %s (stored readiness the opposite)",
    async (eligible, accepted, ready) => {
      reads.access.mockImplementation(async () => json({ enabled: true }));
      const { store, foods } = starterAccount(!ready);
      saveStore(store);
      const inputs = live(foods, eligible, accepted, ready);
      const today = resolveDay(...todayResolveInputs(loadStore(), DATE, inputs).args);
      captured.days.length = 0;
      renderHook(() => useRebalancePanel(DATE, inputs));
      await waitFor(() => expect(captured.days.length).toBeGreaterThan(0));
      expect(captured.days.at(-1)).toEqual(today);
    });

  it("is not vacuous: readiness changes generated kcal, and an accepted recipe changes its slot", () => {
    const { store, foods } = starterAccount(false);
    const day = (inputs: TodayLive) => resolveDay(...todayResolveInputs(store, DATE, inputs).args);
    const ready = day(live(foods, "populated", "disabled", true));
    const unready = day(live(foods, "populated", "disabled", false));
    expect(slotKcal(ready, "meal-1")).toBeGreaterThan(0);
    expect(slotKcal(unready, "meal-1")).not.toBe(slotKcal(ready, "meal-1"));
    const withRecipe = day(live(foods, "populated", "current-date", true));
    expect(slotKcal(withRecipe, "meal-2")).toBe(777);
    expect(slotKcal(ready, "meal-2")).not.toBe(777);
    expect(slotKcal(day(live(foods, "populated", "stale-date", true)), "meal-2")).not.toBe(777);
  });
});
