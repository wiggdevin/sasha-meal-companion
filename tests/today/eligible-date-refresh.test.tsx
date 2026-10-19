// @vitest-environment jsdom
/**
 * Item 4 (coord.md UI-NEEDS W8): the eligible-set effect used to read only on mount, SYNCED_EVENT
 * and a manual retry -- never when the viewed date changed, so an open account could generate a
 * meal from a stale held set while paging dates. It also cleared the held set on ANY failed read,
 * including W8's transient 503 on a DB read error, wiping a set that was still good.
 *
 * This pins: a date change (debounced, so a fast swipe fires at most one re-read) re-runs the
 * read; a failed re-read keeps the previous read's outcome in effect rather than resetting to the
 * "unverified" state a null set would show.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Today from "@/app/page";
import type { ResolvedDay, Store } from "@/lib/types";
import { resetTestAccount } from "@/tests/helpers/account";

const eligible = vi.hoisted(() => vi.fn(async (..._args: unknown[]): Promise<Set<string>> => new Set()));
const pinned = vi.hoisted(() => ({ store: null as unknown as Store, day: null as unknown as ResolvedDay }));
const resolvedWith = vi.hoisted(() => ({ values: [] as (ReadonlySet<string> | undefined)[] }));
/** A stub in place of the real day strip (scroll-driven, not meaningfully testable in jsdom): two
 *  buttons that call `onSelect` with two different fixed dates, so a date change is a plain
 *  click -- two DIFFERENT dates, since clicking the SAME one twice is a same-value no-op for
 *  React state and would never re-run anything the second time (verified: the first cut of this
 *  test picked one date twice and never observed a second re-read). */
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

const ZERO = { kcal: 0, protein: 0, carbs: 0, fat: 0 };

async function renderToday(): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  pinned.store = { version: 1, firstOpenedAt: date, days: {}, foods: {},
    settings: { trainingKcal: null, restKcal: null, proteinG: null, proteinLocked: true,
      slotTimes: {}, shiftMinutes: 0, changedAt: null } };
  pinned.day = { date, dayType: "rest", isFloorDay: false, targets: null, slots: [], extras: [],
    consumed: ZERO, waterCups: 0 };
  await act(async () => { render(<Today />); });
}

function pickOtherDate(): void {
  // The strip lives on the Calendar face; its tab click flushes on its own so the face is live.
  act(() => { fireEvent.click(screen.getByRole("tab", { name: "Calendar" })); });
  act(() => { fireEvent.click(screen.getByRole("button", { name: "pick other date" })); });
}

function pickThirdDate(): void {
  fireEvent.click(screen.getByRole("button", { name: "pick a third date" }));
}

beforeEach(async () => {
  await resetTestAccount();
  eligible.mockReset();
  HTMLElement.prototype.scrollTo = () => {};
  vi.stubGlobal("ResizeObserver", class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  // `selectDate` writes `?d=` onto this shared jsdom `window.location` (history.replaceState) --
  // left over from a prior test's click, it would make the NEXT test's mount read that date
  // instead of "today" as its own first value (verified: this leaked across tests before).
  window.history.replaceState(null, "", "/");
  resolvedWith.values.length = 0;
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

/** A real, short wait — plain `setTimeout`, no fake-timer mode. Mixing `vi.useFakeTimers()` with
 *  the mount effect's own async chain (ready via a real microtask queue) proved to leak timer
 *  state across tests in this file; a real 300ms debounce is cheap enough to simply wait out. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

describe("the eligible-set effect re-reads on a date change", () => {
  it("re-reads once the debounce settles, not immediately on the click", async () => {
    eligible.mockResolvedValue(new Set(["tofu"]));
    await renderToday();
    await waitFor(() => expect(eligible).toHaveBeenCalledTimes(1));
    pickOtherDate();
    await act(() => wait(150)); // inside the debounce window
    expect(eligible).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(eligible).toHaveBeenCalledTimes(2), { timeout: 2000 });
  });

  it("coalesces several picks inside the debounce window into a single re-read", async () => {
    eligible.mockResolvedValue(new Set(["tofu"]));
    await renderToday();
    await waitFor(() => expect(eligible).toHaveBeenCalledTimes(1));
    pickOtherDate();
    await act(() => wait(150));
    act(() => { pickThirdDate(); }); // a second, DIFFERENT pick resets the debounce window
    await act(() => wait(150)); // 300ms since the FIRST pick, but only 150ms since the second
    expect(eligible).toHaveBeenCalledTimes(1); // neither pick has settled yet
    await waitFor(() => expect(eligible).toHaveBeenCalledTimes(2), { timeout: 2000 }); // one re-read, not two
  });

  it("surfaces a date-triggered read's failure (the Retry notice) without crashing", async () => {
    eligible.mockResolvedValueOnce(new Set(["tofu"]));
    await renderToday();
    await waitFor(() => expect(eligible).toHaveBeenCalledTimes(1));
    eligible.mockRejectedValueOnce(new Error("Couldn’t check your food rules. Try again."));
    pickOtherDate();
    await waitFor(() => expect(eligible).toHaveBeenCalledTimes(2), { timeout: 2000 });
    await screen.findByText(/couldn’t verify your food rules/);
    // The catch path no longer calls setEligibleFoodIds(null) at all (see the diff) -- it leaves
    // the previous read's held value exactly as it was; tests/cards/today.test.tsx pins that this
    // actually reaches a downstream consumer (resolveDay's own eligible-ids argument), not just
    // that the page keeps rendering.
  });

  it("replaces the held set with a date-triggered read's genuinely different answer", async () => {
    // Sol BLOCK on an earlier cut: a `rulesKey`-based identity check (replace only on a "changed
    // rules version") read a same-key, DIFFERENT-content answer as unchanged and kept serving the
    // old ids while paging dates -- the exact staleness bug this item exists to fix, reintroduced
    // by its own first attempt at an optimization. There is no such check now: every successful
    // read, including a date-triggered one, replaces the held set outright.
    eligible.mockResolvedValueOnce(new Set(["tofu"]));
    await renderToday();
    await waitFor(() => expect(resolvedWith.values.at(-1)?.has("tofu")).toBe(true));
    eligible.mockResolvedValueOnce(new Set(["beans"]));
    pickOtherDate();
    await waitFor(() => expect(eligible).toHaveBeenCalledTimes(2), { timeout: 2000 });
    // The downstream consumer (resolveDay's own eligible-ids argument) actually receives the
    // NEW answer -- "beans", not the stale "tofu" a suppressed replace would have kept serving.
    await waitFor(() => expect(resolvedWith.values.at(-1)?.has("beans")).toBe(true));
    expect(resolvedWith.values.at(-1)?.has("tofu")).toBe(false);
  });
});
