// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Today from "@/app/page";
import { resetTestAccount } from "@/tests/helpers/account";
import type { Macros, ResolvedDay, ResolvedSlot, SlotId, SlotOverride, Store, StoredDay } from "@/lib/types";

const ZERO: Macros = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
const date = () => new Date().toLocaleDateString("en-CA");
const slot = (id: SlotId, time: string): ResolvedSlot => ({
  slot: id, time, label: `Meal ${id.split("-")[1]}`,
  meal: { id: "mine", slot: id, name: "Rice bowl", components: [],
    macros: ZERO, prepMinutes: 0, tags: [] },
  components: [], macros: ZERO, eaten: false,
});

const fixture = vi.hoisted(() => ({ store: null as unknown as Store,
  day: null as unknown as ResolvedDay, stored: null as StoredDay | null }));
const write = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({})));
const eaten = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({})));
const noteWrite = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}));
const logStates = vi.hoisted(() => ({ unsaved: new Set<string>(),
  retry: async (_id: string): Promise<unknown> => null }));
const deferredState = vi.hoisted(() => ({
  refused: false as boolean,
  retry: async (_id: string): Promise<unknown> => ({ status: "waiting", repinned: false }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ back: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => "/", useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/store")>()),
  loadStore: () => fixture.store, saveStore: () => {}, getDay: () => fixture.stored,
}));
vi.mock("@/lib/resolve", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/resolve")>()),
  resolveDay: (_store: Store, localDate: string) => ({ ...fixture.day, date: localDate }),
}));
vi.mock("@/lib/plan-day-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/plan-day-client")>()),
  saveItemOverride: write,
  saveEatenSlot: eaten,
}));
vi.mock("@/lib/log/today-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/log/today-state")>()),
  savingElsewhere: async () => null,
}));
vi.mock("@/lib/log-commit-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/log-commit-client")>()),
  logEntryStates: async () => ({ pending: new Set(), stale: new Set(),
    unsaved: logStates.unsaved, lost: new Set() }),
  retryUnsavedCommit: (id: string) => logStates.retry(id),
}));
vi.mock("@/lib/log/picked-deferred", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/log/picked-deferred")>()),
  readDeferred: async () => (deferredState.refused ? { refused: true } : undefined),
  retryDeferred: (_h: unknown, id: string) => deferredState.retry(id),
}));
vi.mock("@/lib/estimator-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/estimator-client")>()),
  fetchProposals: async () => null,
}));
vi.mock("@/lib/profile/onboarding-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/profile/onboarding-state")>()),
  readAccountOnboardingRow: async () => undefined,
}));
vi.mock("@/lib/supabase/client", () => ({ browserClient: () => ({}) }));
vi.mock("@/lib/log-note-client", () => ({ saveExtraNote: noteWrite }));

