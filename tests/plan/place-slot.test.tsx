// @vitest-environment jsdom
/**
 * The Plan panel's one write (components/plan/usePlaceSlot.ts) places once: the in-flight lock is a
 * ref, so two calls in the same tick reach the server once, and the document plan's button cannot
 * fire while a placement is saving (audit 2026-10-04).
 */
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplyResult } from "@/lib/coach/apply-shared";
import { bindAccount, currentAccountOrNull, unbindAccount } from "@/lib/device/account";
import type { DocumentPlanResult } from "@/lib/plan/document-types";

const applyCoachAction = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coach/apply-client", () => ({ applyCoachAction, ACTION_TIMEOUT_REASON: "timeout" }));

import DocumentPlan from "@/components/plan/DocumentPlan";
import { usePlaceSlot } from "@/components/plan/usePlaceSlot";

const ACTION = { kind: "set_slot_meal", actionId: "a1", flagged: false, date: "2026-10-04", slot: "meal-2",
  items: [] } as never;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function mount() {
  const onPlaced = vi.fn();
  const onClose = vi.fn();
  const onError = vi.fn();
  const hook = renderHook(() => usePlaceSlot({ tz: "UTC", account: currentAccountOrNull, onPlaced, onClose, onError }));
  return { ...hook, onPlaced, onClose, onError };
}

beforeEach(() => { unbindAccount(); bindAccount("user-a"); applyCoachAction.mockReset(); });
afterEach(cleanup);

describe("usePlaceSlot", () => {
  it("places once when place is called twice in the same tick", async () => {
    const pending = deferred<ApplyResult>();
    applyCoachAction.mockReturnValue(pending.promise);
    const { result, onPlaced } = mount();
    await act(async () => {
      void result.current.place(ACTION, "Eggs");
      void result.current.place(ACTION, "Eggs");
    });
    expect(applyCoachAction).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve({ status: "applied" } as ApplyResult); });
    expect(onPlaced).toHaveBeenCalledTimes(1);
    await act(async () => { await result.current.place(ACTION, "Eggs"); });
    expect(applyCoachAction).toHaveBeenCalledTimes(1);
  });

  it("lets a failed placement be tried again", async () => {
    applyCoachAction.mockResolvedValueOnce({ status: "failed", reason: "Nope" })
      .mockResolvedValueOnce({ status: "applied" });
    const { result, onError, onPlaced } = mount();
    await act(async () => { await result.current.place(ACTION, "Eggs"); });
    expect(onError).toHaveBeenLastCalledWith("Nope");
    await act(async () => { await result.current.place(ACTION, "Eggs"); });
    expect(applyCoachAction).toHaveBeenCalledTimes(2);
    expect(onPlaced).toHaveBeenCalledTimes(1);
  });

  it("closes without placing when the account changed before the write", async () => {
    const opened = currentAccountOrNull();
    const onClose = vi.fn();
    const { result } = renderHook(() => usePlaceSlot({ tz: "UTC", account: () => opened, onPlaced: vi.fn(),
      onClose, onError: vi.fn() }));
    bindAccount("user-b");
    await act(async () => { await result.current.place(ACTION, "Eggs"); });
    expect(applyCoachAction).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("the document plan's Use button", () => {
  const plan: DocumentPlanResult = {
    kind: "meal_plan", title: "Week", days: [{ label: "Mon", meals: [{ name: "Lunch", time: "12:00", foods: [] }] }],
    match: { day: 0, meal: 0, title: "Lunch", items: [{ name: "Rice", grams: 150 }],
      totals: { kcal: 200, protein: 4, carbs: 44, fat: 1 }, left: [] },
  } as never;

  it("is out of reach while the meal is saving", () => {
    const onUse = vi.fn();
    render(<DocumentPlan result={plan} label="Meal 2" busy={false} placing onUse={onUse} />);
    // The Button says it is saving with its own dots (aria-busy), and is out of reach.
    const button = screen.getByRole("button", { name: "Use for this meal" }) as HTMLButtonElement;
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onUse).not.toHaveBeenCalled();
  });
});
