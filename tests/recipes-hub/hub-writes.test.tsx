// @vitest-environment jsdom
/**
 * The recipe widget's writes (audit 2026-10-04): a composed meal applies once per tap and never
 * lands as "Done." after an account change; the widget's day follows the clock to the next slot and
 * re-reads after a recipe is planned; and a Log it tap files under the meal of the tap, even when
 * the widget last rendered under the previous one.
 */
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountChanged, bindAccount, unbindAccount, currentAccountOrNull } from "@/lib/device/account";

const applyCoachAction = vi.hoisted(() => vi.fn());
const logDescribed = vi.hoisted(() => vi.fn());
const proposeDescribed = vi.hoisted(() => vi.fn());
const resolveDay = vi.hoisted(() => vi.fn());
const uploadPlanPhoto = vi.hoisted(() => vi.fn());
const readPlanPhoto = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coach/apply-client", () => ({ applyCoachAction }));
vi.mock("@/lib/plan/photo-log", () => ({ logDescribed, logPlatePhoto: vi.fn(), proposeDescribed,
  proposePlate: vi.fn(), commitPanelDraft: vi.fn() }));
vi.mock("@/lib/resolve", () => ({ resolveDay }));
vi.mock("@/lib/store", () => ({ loadStore: () => ({}) }));
vi.mock("@/lib/plan/inspire-client", async (original) => ({
  ...(await original<typeof import("@/lib/plan/inspire-client")>()), uploadPlanPhoto, readPlanPhoto,
}));
vi.mock("@/components/CoachComposedCard", () => ({
  default: ({ onAction }: { onAction: (action: unknown) => void }) =>
    <button type="button" onClick={() => onAction({ kind: "log_meal", actionId: crypto.randomUUID() })}>Log this meal</button>,
}));

import HubAnswer, { applyAs, hubApplyPrefix } from "@/components/recipes-hub/HubAnswer";
import { useHubAsk } from "@/components/recipes-hub/useHubAsk";
import { usePlanPhoto } from "@/components/plan/usePlanPhoto";
import { clearFlightOutcomesUnder, flightOutcome, resetFlightsForTests } from "@/components/single-flight";
import { msToNextSlot, readHubDay, useHubDay, type HubDay } from "@/components/recipes-hub/useHubDay";

const SLOTS = [
  { slot: "meal-1", label: "Meal 1", time: "08:00", meal: null, eaten: false },
  { slot: "meal-2", label: "Meal 2", time: "12:00", meal: null, eaten: false },
  { slot: "meal-3", label: "Meal 3", time: "18:00", meal: null, eaten: false },
];
const macros = (kcal: number) => ({ kcal, protein: 0, carbs: 0, fat: 0 });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  resetFlightsForTests();
  unbindAccount();
  bindAccount("user-a");
  applyCoachAction.mockReset();
  logDescribed.mockReset().mockResolvedValue({ ok: true, date: "2026-10-04" });
  proposeDescribed.mockReset().mockResolvedValue({ ok: false, message: "Nothing matched to log." });
  uploadPlanPhoto.mockReset();
  readPlanPhoto.mockReset();
  resolveDay.mockReset().mockImplementation((_store: unknown, date: string) =>
    ({ date, slots: SLOTS, targets: macros(2000), consumed: macros(500) }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("a composed meal from the recipe widget", () => {
  const DAY: HubDay = { date: "2026-10-04", remaining: macros(1500), slot: "meal-2", time: "12:00", label: "Meal 2" };

  function mount(over: Record<string, unknown> = {}) {
    const opening = currentAccountOrNull();
    const ask = {
      response: { messages: [], composed: [{ wish: "A wrap", items: [{ foodRefId: "f1" }] }] },
      catalog: null, asked: { label: "A wrap", text: "A wrap" }, loading: false, reading: false, error: null, ...over,
      confirm: null, logged: null, busy: false, photoRead: null,
      photo: { logging: null, shown: null },
      account: () => (opening && currentAccountOrNull()?.epoch === opening.epoch ? opening : null),
    };
    return render(<HubAnswer ask={ask as never} day={DAY} />);
  }

  it("applies once when its button is tapped twice in the same tick", async () => {
    const pending = deferred<unknown>();
    applyCoachAction.mockReturnValue(pending.promise);
    mount();
    const button = screen.getByRole("button", { name: "Log this meal" });
    await act(async () => { fireEvent.click(button); fireEvent.click(button); });
    expect(applyCoachAction).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve({ status: "applied" }); });
    expect(screen.getByText("Done.")).toBeTruthy();
  });

  it("never says Done. for a write that settled after an account change", async () => {
    const pending = deferred<unknown>();
    applyCoachAction.mockReturnValue(pending.promise);
    mount();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Log this meal" })); });
    bindAccount("user-b");
    await act(async () => { pending.resolve({ status: "applied" }); });
    expect(screen.queryByText("Done.")).toBeNull();
    expect(screen.getByText(/Account changed/)).toBeTruthy();
  });

  it("sends nothing once the account has changed", async () => {
    mount();
    bindAccount("user-b");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Log this meal" })); });
    expect(applyCoachAction).not.toHaveBeenCalled();
  });

  it("sends one action when the widget is closed mid-save, opened again and tapped (audit r4)", async () => {
    const pending = deferred<unknown>();
    applyCoachAction.mockReturnValue(pending.promise);
    const first = mount();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Log this meal" })); });
    first.unmount();
    mount();
    expect(screen.getByText("Saving…")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Log this meal" })); });
    expect(applyCoachAction).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve({ status: "applied" }); });
    expect(screen.queryByText("Saving…")).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Log this meal" })); });
    expect(applyCoachAction).toHaveBeenCalledTimes(2);
  });

  it("shows Done. on a widget that mounts after the apply already settled (audit f2 MAJOR)", async () => {
    const pending = deferred<unknown>();
    applyCoachAction.mockReturnValue(pending.promise);
    const first = mount();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Log this meal" })); });
    first.unmount();
    await act(async () => { pending.resolve({ status: "applied" }); });
    mount();
    expect(screen.getByText("Done.")).toBeTruthy();
  });

  it("shows Done. on a widget that remounted WHILE the apply was still in flight (audit g1 MAJOR)", async () => {
    const pending = deferred<unknown>();
    applyCoachAction.mockReturnValue(pending.promise);
    const first = mount();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Log this meal" })); });
    first.unmount();
    mount(); // remounts while the flight above is still on the wire
    expect(screen.getByText("Saving…")).toBeTruthy();
    await act(async () => { pending.resolve({ status: "applied" }); });
    expect(screen.getByText("Done.")).toBeTruthy();
  });

  it("calls the apply while the opening account is the bound one", async () => {
    let boundAtCall: string | undefined;
    applyCoachAction.mockImplementation(async () => { boundAtCall = currentAccountOrNull()?.userId; return { status: "applied" }; });
    mount();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Log this meal" })); });
    expect(boundAtCall).toBe("user-a");
    expect(screen.getByText("Done.")).toBeTruthy();
  });

  it("has no live region around the answer: Thinking is announced once, on its own (audit r4)", () => {
    const { container } = mount({ loading: true });
    expect(container.querySelector("[aria-live]:has([aria-live])")).toBeNull();
    expect((container.firstElementChild as HTMLElement).hasAttribute("aria-live")).toBe(false);
    const live = [...container.querySelectorAll("[aria-live], [role=status], [role=alert]")];
    expect(live.filter((node) => node.textContent?.includes("Finding recipes"))).toHaveLength(1);
  });
});

