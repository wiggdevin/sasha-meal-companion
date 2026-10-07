/**
 * T11b (read-only landing, split audit finding 5): the shared profile READ on its own — the pulled
 * `user_settings` row in, the profile out, and the two ways it can fail to arrive.
 *
 * This branch has no write path (the editor moved to T12b), so the row is only ever what a pull put
 * in the IndexedDB mirror. Four cases are the whole contract the three surfaces stand on: the row
 * maps to the profile, a pull re-reads it, a failed read is retryable, and a stored row outside the
 * migration's ranges is that same failure rather than a coerced profile.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadBodyProfile, profileFromRow, subscribeBodyProfile }
  from "@/lib/body-profile-client";
import { SYNCED_EVENT } from "@/lib/sync/client";
import { putRow } from "@/lib/sync/idb";
import { EMPTY_BODY_PROFILE, type BodyProfile } from "@/lib/tdee";
import { resetTestAccount } from "@/tests/helpers/account";
import type { AccountHandle } from "@/lib/device/account";

let h: AccountHandle;

/** The row a phone holds after a pull: the four profile columns plus the row's neighbours. */
const PULLED_ROW = {
  rev: 3, first_opened_at: "2026-09-01T00:00:00.000Z", training_kcal: 2400, rest_kcal: 2100,
  water_goal_cups_training: 8, water_goal_cups_rest: 7, height_cm: 165, birth_year: 1996,
  sex: "female", body_fat_pct: 25,
};

/** `window` as this test writes it: the DOM's own global type is not optional, so the stub is
 *  reached through a narrow view of `globalThis`. */
const globals = globalThis as unknown as { window?: EventTarget };

/** `subscribeBodyProfile` listens on `window` in the browser; Node has none, so it gets a bare
 *  EventTarget here — the same dispatch target `lib/sync/client.ts` announces a pull on. */
function stubWindow(): EventTarget {
  const target = new EventTarget();
  globals.window = target;
  return target;
}

function collect(): { read: BodyProfile[]; errors: unknown[] } {
  return { read: [], errors: [] };
}

beforeEach(async () => {
  h = await resetTestAccount();
  globalThis.indexedDB = new IDBFactory();
});

afterEach(() => { delete globals.window; });

describe("reading the pulled profile row", () => {
  it("maps the row's four columns to the profile, and nothing else", async () => {
    await putRow(h, "user_settings", "settings", PULLED_ROW);
    await expect(loadBodyProfile()).resolves.toEqual({
      heightCm: 165, birthYear: 1996, sex: "female", bodyFatPct: 25 });
  });

  // A phone that has never carried the columns (or has a row with no profile yet) reads as "unset",
  // which is a fact about her row and not an error.
  it("reads an absent row, or absent columns, as the empty profile", async () => {
    await expect(loadBodyProfile()).resolves.toEqual(EMPTY_BODY_PROFILE);
    await putRow(h, "user_settings", "settings", { rev: 1, water_goal_cups: 8 });
    await expect(loadBodyProfile()).resolves.toEqual(EMPTY_BODY_PROFILE);
    await putRow(h, "user_settings", "settings", { rev: 2, height_cm: null, birth_year: null,
      sex: null, body_fat_pct: null });
    await expect(loadBodyProfile()).resolves.toEqual(EMPTY_BODY_PROFILE);
  });
});

describe("a pull reaching the read", () => {
  it("reads the row again on SYNCED_EVENT, so the newest pulled profile wins", async () => {
    await putRow(h, "user_settings", "settings", PULLED_ROW);
    const seen = collect();
    const page = stubWindow();
    const sub = subscribeBodyProfile((profile) => seen.read.push(profile),
      (error) => seen.errors.push(error));
    await vi.waitFor(() => expect(seen.read).toHaveLength(1));
    expect(seen.read[0]).toEqual({ heightCm: 165, birthYear: 1996, sex: "female", bodyFatPct: 25 });

    await putRow(h, "user_settings", "settings", { ...PULLED_ROW, rev: 4, height_cm: 170 });
    page.dispatchEvent(new Event(SYNCED_EVENT));

    await vi.waitFor(() => expect(seen.read).toHaveLength(2));
    expect(seen.read[1]).toEqual({ heightCm: 170, birthYear: 1996, sex: "female", bodyFatPct: 25 });
    expect(seen.errors).toEqual([null, null]);   // a landed read clears the error, never sets one
    sub.stop();
  });
});

describe("a failed read", () => {
  it("surfaces as an error the consumer can retry, never as a missing profile", async () => {
    const seen = collect();
    const workingFactory = globalThis.indexedDB;
    globalThis.indexedDB = undefined as unknown as IDBFactory;  // the open rejects, so the read does
    const sub = subscribeBodyProfile((profile) => seen.read.push(profile),
      (error) => seen.errors.push(error));
    await vi.waitFor(() => expect(seen.errors).toHaveLength(1));
    expect(seen.read).toHaveLength(0);
    expect(seen.errors[0]).toBeInstanceOf(Error);

    globalThis.indexedDB = workingFactory;
    await putRow(h, "user_settings", "settings", PULLED_ROW);
    sub.retry();

    await vi.waitFor(() => expect(seen.read).toHaveLength(1));
    expect(seen.read[0]).toEqual({ heightCm: 165, birthYear: 1996, sex: "female", bodyFatPct: 25 });
    sub.stop();
  });
});

describe("a stored row the strict profile boundary refuses", () => {
  it("reaches the consumer as a read error, not as a coerced profile", async () => {
    await putRow(h, "user_settings", "settings", { ...PULLED_ROW, height_cm: 300 });
    await expect(loadBodyProfile()).rejects.toThrow(/height_cm/);

    const seen = collect();
    const sub = subscribeBodyProfile((profile) => seen.read.push(profile),
      (error) => seen.errors.push(error));
    await vi.waitFor(() => expect(seen.errors).toHaveLength(1));
    expect(seen.read).toHaveLength(0);
    sub.stop();
  });

  it("accepts the profile ranges through the current calendar year", () => {
    const currentYear = new Date().getFullYear();
    expect(profileFromRow({ height_cm: 50, birth_year: 1900, sex: "female", body_fat_pct: 3 }))
      .toEqual({ heightCm: 50, birthYear: 1900, sex: "female", bodyFatPct: 3 });
    expect(profileFromRow({ height_cm: 260, birth_year: currentYear, sex: "male",
      body_fat_pct: 70 }))
      .toEqual({ heightCm: 260, birthYear: currentYear, sex: "male", bodyFatPct: 70 });
  });

  it("refuses anything outside them, and refuses a boolean or a string outright", () => {
    const refused = [
      { height_cm: 49 }, { height_cm: 261 }, { height_cm: true }, { height_cm: "165" },
      { birth_year: 1899 }, { birth_year: new Date().getFullYear() + 1 },
      { birth_year: 1996.5 },
      { sex: "other" }, { sex: true },
      { body_fat_pct: 2 }, { body_fat_pct: 71 }, { body_fat_pct: false },
    ];
    for (const row of refused) expect(() => profileFromRow(row)).toThrow();
  });
});
