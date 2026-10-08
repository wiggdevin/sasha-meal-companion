import { afterEach, describe, expect, it } from "vitest";
import type { Store } from "@/lib/types";
import {
  androidPromptOnCooldown,
  ANDROID_DECLINE_COOLDOWN_DAYS,
  hasLoggedAnyMeal,
  loggedMealCount,
  meaningfulMomentReached,
  noteVisibilityHidden,
  noteVisibilityVisible,
  OPEN_COUNT_KEY,
  readOpenCount,
  recordAndroidPromptDeclined,
  recordAppOpen,
  recordPageOpenOnce,
  __resetPageOpenTrackingForTests,
} from "./readiness";

function fakeStorage(entries: Record<string, string> = {}): Storage {
  const data: Record<string, string> = { ...entries };
  return {
    getItem: (key: string) => data[key] ?? null,
    setItem: (key: string, value: string) => { data[key] = value; },
  } as Storage;
}

function throwingStorage(): Storage {
  return {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("blocked"); },
  } as unknown as Storage;
}

function storeWith(days: Store["days"]): Pick<Store, "days"> {
  return { days };
}

const DAY_MS = 24 * 60 * 60 * 1000;
// A fixed mid-day timestamp so "same calendar day" math is never near a day boundary by accident.
const NOON = new Date("2026-10-08T12:00:00Z").getTime();

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

describe("loggedMealCount", () => {
  it("counts eaten slots and extras across every day", () => {
    const store = storeWith({
      "2026-10-08": {
        date: "2026-10-08",
        eaten: { "meal-1": "2026-10-08T12:00:00Z", "meal-2": "2026-10-08T18:00:00Z" },
        extras: [{ id: "x1" } as never],
      },
      "2026-10-07": { date: "2026-10-07", eaten: { "meal-1": "2026-10-07T12:00:00Z" } },
    });
    expect(loggedMealCount(store)).toBe(4);
  });

  it("is zero with nothing logged", () => {
    expect(loggedMealCount(storeWith({}))).toBe(0);
  });
});

describe("recordAppOpen", () => {
  it("counts the very first open", () => {
    expect(recordAppOpen(fakeStorage(), NOON)).toBe(1);
  });

  // Sol review, 2026-10-08, BLOCK: the old per-tab sessionStorage guard never counted a reload or
  // reopen of a retained Safari tab as a new open at all.
  it("does NOT double-count a reload moments later, on the same day", () => {
    const storage = fakeStorage();
    expect(recordAppOpen(storage, NOON)).toBe(1);
    expect(recordAppOpen(storage, NOON + 60_000)).toBe(1);
  });

  it("counts a reopen on the same day once at least 30 minutes have passed", () => {
    const storage = fakeStorage();
    expect(recordAppOpen(storage, NOON)).toBe(1);
    expect(recordAppOpen(storage, NOON + 29 * 60_000)).toBe(1);
    expect(recordAppOpen(storage, NOON + 30 * 60_000)).toBe(2);
  });

  it("counts a reopen on the next calendar day even within a few minutes", () => {
    // Calendar day is local-time, so these are built from local Date fields (year, month,
    // day, hour, minute) — a UTC "Z" string would land on a different local day depending on the
    // machine's own time zone, which is exactly what made this flaky the first time.
    const storage = fakeStorage();
    const lateNight = new Date(2026, 9, 8, 23, 59).getTime();
    const justAfterMidnight = new Date(2026, 9, 9, 0, 2).getTime();
    expect(recordAppOpen(storage, lateNight)).toBe(1);
    expect(recordAppOpen(storage, justAfterMidnight)).toBe(2);
  });

  it("carries the count across separate calls (durable, not per-tab)", () => {
    const storage = fakeStorage({ [OPEN_COUNT_KEY]: "1" });
    expect(recordAppOpen(storage, NOON)).toBe(2);
  });

  it("treats a malformed stored count as zero", () => {
    const storage = fakeStorage({ [OPEN_COUNT_KEY]: "not-a-number" });
    expect(recordAppOpen(storage, NOON)).toBe(1);
  });

  it("never throws: a storage failure answers zero", () => {
    expect(recordAppOpen(throwingStorage(), NOON)).toBe(0);
  });
});

describe("meaningfulMomentReached", () => {
  it("is reached once a meal is logged, even on the very first open", () => {
    expect(meaningfulMomentReached(true, 1)).toBe(true);
  });

  it("falls back to the second app open with nothing logged yet", () => {
    expect(meaningfulMomentReached(false, 1)).toBe(false);
    expect(meaningfulMomentReached(false, 2)).toBe(true);
  });
});