describe("a plate photo in the recipe widget", () => {
  it("offers Not right? under the result and re-reads the kept photo the chosen way", () => {
    const rereadPhoto = vi.fn();
    const plate = { kind: "plate", title: null, ingredients: [],
      plate: { kcal: 500, protein: 30, carbs: 50, fat: 10, title: null, items: [{ name: "Rice", grams: 200 }] } };
    const ask = { response: null, catalog: null, asked: { label: "Your photo", text: "" }, loading: false,
      reading: false, error: null, confirm: null, logged: null, busy: false, photoRead: "plate", rereadPhoto,
      photo: { logging: null, shown: plate }, account: () => currentAccountOrNull() };
    render(<HubAnswer ask={ask as never} day={{ date: "2026-10-04", remaining: null, slot: "meal-2", time: "12:00",
      label: "Meal 2" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Pick from menu instead" }));
    expect(rereadPhoto).toHaveBeenCalledExactlyOnceWith("menu");
  });
});

describe("the widget's day", () => {
  it("knows how long until the next slot starts, or midnight after the last", () => {
    expect(msToNextSlot(SLOTS, new Date(2026, 9, 4, 11, 59, 30))).toBe(30_000);
    expect(msToNextSlot(SLOTS, new Date(2026, 9, 4, 12, 0, 0))).toBe(6 * 3600_000);
    expect(msToNextSlot(SLOTS, new Date(2026, 9, 4, 23, 0, 0))).toBe(3600_000);
  });

  it("moves to the next meal at its start time, with no event needed", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date(2026, 9, 4, 11, 58, 0));
    const { result } = renderHook(() => useHubDay());
    expect(result.current.slot).toBe("meal-1");
    act(() => { vi.advanceTimersByTime(2 * 60_000 + 10); });
    expect(result.current.slot).toBe("meal-2");
    expect(result.current.label).toBe("Meal 2");
  });

  it("re-reads after a recipe is planned", () => {
    const { result } = renderHook(() => useHubDay());
    expect(result.current.remaining?.kcal).toBe(1500);
    resolveDay.mockImplementation((_store: unknown, date: string) =>
      ({ date, slots: SLOTS, targets: macros(2000), consumed: macros(1200) }));
    act(() => { window.dispatchEvent(new Event("recipe-plan-accepted")); });
    expect(result.current.remaining?.kcal).toBe(800);
  });
});

describe("a Check it tap from the widget", () => {
  it("files under the meal of the tap, not the one the widget last rendered", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 4, 11, 59, 0));
    const stale = readHubDay();
    expect(stale.slot).toBe("meal-1");
    const { result } = renderHook(() => useHubAsk({ day: stale, recipesOn: false }));
    vi.setSystemTime(new Date(2026, 9, 4, 12, 1, 0));
    await act(async () => { result.current.logIt("two slices of lasagna"); });
    // The tap checks first (U23): the proposal files under the meal of the tap.
    expect(proposeDescribed).toHaveBeenCalledTimes(1);
    expect(logDescribed).not.toHaveBeenCalled();
    const [, text, slot, where] = proposeDescribed.mock.calls[0];
    expect(text).toBe("two slices of lasagna");
    expect(slot).toBe("meal-2");
    expect(where).toEqual({ date: "2026-10-04", time: "12:00" });
  });
});

