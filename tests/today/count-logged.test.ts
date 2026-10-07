/**
 * Audit r4 (app/page.tsx countLogged): the count reads the filed day from the store as it is at the
 * call, not from a render, and runs once per account, day and slot: Try again, a second log's count
 * and a count still in flight never enqueue two override and eaten writes for one log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { countLogged, type CountLoggedPorts } from "@/components/today/count-logged";
import { resetFlightsForTests } from "@/components/single-flight";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { EATEN_LOGGED_NAME } from "@/lib/plan/eaten-estimate";
import type { StoredDay } from "@/lib/types";

const FILED = "2026-10-03";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function ports(over: Partial<CountLoggedPorts> = {}): CountLoggedPorts {
  return {
    dayOf: vi.fn(() => undefined),
    planFor: vi.fn(() => ({ slots: [{ slot: "meal-2", meal: { id: "lunch-bowl" } }] })),
    saveOverride: vi.fn(async () => {}), saveEaten: vi.fn(async () => {}),
    onChanged: vi.fn(), onFailed: vi.fn(), ...over,
  };
}

beforeEach(() => { resetFlightsForTests(); unbindAccount(); });
afterEach(() => { unbindAccount(); });

describe("counting a Plan-panel log on its filed day", () => {
  it("takes the base meal and the slot's override from the filed day as stored at the call", async () => {
    const h = bindAccount("user-a");
    let stored: { day: StoredDay | undefined; meal: string } = { day: undefined, meal: "old-render-meal" };
    const p = ports({
      dayOf: vi.fn(() => stored.day),
      planFor: vi.fn(() => ({ slots: [{ slot: "meal-2", meal: { id: stored.meal } }] })),
    });
    // The store moves on after the page last rendered; the count must see this, not the render.
    stored = { day: { itemOverrides: { "meal-2": { baseMealId: null, components: [], time: "13:15" } } } as unknown as StoredDay,
      meal: "live-meal" };
    await countLogged(h, "meal-2", FILED, p);
    expect(p.planFor).toHaveBeenCalledWith(FILED);
    expect(p.dayOf).toHaveBeenCalledWith(FILED);
    expect(p.saveOverride).toHaveBeenCalledExactlyOnceWith(FILED, "meal-2",
      { baseMealId: "live-meal", title: EATEN_LOGGED_NAME, components: [], time: "13:15" });
    expect(p.saveEaten).toHaveBeenCalledOnce();
    expect(p.onChanged).toHaveBeenCalledOnce();
  });

  it("runs one count per day and slot: a second call while one is in flight writes nothing", async () => {
    const h = bindAccount("user-a");
    const gate = deferred();
    const p = ports({ saveOverride: vi.fn(() => gate.promise) });
    const first = countLogged(h, "meal-2", FILED, p);
    expect(countLogged(h, "meal-2", FILED, p)).toBeNull();
    gate.resolve();
    await first;
    expect(p.saveOverride).toHaveBeenCalledOnce();
    expect(p.saveEaten).toHaveBeenCalledOnce();
    // Another slot, or the same slot once the first has landed, counts as usual.
    expect(countLogged(h, "meal-3", FILED, p)).not.toBeNull();
  });

  it("single-flights the failure's Try again", async () => {
    const h = bindAccount("user-a");
    let retry: (() => void) | undefined;
    const saveOverride = vi.fn(async (): Promise<void> => { throw new Error("offline"); });
    const p = ports({ saveOverride, onFailed: vi.fn((again: () => void) => { retry = again; }) });
    await countLogged(h, "meal-2", FILED, p);
    expect(saveOverride).toHaveBeenCalledTimes(2); // one write, one retry
    const gate = deferred();
    saveOverride.mockImplementation(() => gate.promise);
    retry!();
    retry!();
    gate.resolve();
    await vi.waitFor(() => expect(p.saveEaten).toHaveBeenCalledOnce());
    expect(saveOverride).toHaveBeenCalledTimes(3);
  });

  it("writes nothing once the account has changed", async () => {
    const h = bindAccount("user-a");
    bindAccount("user-b");
    const p = ports();
    await countLogged(h, "meal-2", FILED, p);
    expect(p.saveOverride).not.toHaveBeenCalled();
    expect(p.onChanged).not.toHaveBeenCalled();
  });
});