beforeEach(async () => {
  await resetTestAccount();
  HTMLElement.prototype.scrollTo = () => {};
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  fixture.store = { version: 1, firstOpenedAt: date(), days: {}, foods: {},
    settings: { trainingKcal: null, restKcal: null, proteinG: null, proteinLocked: true,
      mealsPerDay: 3, slotTimes: {}, shiftMinutes: 0, changedAt: null } };
  fixture.day = { date: date(), dayType: "rest", isFloorDay: false, targets: null,
    slots: [slot("meal-1", "08:00"), slot("meal-2", "12:30"), slot("meal-3", "18:30")],
    extras: [], consumed: ZERO, waterCups: 0 };
  fixture.stored = null;
  eaten.mockReset();
  eaten.mockImplementation(async (...args: unknown[]) => {
    const [localDate, id, at] = args as [string, SlotId, string | null];
    const marks = { ...(fixture.stored?.eaten ?? {}) };
    if (at === null) delete marks[id]; else marks[id] = at;
    fixture.stored = { ...(fixture.stored ?? { date: localDate }), date: localDate, eaten: marks };
    return fixture.stored;
  });
  logStates.unsaved = new Set();
  logStates.retry = async () => null;
  deferredState.refused = false;
  deferredState.retry = async () => ({ status: "waiting", repinned: false });
  write.mockReset();
  write.mockImplementation(async (...args: unknown[]) => {
    const [localDate, id, value] = args as [string, SlotId, SlotOverride | null];
    const itemOverrides = { ...(fixture.stored?.itemOverrides ?? {}) };
    if (value === null) delete itemOverrides[id];
    else itemOverrides[id] = value;
    fixture.stored = { date: localDate, itemOverrides };
    return fixture.stored;
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function mount() { await act(async () => { render(<Today />); }); }

function revealMealActions(label: string): void {
  const card = screen.getByRole("button", { name: `Expand ${label}` }).closest("[data-meal-card]") as HTMLElement;
  Object.defineProperty(card, "getBoundingClientRect", { value: () => ({ width: 300 }) });
  fireEvent.pointerDown(card, { pointerType: "mouse", button: 0, clientX: 260, clientY: 80 });
  fireEvent.pointerMove(document, { pointerType: "mouse", clientX: 100, clientY: 80 });
  fireEvent.pointerUp(document, { pointerType: "mouse" });
}

describe("Today per-date meal actions", () => {
  it("clears a card and Undo restores the exact authored override", async () => {
    const prior: SlotOverride = { baseMealId: "mine", components: [],
      title: "My rice", time: "09:15" };
    fixture.stored = { date: date(), itemOverrides: { "meal-1": prior } };
    await mount();
    revealMealActions("Meal 1");
    fireEvent.click(screen.getByRole("button", { name: "Clear Meal 1" }));
    await waitFor(() => expect(write).toHaveBeenCalledWith(date(), "meal-1",
      { baseMealId: "mine", components: [], time: "09:15", cleared: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(write).toHaveBeenLastCalledWith(date(), "meal-1", prior));
  });

  it("deletes a card for one date and Undo removes the marker", async () => {
    await mount();
    revealMealActions("Meal 1");
    fireEvent.click(screen.getByRole("button", { name: "Delete Meal 1" }));
    await waitFor(() => expect(write).toHaveBeenCalledWith(date(), "meal-1",
      { baseMealId: "mine", components: [], removed: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(write).toHaveBeenLastCalledWith(date(), "meal-1", null));
  });

  it("refuses a stale Delete callback when the meal was marked eaten after render", async () => {
    fixture.stored = { date: date(), eaten: { "meal-1": "2026-09-27T12:00:00Z" } };
    await mount();
    revealMealActions("Meal 1");
    fireEvent.click(screen.getByRole("button", { name: "Delete Meal 1" }));
    expect(write).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Mark this meal not eaten");
  });

  it("adds meal 4 at 9 pm after the three-meal layout", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "+ Add a meal" }));
    await waitFor(() => expect(write).toHaveBeenCalledWith(date(), "meal-4",
      { baseMealId: null, components: [], added: true, followPlan: true, time: "21:00" }));
  });

  it("keeps Undo available for five seconds after Delete", async () => {
    await mount();
    vi.useFakeTimers();
    try {
      revealMealActions("Meal 1");
      fireEvent.click(screen.getByRole("button", { name: "Delete Meal 1" }));
      await act(async () => { await Promise.resolve(); });
      expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
      act(() => { vi.advanceTimersByTime(4_999); });
      expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
      act(() => { vi.advanceTimersByTime(1); });
      expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it("never restores an old account's meal into a newly bound account", async () => {
    await mount();
    revealMealActions("Meal 1");
    fireEvent.click(screen.getByRole("button", { name: "Delete Meal 1" }));
    const undo = await screen.findByRole("button", { name: "Undo" });
    const calls = write.mock.calls.length;
    await resetTestAccount("22222222-2222-4222-8222-222222222222");
    fireEvent.click(undo);
    expect(write).toHaveBeenCalledTimes(calls);
  });

  it("dismisses the previous account's Undo when the account changes", async () => {
    await mount();
    revealMealActions("Meal 1");
    fireEvent.click(screen.getByRole("button", { name: "Delete Meal 1" }));
    await screen.findByRole("button", { name: "Undo" });
    await resetTestAccount("22222222-2222-4222-8222-222222222222");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Undo" })).toBeNull());
  });

  it("does not show a previous account's late save error", async () => {
    let rejectSave: (error: Error) => void = () => {};
    write.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSave = reject; }));
    await mount();
    revealMealActions("Meal 1");
    fireEvent.click(screen.getByRole("button", { name: "Delete Meal 1" }));
    await resetTestAccount("22222222-2222-4222-8222-222222222222");
    await act(async () => { rejectSave(new Error("old account save failed")); });
    expect(screen.queryByText("That change did not save. Try again.")).toBeNull();
  });
});

/** FluidVoice F01-F09: Today's eaten mark runs through the one keyed ActionFeedback owner. */
describe("Today eaten feedback", () => {
  const vibrate = vi.fn(() => true);
  beforeEach(() => {
    vibrate.mockClear();
    Object.defineProperty(window.navigator, "vibrate", { configurable: true, value: vibrate });
  });
  const tick = () => screen.getByRole("button", { name: "Mark eaten, Meal 2" });

  it("confirms a mark with the shared haptic on that slot's control, and Undo clears it", async () => {
    await mount();
    fireEvent.click(tick());
    const status = (await screen.findByText("Meal 2 marked eaten.")).closest("[role=status]");
    expect(status?.querySelector('button[aria-label="Dismiss notification"]')).toBeTruthy();
    expect(eaten.mock.calls[0].slice(0, 2)).toEqual([date(), "meal-2"]);
    expect(vibrate).toHaveBeenCalledTimes(1);
    expect(tick().getAttribute("data-feedback-state")).toBe("success");
    expect(screen.getByRole("button", { name: "Mark eaten, Meal 1" }).hasAttribute("data-feedback-state"))
      .toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(eaten).toHaveBeenCalledTimes(2));
    expect(eaten.mock.calls[1].slice(0, 3)).toEqual([date(), "meal-2", null]);
  });

  it("shows a failed mark as the shared alert without the success haptic", async () => {
    eaten.mockImplementationOnce(async () => { throw new Error("The eaten mark did not save."); });
    await mount();
    fireEvent.click(tick());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The eaten mark did not save.");
    expect(vibrate).not.toHaveBeenCalled();
  });

  it("refuses an Undo once the mark has changed again", async () => {
    await mount();
    fireEvent.click(tick());
    await screen.findByText("Meal 2 marked eaten.");
    fixture.stored = { date: date(), eaten: {} };
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(eaten).toHaveBeenCalledTimes(1);
    expect((await screen.findByRole("alert")).textContent).toContain("changed again");
  });
});

/** FluidVoice F01-F09: a changed note save is a safe reversible write, so Today offers Undo. */
describe("Today note Undo", () => {
  const ENTRY = { id: "entry-1", foodId: "f", name: "Toast", portionLabel: "slice", qty: 1, grams: 30,
    macros: { kcal: 80, protein: 3, carbs: 15, fat: 1 }, at: new Date().toISOString(), note: "old note" };
  const noteOf = () => fixture.stored?.extras?.find((extra) => extra.id === ENTRY.id)?.note ?? "";

  beforeEach(() => {
    fixture.day = { ...fixture.day, extras: [ENTRY] };
    fixture.stored = { date: date(), extras: [ENTRY] };
    noteWrite.mockReset();
    // As lib/log-note-client.ts saveExtraNote does: the stored note is the trimmed text.
    noteWrite.mockImplementation(async (...args: unknown[]) => {
      const [, id, text] = args as [string, string, string];
      const note = text.trim();
      fixture.stored = { ...fixture.stored!, extras: (fixture.stored?.extras ?? [])
        .map((extra) => extra.id === id ? { ...extra, note: note || undefined } : extra) };
    });
  });

  async function saveNote(text: string) {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: /^(Edit|Add) note$/ }));
    const box = await screen.findByPlaceholderText(/How it went/);
    fireEvent.change(box, { target: { value: text } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save note" })); });
  }

  it("offers Undo after a changed note saves, restoring the earlier note through the same write", async () => {
    await saveNote("new note");
    expect(noteWrite).toHaveBeenCalledWith(date(), ENTRY.id, "new note");
    const status = (await screen.findByText("Note saved.")).closest("[role=status]") as HTMLElement;
    await act(async () => { fireEvent.click(within(status).getByRole("button", { name: "Undo" })); });
    await waitFor(() => expect(noteWrite).toHaveBeenLastCalledWith(date(), ENTRY.id, "old note"));
    expect(noteOf()).toBe("old note");
  });

  it("restores the earlier note when the saved note ended in whitespace", async () => {
    await saveNote("new note  ");
    expect(noteOf()).toBe("new note");
    const status = (await screen.findByText("Note saved.")).closest("[role=status]") as HTMLElement;
    await act(async () => { fireEvent.click(within(status).getByRole("button", { name: "Undo" })); });
    await waitFor(() => expect(noteWrite).toHaveBeenLastCalledWith(date(), ENTRY.id, "old note"));
    expect(noteOf()).toBe("old note");
    expect(screen.queryByText(/changed again/)).toBeNull();
  });

  it("treats a whitespace-only edit as no change: no write, no Undo", async () => {
    await saveNote("  old note \n");
    expect(noteWrite).not.toHaveBeenCalled();
    expect(screen.queryByText("Note saved.")).toBeNull();
  });

  it("offers nothing when the note did not change, and keeps a failure in the sheet", async () => {
    await saveNote("old note");
    expect(noteWrite).not.toHaveBeenCalled();
    expect(screen.queryByText("Note saved.")).toBeNull();
    cleanup();
    noteWrite.mockImplementationOnce(async () => { throw new Error("offline"); });
    await saveNote("will fail");
    expect(screen.getByRole("alert").textContent).toContain("Could not save your note");
    expect((screen.getByPlaceholderText(/How it went/) as HTMLTextAreaElement).value).toBe("will fail");
    expect(screen.queryByText("Note saved.")).toBeNull();
  });

  it("refuses Undo once the note changed again", async () => {
    await saveNote("new note");
    const status = (await screen.findByText("Note saved.")).closest("[role=status]") as HTMLElement;
    fixture.stored = { ...fixture.stored!, extras: [{ ...ENTRY, note: "edited elsewhere" }] };
    await act(async () => { fireEvent.click(within(status).getByRole("button", { name: "Undo" })); });
    expect(noteWrite).toHaveBeenCalledTimes(1);
    expect((await screen.findByRole("alert")).textContent).toContain("changed again");
  });

  it("never restores an old account's note into a newly bound account", async () => {
    await saveNote("new note");
    const status = (await screen.findByText("Note saved.")).closest("[role=status]") as HTMLElement;
    const undo = within(status).getByRole("button", { name: "Undo" });
    await resetTestAccount("22222222-2222-4222-8222-222222222222");
    await act(async () => { fireEvent.click(undo); });
    expect(noteWrite).toHaveBeenCalledTimes(1);
  });
});

/** Review minors: quiet no-op retries and account-safe eaten writes. */
describe("Today write safety", () => {
  const vibrate = vi.fn(() => true);
  beforeEach(() => {
    vibrate.mockClear();
    Object.defineProperty(window.navigator, "vibrate", { configurable: true, value: vibrate });
  });

  it("settles a retry with nothing left to send quietly", async () => {
    const entry = { id: "entry-9", foodId: "f", name: "Soup", portionLabel: "bowl", qty: 1, grams: 300,
      macros: { kcal: 200, protein: 10, carbs: 20, fat: 5 }, at: new Date().toISOString() };
    fixture.day = { ...fixture.day, extras: [entry] };
    logStates.unsaved = new Set([entry.id]);
    const retry = vi.fn(async () => null);
    logStates.retry = retry;
    await mount();
    const button = await screen.findByText("Not saved yet. Tap to try again.");
    await act(async () => { fireEvent.click(button); });
    await act(async () => {});
    expect(retry).toHaveBeenCalledWith(entry.id);
    expect(vibrate).not.toHaveBeenCalled();
    expect(button.getAttribute("data-feedback-state")).toBeNull();
    expect(screen.queryByRole("status", { name: /./ })).toBeNull();
  });

  it("retries a refused deferred log through retryDeferred, not the plain unsaved path (t17)", async () => {
    const entry = { id: "entry-10", foodId: "f", name: "Oats", portionLabel: "1 bowl", qty: 1,
      grams: 0, massUnknown: true as const, macros: { kcal: 150, protein: 5, carbs: 27, fat: 3 },
      at: new Date().toISOString(),
      notSaved: "Not saved: the server would not take it. Try again." };
    fixture.day = { ...fixture.day, extras: [entry] };
    deferredState.refused = true;
    const retry = vi.fn(async () => ({ status: "waiting" as const, repinned: false }));
    deferredState.retry = retry;
    const unsavedRetry = vi.fn(async () => null);
    logStates.retry = unsavedRetry;
    await mount();
    const button = await screen.findByText("Not saved. Try again.");
    await act(async () => { fireEvent.click(button); });
    await act(async () => {});
    expect(retry).toHaveBeenCalledWith(entry.id);
    // The plain unsaved/lost retry is a different write (it resends as is, never re-pins a stale
    // catalog pick): a refused deferred log must never fall through to it.
    expect(unsavedRetry).not.toHaveBeenCalled();
  });

  it("says nothing of an eaten mark that lands after the account changed", async () => {
    let finish!: () => void;
    eaten.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({}); }));
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Mark eaten, Meal 2" }));
    await act(async () => {});
    await resetTestAccount("22222222-2222-4222-8222-222222222222");
    await act(async () => { finish(); });
    await act(async () => {});
    expect(vibrate).not.toHaveBeenCalled();
    expect(screen.queryByText("Meal 2 marked eaten.")).toBeNull();
  });

  it("never undoes an old account's eaten mark in a newly bound account", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Mark eaten, Meal 2" }));
    await screen.findByText("Meal 2 marked eaten.");
    const undo = screen.getByRole("button", { name: "Undo" });
    await resetTestAccount("22222222-2222-4222-8222-222222222222");
    await act(async () => { fireEvent.click(undo); });
    expect(eaten).toHaveBeenCalledTimes(1);
  });
});