describe("a plan-photo log that lands after an account change (audit r4)", () => {
  it("reports neither Logged. nor an error to the new account; it says the account changed", async () => {
    const pending = deferred<unknown>();
    logDescribed.mockReturnValueOnce(pending.promise);
    const onLogged = vi.fn();
    const onError = vi.fn();
    const onAccountChanged = vi.fn();
    const { result } = renderHook(() => usePlanPhoto({ slot: "meal-2", date: "2026-10-04", time: "12:00",
      targetKcal: 500, onLogged, onError, onAccountChanged }));
    const h = currentAccountOrNull()!;
    let done!: Promise<void>;
    act(() => { done = result.current.logText(h, "a sandwich"); });
    bindAccount("user-b");
    await act(async () => { pending.resolve({ ok: true, date: "2026-10-04" }); await done; });
    expect(onLogged).not.toHaveBeenCalled();
    expect(onAccountChanged).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalledWith(expect.any(String));
  });
});

describe("a plan-photo read that lands after an account change (audit f2 MAJOR)", () => {
  it("rejects as AccountChanged even when the read layer's own failure is a different error", async () => {
    uploadPlanPhoto.mockResolvedValue({ image: new Blob(), mediaPath: "m1" });
    const pending = deferred<unknown>();
    readPlanPhoto.mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() => usePlanPhoto({ slot: "meal-2", date: "2026-10-04", time: "12:00",
      targetKcal: 500, onLogged: vi.fn(), onError: vi.fn(), onAccountChanged: vi.fn() }));
    const h = currentAccountOrNull()!;
    let caught: unknown;
    const attempt = result.current.read(h, { file: new Blob() }).catch((e: unknown) => { caught = e; });
    await waitFor(() => expect(readPlanPhoto).toHaveBeenCalled());
    bindAccount("user-b");
    // The lib layer sometimes swallows the account mismatch into a generic failure; `read` must
    // not trust that type and report "Account changed" to the caller regardless.
    await act(async () => { pending.reject(new Error("Couldn’t read that. Try again.")); await attempt; });
    expect(caught).toBeInstanceOf(AccountChanged);
  });

  it("still rejects as AccountChanged when the underlying read actually resolves", async () => {
    uploadPlanPhoto.mockResolvedValue({ image: new Blob(), mediaPath: "m1" });
    const pending = deferred<{ kind: "ingredients"; title: string | null; ingredients: unknown[] }>();
    readPlanPhoto.mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() => usePlanPhoto({ slot: "meal-2", date: "2026-10-04", time: "12:00",
      targetKcal: 500, onLogged: vi.fn(), onError: vi.fn(), onAccountChanged: vi.fn() }));
    const h = currentAccountOrNull()!;
    let caught: unknown;
    const attempt = result.current.read(h, { file: new Blob() }).catch((e: unknown) => { caught = e; });
    await waitFor(() => expect(readPlanPhoto).toHaveBeenCalled());
    bindAccount("user-b");
    await act(async () => { pending.resolve({ kind: "ingredients", title: null, ingredients: [] }); await attempt; });
    expect(caught).toBeInstanceOf(AccountChanged);
  });
});

describe("a composed-meal apply that settles after the hub itself has closed (audit g1 MINOR)", () => {
  it("does not put a stale outcome back once the hub's own cleanup already forgot it", async () => {
    const h = currentAccountOrNull()!;
    const pending = deferred<{ status: string }>();
    applyCoachAction.mockReturnValue(pending.promise);
    let hubOpen = true;
    const action = { actionId: "a1" } as Parameters<typeof applyAs>[1];
    const flight = applyAs(h, action, "UTC", () => hubOpen);
    // The hub closes (RecipesSection force-closing it on an account change, say) while the apply
    // above is still on the wire: its own unmount cleanup forgets the prefix right away.
    hubOpen = false;
    clearFlightOutcomesUnder(hubApplyPrefix(h.userId));
    await act(async () => { pending.resolve({ status: "applied" }); await flight; });
    expect(flightOutcome(hubApplyPrefix(h.userId))).toBeUndefined();
  });
});
