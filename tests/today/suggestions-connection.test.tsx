// @vitest-environment jsdom
/**
 * Phase 17 O2 hand-off: when Today's verified read fails only because there is no connection and
 * no usable stored snapshot, the plan says "Suggestions need a connection" (one calm line), never
 * an empty plan; any other failure keeps the food-rules notice, and a good read shows neither.
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Today from "@/app/page";
import { SUGGESTIONS_NEED_CONNECTION } from "@/lib/meals/snapshot";
import type { ResolvedDay, Store } from "@/lib/types";
import { resetTestAccount } from "@/tests/helpers/account";

const eligible = vi.hoisted(() => vi.fn(async (..._args: unknown[]): Promise<Set<string>> => new Set()));
const pinned = vi.hoisted(() => ({ store: null as unknown as Store, day: null as unknown as ResolvedDay }));

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
  resolveDay: (_store: Store, date: string) => ({ ...pinned.day, date }),
}));
vi.mock("@/lib/foods/eligible-client", async (original) => ({
  ...(await original<typeof import("@/lib/foods/eligible-client")>()),
  loadEligibleLocalFoodIds: eligible,
}));
const gate = vi.hoisted(() => ({ status: "ready" as string }));
vi.mock("@/lib/foods/today-starter", () => ({ refreshStarterGate: async () => gate.status }));
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

beforeEach(async () => {
  await resetTestAccount();
  eligible.mockReset();
  gate.status = "ready";
  HTMLElement.prototype.scrollTo = () => {};
  vi.stubGlobal("ResizeObserver", class { observe(): void {} unobserve(): void {} disconnect(): void {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Today suggestions without a connection", () => {
  it("says suggestions need a connection when the snapshot read fails offline", async () => {
    eligible.mockRejectedValue(new Error(SUGGESTIONS_NEED_CONNECTION));
    await renderToday();
    const notice = await screen.findByText("Suggestions need a connection");
    expect(notice.closest("[data-tone]")?.getAttribute("data-tone")).toBe("info");
    expect(screen.queryByText(/couldn’t verify your food rules/)).toBeNull();
  });

  it("says it too when the starter gate fails on a fresh offline visit", async () => {
    gate.status = "unavailable";
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    await renderToday();
    await screen.findByText("Suggestions need a connection");
    expect(screen.queryByText(/couldn’t verify your food rules/)).toBeNull();
    expect(eligible).not.toHaveBeenCalled();
  });

  it("keeps the food-rules notice when the gate fails online", async () => {
    gate.status = "unavailable";
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    await renderToday();
    await screen.findByText(/couldn’t verify your food rules/);
    expect(screen.queryByText("Suggestions need a connection")).toBeNull();
  });

  it("keeps the food-rules notice for any other failed read", async () => {
    eligible.mockRejectedValue(new Error("Couldn’t check your food rules. Try again."));
    await renderToday();
    await screen.findByText(/couldn’t verify your food rules/);
    expect(screen.queryByText("Suggestions need a connection")).toBeNull();
  });

  it("shows neither notice after a successful read", async () => {
    eligible.mockResolvedValue(new Set(["tofu"]));
    await renderToday();
    await waitFor(() => expect(eligible).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByText("Suggestions need a connection")).toBeNull();
    expect(screen.queryByText(/couldn’t verify your food rules/)).toBeNull();
  });
});
