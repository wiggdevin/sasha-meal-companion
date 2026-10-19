// @vitest-environment jsdom
/**
 * W030 on the Today page (audit 2026-10-10 F18):
 *   A069: a meal card's ingredient draft and its calorie preview reset when the viewed date
 *         changes, so a Monday draft can never be saved onto Tuesday.
 *   P06:  a burst of sync passes runs at most one eligible-set read in flight plus one follow-up,
 *         never one server snapshot recompute per pass.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Today from "@/app/page";
import { SYNCED_EVENT } from "@/lib/sync/client";
import type { ResolvedDay, ResolvedSlot, Store } from "@/lib/types";
import { resetTestAccount } from "@/tests/helpers/account";

const eligible = vi.hoisted(() => vi.fn(async (..._args: unknown[]): Promise<Set<string>> => new Set()));
const pinned = vi.hoisted(() => ({ store: null as unknown as Store, day: null as unknown as ResolvedDay }));
const resolvedWith = vi.hoisted(() => ({ values: [] as (ReadonlySet<string> | undefined)[] }));
const OTHER_DATE = "2026-01-02";
const THIRD_DATE = "2026-01-03";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ back: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/store", async (original) => ({
  ...(await original<typeof import("@/lib/store")>()),
  loadStore: () => pinned.store, saveStore: () => {}, getDay: () => null,
}));
vi.mock("@/lib/resolve", async (original) => ({
  ...(await original<typeof import("@/lib/resolve")>()),
  resolveDay: (_store: Store, date: string, _water: number, eligibleIds?: ReadonlySet<string>) => {
    resolvedWith.values.push(eligibleIds);
    return { ...pinned.day, date };
  },
}));
vi.mock("@/lib/foods/eligible-client", async (original) => ({
  ...(await original<typeof import("@/lib/foods/eligible-client")>()),
  loadEligibleLocalFoodIds: eligible,
}));
vi.mock("@/lib/foods/today-starter", () => ({ refreshStarterGate: async () => "ready" }));
vi.mock("@/lib/log/today-state", async (original) => ({
  ...(await original<typeof import("@/lib/log/today-state")>()), savingElsewhere: async () => null,
}));
vi.mock("@/lib/log-commit-client", async (original) => ({
  ...(await original<typeof import("@/lib/log-commit-client")>()),
  logEntryStates: async () => ({ pending: new Set<string>(), stale: new Set<string>(),
    unsaved: new Set<string>(), lost: new Set<string>() }),
}));
vi.mock("@/lib/estimator-client", async (original) => ({
  ...(await original<typeof import("@/lib/estimator-client")>()), fetchProposals: async () => null,
}));
vi.mock("@/lib/profile/onboarding-state", async (original) => ({
  ...(await original<typeof import("@/lib/profile/onboarding-state")>()),
  readAccountOnboardingRow: async () => undefined,
}));
vi.mock("@/lib/supabase/client", () => ({ browserClient: () => ({}) }));
vi.mock("@/lib/health/capability-client", () => ({ useBodyCapability: () => "enabled" }));
vi.mock("@/components/TodayDayStrip", () => ({
  default: ({ onSelect }: { onSelect: (date: string) => void }) => <>
    <button type="button" onClick={() => onSelect(OTHER_DATE)}>pick other date</button>
    <button type="button" onClick={() => onSelect(THIRD_DATE)}>pick a third date</button>
  </>,
}));

const SLOT: ResolvedSlot = { slot: "meal-1", label: "Meal 1", time: "12:30",
  meal: { id: "suggested:x:meal-1", slot: "meal-1", name: "Rice bowl", components: [],
    macros: { kcal: 610, protein: 53, carbs: 79, fat: 6 }, prepMinutes: 0, tags: [] },
  components: [
    { name: "Chicken breast", qty: 150, unit: "g", role: "protein",
      macros: { kcal: 248, protein: 46, carbs: 0, fat: 5 } },
    { name: "Rice", qty: 1.5, unit: "cup", role: "carb",
      macros: { kcal: 362, protein: 7, carbs: 79, fat: 1 } },
  ],
  macros: { kcal: 610, protein: 53, carbs: 79, fat: 6 }, eaten: false };
const ZERO = { kcal: 0, protein: 0, carbs: 0, fat: 0 };

async function renderToday(slots: ResolvedSlot[] = []): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  pinned.store = { version: 1, firstOpenedAt: date, days: {}, foods: {},
    settings: { trainingKcal: null, restKcal: null, proteinG: null, proteinLocked: true,
      slotTimes: {}, shiftMinutes: 0, changedAt: null } };
  pinned.day = { date, dayType: "rest", isFloorDay: false, targets: null, slots, extras: [],
    consumed: ZERO, waterCups: 0 };
  await act(async () => { render(<Today />); });
}

beforeEach(async () => {
  await resetTestAccount();
  eligible.mockReset();
  HTMLElement.prototype.scrollTo = () => {};
  vi.stubGlobal("ResizeObserver", class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  window.history.replaceState(null, "", "/");
  resolvedWith.values.length = 0;
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const calories = () => (document.querySelector("[data-meal-calories]") as HTMLElement).textContent ?? "";

describe("A069: meal cards are keyed by the viewed date", () => {
  it("drops the ingredient draft and the calorie preview on a date switch", async () => {
    eligible.mockResolvedValue(new Set());
    await renderToday([SLOT]);
    fireEvent.click(await screen.findByRole("button", { name: "Expand Meal 1" }));
    fireEvent.click(await screen.findByRole("button", { name: "Increase Rice" }));
    expect(calories()).toContain("670");
    expect(screen.getByRole("button", { name: "Save ingredients" })).toBeTruthy();
    act(() => { fireEvent.click(screen.getByRole("tab", { name: "Calendar" })); }); // the strip lives on the Calendar face
    act(() => { fireEvent.click(screen.getByRole("button", { name: "pick other date" })); });
    await waitFor(() => expect(calories()).toContain("610"));
    expect(screen.queryByRole("button", { name: "Save ingredients" })).toBeNull();
  });
});

describe("P06: sync passes do not stack eligible reads", () => {
  it("runs one read in flight and one follow-up for a burst of passes", async () => {
    eligible.mockResolvedValue(new Set());
    await renderToday();
    await waitFor(() => expect(eligible).toHaveBeenCalledTimes(1));
    let release: (value: Set<string>) => void = () => {};
    eligible.mockImplementation(() => new Promise<Set<string>>((resolve) => { release = resolve; }));
    act(() => { for (let pass = 0; pass < 5; pass += 1) window.dispatchEvent(new Event(SYNCED_EVENT)); });
    await waitFor(() => expect(eligible).toHaveBeenCalledTimes(2));
    await act(async () => { release(new Set()); });
    await waitFor(() => expect(eligible).toHaveBeenCalledTimes(3));
    await act(async () => { release(new Set()); });
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 50); }); });
    expect(eligible).toHaveBeenCalledTimes(3);
  });
});
