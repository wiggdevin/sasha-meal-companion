import { describe, expect, it } from "vitest";
import type { Store } from "@/lib/types";
import { hasLoggedAnyMeal, meaningfulMomentReached, OPEN_COUNT_KEY, recordAppOpen } from "./readiness";

function fakeStorage(entries: Record<string, string> = {}): Pick<Storage, "getItem" | "setItem"> {
  const data: Record<string, string> = { ...entries };
  return {
    getItem: (key: string) => data[key] ?? null,
    setItem: (key: string, value: string) => { data[key] = value; },
  };
}

function storeWith(days: Store["days"]): Pick<Store, "days"> {
  return { days };
}

describe("hasLoggedAnyMeal", () => {
  it("is false with no touched days", () => {
    expect(hasLoggedAnyMeal(storeWith({}))).toBe(false);
  });

  it("is true once a day has any eaten slot", () => {
    expect(hasLoggedAnyMeal(storeWith({
      "2026-10-08": { date: "2026-10-08", eaten: { "meal-1": "2026-10-08T12:00:00Z" } },
    }))).toBe(true);
  });

  it("is true once a day has a logged extra", () => {
    expect(hasLoggedAnyMeal(storeWith({
      "2026-10-08": {
        date: "2026-10-08",
        extras: [{ id: "x1", name: "Apple", qty: 1, portionLabel: "1", grams: 100 } as never],
      },
    }))).toBe(true);
  });

  it("is false for a day touched only in other ways (no eaten, no extras)", () => {
    expect(hasLoggedAnyMeal(storeWith({
      "2026-10-08": { date: "2026-10-08", dayTypeOverride: "training" as never },
    }))).toBe(false);
  });
});

describe("recordAppOpen", () => {
  it("increments the durable count once per tab session", () => {
    const storage = fakeStorage();
    const session = fakeStorage();
    expect(recordAppOpen(storage, session)).toBe(1);
    // A second call within the same tab session (sessionStorage already marked) does not double-count.
    expect(recordAppOpen(storage, session)).toBe(1);
  });

  it("carries the count across tab sessions", () => {
    const storage = fakeStorage({ [OPEN_COUNT_KEY]: "1" });
    const session = fakeStorage();
    expect(recordAppOpen(storage, session)).toBe(2);
  });

  it("treats a malformed stored count as zero", () => {
    const storage = fakeStorage({ [OPEN_COUNT_KEY]: "not-a-number" });
    const session = fakeStorage();
    expect(recordAppOpen(storage, session)).toBe(1);
  });
});

describe("meaningfulMomentReached", () => {
  it("is reached once a meal is logged, even on the very first open", () => {
    const store = storeWith({
      "2026-10-08": { date: "2026-10-08", eaten: { "meal-1": "2026-10-08T12:00:00Z" } },
    });
    expect(meaningfulMomentReached(store, 1)).toBe(true);
  });

  it("falls back to the second app open with nothing logged yet", () => {
    const empty = storeWith({});
    expect(meaningfulMomentReached(empty, 1)).toBe(false);
    expect(meaningfulMomentReached(empty, 2)).toBe(true);
  });
});
