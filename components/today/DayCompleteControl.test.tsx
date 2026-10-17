// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import DayCompleteControl, {
  DAY_COMPLETE_HINT, dayCompleteLabel, hasLoggedFood, showsDayComplete,
} from "./DayCompleteControl";
import type { StoredDay } from "@/lib/types";

const TODAY = "2026-10-04";
const EARLIER = "2026-10-02";
const LOGGED: StoredDay = { date: TODAY, eaten: { "meal-1": "2026-10-04T08:10:00.000Z" } };

afterEach(cleanup);

/** Lets the debounced (0 ms) nudge check and its answer land. */
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

/** An in-memory store and a writer over it, so each test owns the day it reads. */
function harness(initial: StoredDay, fail = false) {
  let day: StoredDay = initial;
  let release: (() => void) | null = null;
  const save = vi.fn((_date: string, complete: boolean) => new Promise<StoredDay>((resolve, reject) => {
    release = () => {
      if (fail) { reject(new Error("offline")); return; }
      day = { ...day, dayCompleteAt: complete ? "2026-10-04T21:00:00.000Z" : undefined };
      resolve(day);
    };
  }));
  return { save, readDay: () => day, settle: async () => { await act(async () => { release?.(); }); } };
}

describe("day fully logged: which days get the control", () => {
  it("shows for today and earlier days with food logged, or a mark to clear", () => {
    expect(showsDayComplete(LOGGED, TODAY, TODAY)).toBe(true);
    expect(showsDayComplete({ ...LOGGED, date: EARLIER }, EARLIER, TODAY)).toBe(true);
    expect(showsDayComplete({ date: EARLIER, dayCompleteAt: "2026-10-02T21:00:00.000Z" }, EARLIER, TODAY))
      .toBe(true);
    expect(showsDayComplete({ date: TODAY, extras: [{ id: "x" } as never] }, TODAY, TODAY)).toBe(true);
  });

  it("hides on a day with nothing logged and on a later day", () => {
    expect(showsDayComplete({ date: TODAY }, TODAY, TODAY)).toBe(false);
    expect(showsDayComplete(undefined, TODAY, TODAY)).toBe(false);
    expect(showsDayComplete({ ...LOGGED, date: "2026-10-05" }, "2026-10-05", TODAY)).toBe(false);
    expect(hasLoggedFood({ date: TODAY, eaten: {} })).toBe(false);
  });

  it("says today on today and that day on an earlier one", () => {
    expect(dayCompleteLabel(TODAY, TODAY)).toBe("I logged everything I ate today");
    expect(dayCompleteLabel(EARLIER, TODAY)).toBe("I logged everything I ate that day");
  });

  it("renders nothing at all when the day has nothing logged", () => {
    const { container } = render(<DayCompleteControl date={TODAY} today={TODAY}
      readDay={() => ({ date: TODAY })} save={vi.fn()} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("day fully logged: the control", () => {
  it("marks today: the tick shows while the write is pending, then reads from the store", async () => {
    const h = harness(LOGGED);
    render(<DayCompleteControl date={TODAY} today={TODAY} readDay={h.readDay} save={h.save} />);
    const box = screen.getByRole("checkbox", { name: "I logged everything I ate today" });
    expect(box.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(DAY_COMPLETE_HINT).id).toBe(box.getAttribute("aria-describedby"));

    fireEvent.click(box);
    await waitFor(() => expect(box.getAttribute("aria-busy")).toBe("true"));
    expect(box.getAttribute("aria-checked")).toBe("true");
    expect(box.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(box); // a second tap while pending sends nothing and flips nothing
    expect(box.getAttribute("aria-checked")).toBe("true");
    expect(h.save).toHaveBeenCalledTimes(1);
    expect(h.save).toHaveBeenCalledWith(TODAY, true);
    expect(box.hasAttribute("disabled")).toBe(false); // focus stays on it for keyboard users

    await h.settle();
    await waitFor(() => expect(box.getAttribute("data-feedback-state")).toBe("success"));
    expect(box.getAttribute("aria-checked")).toBe("true");
    expect(h.readDay().dayCompleteAt).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("clears the mark on an earlier day", async () => {
    const h = harness({ ...LOGGED, date: EARLIER, dayCompleteAt: "2026-10-02T21:00:00.000Z" });
    render(<DayCompleteControl date={EARLIER} today={TODAY} readDay={h.readDay} save={h.save} />);
    const box = screen.getByRole("checkbox", { name: "I logged everything I ate that day" });
    expect(box.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(box);
    await waitFor(() => expect(h.save).toHaveBeenCalledWith(EARLIER, false));
    await h.settle();
    await waitFor(() => expect(box.getAttribute("aria-checked")).toBe("false"));
    expect(h.readDay().dayCompleteAt).toBeUndefined();
  });

  it("returns to the stored state and says so when the write fails, and Try again resends it", async () => {
    const h = harness(LOGGED, true);
    render(<DayCompleteControl date={TODAY} today={TODAY} readDay={h.readDay} save={h.save} />);
    const box = screen.getByRole("checkbox", { name: "I logged everything I ate today" });
    fireEvent.click(box);
    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    await h.settle();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The day was not marked.");
    expect(box.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(2));
    expect(h.save).toHaveBeenLastCalledWith(TODAY, true);
  });
});

describe("day fully logged: the Jev nudge (W142)", () => {
  it("asks once above threshold, and Mark anyway marks the day", async () => {
    const h = harness(LOGGED);
    const checkNudge = vi.fn().mockResolvedValue(true);
    render(<DayCompleteControl date={TODAY} today={TODAY} readDay={h.readDay} save={h.save}
      checkNudge={checkNudge} nudgeSettleMs={0} />);
    await waitFor(() => expect(checkNudge).toHaveBeenCalledTimes(1));
    // Counts only: no food name leaves the phone.
    expect(Object.keys(checkNudge.mock.calls[0][0]).sort())
      .toEqual(["entryCount", "isToday", "lastEntryHour", "localHour", "mealsEaten"]);
    const box = screen.getByRole("checkbox", { name: "I logged everything I ate today" });
    await settle();
    fireEvent.click(box);
    expect(await screen.findByText("A meal may not be logged yet.")).toBeTruthy();
    expect(h.save).not.toHaveBeenCalled();
    const anyway = screen.getByRole("button", { name: "Mark anyway" });
    expect(document.activeElement).toBe(anyway); // focus moves there, which announces the question
    fireEvent.click(box); // a second tap on the box while asking writes nothing
    expect(h.save).not.toHaveBeenCalled();
    fireEvent.click(anyway);
    await waitFor(() => expect(h.save).toHaveBeenCalledWith(TODAY, true));
    expect(h.save).toHaveBeenCalledTimes(1);
  });

  it("Dismiss closes the question without marking", async () => {
    const h = harness(LOGGED);
    render(<DayCompleteControl date={TODAY} today={TODAY} readDay={h.readDay} save={h.save}
      checkNudge={vi.fn().mockResolvedValue(true)} nudgeSettleMs={0} />);
    await settle();
    fireEvent.click(screen.getByRole("checkbox", { name: "I logged everything I ate today" }));
    await screen.findByText("A meal may not be logged yet.");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByText("A meal may not be logged yet.")).toBeNull());
    expect(h.save).not.toHaveBeenCalled();
  });

  it("ignores a verdict for another day: switching dates asks again and never borrows the answer", async () => {
    const check = vi.fn((state: { isToday: boolean }) => Promise.resolve(state.isToday));
    const day = (date: string): StoredDay => ({ ...LOGGED, date });
    const save = vi.fn();
    const { rerender } = render(<DayCompleteControl date={TODAY} today={TODAY} readDay={() => day(TODAY)}
      save={save} checkNudge={check} nudgeSettleMs={0} />);
    await settle();
    rerender(<DayCompleteControl date={EARLIER} today={TODAY} readDay={() => day(EARLIER)}
      save={save} checkNudge={check} nudgeSettleMs={0} />);
    await settle();
    expect(check).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("checkbox", { name: "I logged everything I ate that day" }));
    expect(screen.queryByText("A meal may not be logged yet.")).toBeNull();
    await waitFor(() => expect(save).toHaveBeenCalledWith(EARLIER, true));
  });

  it("marks straight away below threshold, on a Jev error, and when the answer has not arrived", async () => {
    for (const check of [vi.fn().mockResolvedValue(false), vi.fn().mockRejectedValue(new Error("x")),
      vi.fn(() => new Promise<boolean>(() => {}))]) {
      const h = harness(LOGGED);
      render(<DayCompleteControl date={TODAY} today={TODAY} readDay={h.readDay} save={h.save} checkNudge={check} nudgeSettleMs={0} />);
      await settle();
      fireEvent.click(screen.getByRole("checkbox", { name: "I logged everything I ate today" }));
      await waitFor(() => expect(h.save).toHaveBeenCalledWith(TODAY, true));
      expect(screen.queryByText("A meal may not be logged yet.")).toBeNull();
      cleanup();
    }
  });
});