// Sol review round 3, 2026-10-08, BLOCK: these take the already-derived meal count, not the
// store, so the caller's effect can depend on that stable primitive instead of the store object's
// identity (which changes on every render regardless of whether anything logged actually changed).
describe("androidPromptOnCooldown / recordAndroidPromptDeclined", () => {
  it("is not on cooldown before any decline", () => {
    expect(androidPromptOnCooldown(fakeStorage(), 1, NOON)).toBe(false);
  });

  it("is on cooldown right after a decline, with nothing new logged", () => {
    const storage = fakeStorage();
    recordAndroidPromptDeclined(storage, 1, NOON);
    expect(androidPromptOnCooldown(storage, 1, NOON + 60_000)).toBe(true);
  });

  it("clears once the cooldown window passes", () => {
    const storage = fakeStorage();
    recordAndroidPromptDeclined(storage, 1, NOON);
    const justUnder = NOON + ANDROID_DECLINE_COOLDOWN_DAYS * DAY_MS - 1;
    const justOver = NOON + ANDROID_DECLINE_COOLDOWN_DAYS * DAY_MS + 1;
    expect(androidPromptOnCooldown(storage, 1, justUnder)).toBe(true);
    expect(androidPromptOnCooldown(storage, 1, justOver)).toBe(false);
  });

  // Sol review, 2026-10-08, WARN: a declined prompt must also clear the moment a NEW meaningful
  // moment happens, not just after N days.
  it("clears as soon as a new meal is logged, even inside the cooldown window", () => {
    const storage = fakeStorage();
    recordAndroidPromptDeclined(storage, 1, NOON);
    expect(androidPromptOnCooldown(storage, 1, NOON + 60_000)).toBe(true);
    expect(androidPromptOnCooldown(storage, 2, NOON + 60_000)).toBe(false);
  });

  it("never throws: a storage failure answers not-on-cooldown (safe to show)", () => {
    expect(androidPromptOnCooldown(throwingStorage(), 0, NOON)).toBe(false);
    expect(() => recordAndroidPromptDeclined(throwingStorage(), 0, NOON)).not.toThrow();
  });
});

// Sol review round 2, 2026-10-08, BLOCK: the component used to call `recordAppOpen` on every
// re-render (a clock tick producing a new `store` reference counted as a second open with nothing
// actually reopened). `recordPageOpenOnce` is a module-level flag precisely so repeated calls
// within one page load — however many times a component remounts or re-renders — only ever record
// the first one.
describe("recordPageOpenOnce", () => {
  afterEach(() => {
    __resetPageOpenTrackingForTests();
  });

  it("records the first call for this page load", () => {
    const storage = fakeStorage();
    expect(recordPageOpenOnce(storage, NOON)).toBe(1);
    expect(readOpenCount(storage)).toBe(1);
  });

  it("answers null, and writes nothing more, on every later call in the same load", () => {
    const storage = fakeStorage();
    expect(recordPageOpenOnce(storage, NOON)).toBe(1);
    // Many more calls — simulating many re-renders/remounts, including a clock tick an hour later
    // (well past the 30-minute gap `recordAppOpen` alone would have treated as a new open).
    expect(recordPageOpenOnce(storage, NOON + 60 * 60_000)).toBeNull();
    expect(recordPageOpenOnce(storage, NOON + 2 * 60 * 60_000)).toBeNull();
    expect(readOpenCount(storage)).toBe(1);
  });
});

describe("noteVisibilityHidden / noteVisibilityVisible", () => {
  afterEach(() => {
    __resetPageOpenTrackingForTests();
  });

  it("counts nothing on a visible call with no prior hidden call", () => {
    const storage = fakeStorage();
    expect(noteVisibilityVisible(storage, NOON)).toBeNull();
    expect(readOpenCount(storage)).toBe(0);
  });

  it("counts nothing on a quick tab-switch (hidden under 30 minutes)", () => {
    const storage = fakeStorage({ [OPEN_COUNT_KEY]: "1" });
    noteVisibilityHidden(NOON);
    expect(noteVisibilityVisible(storage, NOON + 5 * 60_000)).toBeNull();
    expect(readOpenCount(storage)).toBe(1);
  });

  it("counts a new open once hidden for at least 30 minutes", () => {
    const storage = fakeStorage({ [OPEN_COUNT_KEY]: "1" });
    noteVisibilityHidden(NOON);
    expect(noteVisibilityVisible(storage, NOON + 30 * 60_000)).toBe(2);
    expect(readOpenCount(storage)).toBe(2);
  });

  it("never counts twice for the same hidden period", () => {
    const storage = fakeStorage({ [OPEN_COUNT_KEY]: "1" });
    noteVisibilityHidden(NOON);
    expect(noteVisibilityVisible(storage, NOON + 30 * 60_000)).toBe(2);
    // Visible again with no new hidden call in between — nothing to count.
    expect(noteVisibilityVisible(storage, NOON + 31 * 60_000)).toBeNull();
    expect(readOpenCount(storage)).toBe(2);
  });
});
