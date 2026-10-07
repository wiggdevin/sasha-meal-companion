// @vitest-environment jsdom
/**
 * t24b (c): a revision dated for the next local day becomes the phone's current cache after local
 * midnight with no write and no network: on start, on return to the tab and at midnight. The phone
 * clock is built from LOCAL components, so the cases hold under TZ=UTC and TZ=America/Denver.
 */
import { describe, expect, it, vi } from "vitest";
import type { TargetProfile } from "@/lib/api-types";
import type { AccountHandle } from "@/lib/device/account";
import { defaultSettings } from "@/lib/store";
import {
  msUntilNextLocalDay, refreshTargetDay, settingsForTargetDay, targetDayRoll,
} from "@/lib/targets/day-roll";
import { settingsWithTargetRevisions, targetRevisionFromProfile } from "@/lib/targets/revision";
import { startAccountSync } from "@/lib/sync/account-sync";
import { SYNCED_EVENT } from "@/lib/sync/client";
import type { Settings, Store, TargetRevision } from "@/lib/types";

function revision(id: string, effectiveFrom: string, rev: number, kcal: number): TargetRevision {
  const profile = {
    id, user_id: "00000000-0000-4000-8000-000000000010", effective_from: effectiveFrom, rev,
    kcal_train: kcal, kcal_rest: kcal - 200, authored_by: "user", mode: "grams",
    protein_g: 120, fat_g: 70, carb_g: 200, protein_pct: null, fat_pct: null, carb_pct: null,
    kcal_min: 1200, protein_g_min: 100, fat_g_min: 40, carb_g_min: 0, goal_rate_bp_week: 0,
    max_weekly_kcal_step: 150, notes: null, target_source: "derived",
    training_macros: { kcal, protein: 120, carbs: 200, fat: 70 },
    rest_macros: { kcal: kcal - 200, protein: 120, carbs: 150, fat: 70 },
    pin_training_kcal: null, pin_rest_kcal: null, pin_protein_g: null, input_weight_kg: 60,
    input_weight_source: "weigh-in", input_training_weekdays: [1], input_activity_level: "moderate",
    input_goal: "recomp", formula_name: "profile-energy-v1",
  } as TargetProfile;
  return targetRevisionFromProfile(profile)!;
}

const OCT_5 = revision("00000000-0000-4000-8000-000000000005", "2026-10-05", 5, 1900);
const OCT_6 = revision("00000000-0000-4000-8000-000000000006", "2026-10-06", 6, 2100);

/** A phone that pulled both revisions on Oct 5: Oct 6's waits in the history. */
function pulledOnOct5(): Settings {
  return settingsWithTargetRevisions(defaultSettings(), [OCT_5, OCT_6], "2026-10-05");
}

const H = { userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } as AccountHandle;

/** A store double: what `load` answers and what `save` received. */
function memory(settings: Settings) {
  let store = { settings } as Store;
  const save = vi.fn((_h: AccountHandle, next: Store) => { store = next; });
  return { load: () => store, save, current: () => store.settings };
}

describe("settingsForTargetDay", () => {
  it("makes the next day's revision current on its date, from the history alone", () => {
    const before = pulledOnOct5();
    expect(before.activeTargetProfile?.id).toBe(OCT_5.id);
    const after = settingsForTargetDay(before, "2026-10-06");
    expect(after.activeTargetProfile?.id).toBe(OCT_6.id);
    expect(after.trainingKcal).toBe(OCT_6.pins.trainingKcal);
  });

  it("returns the same object when the day changes nothing", () => {
    const settings = pulledOnOct5();
    expect(settingsForTargetDay(settings, "2026-10-05")).toBe(settings);
  });

  it("leaves an unsaved onboarding candidate and a cache with nothing dated alone", () => {
    const candidate = { ...pulledOnOct5(), activeTargetProfile: { ...OCT_6, revision: undefined } };
    expect(settingsForTargetDay(candidate as unknown as Settings, "2026-10-06")).toBe(candidate);
    const empty = defaultSettings();
    expect(settingsForTargetDay(empty, "2026-10-06")).toBe(empty);
  });
});

describe("targetDayRoll", () => {
  it("re-resolves on the first call and then only once per new local day", () => {
    const mem = memory(pulledOnOct5());
    let now = new Date(2026, 9, 5, 23, 59, 0);
    const roll = targetDayRoll(H, { now: () => now, load: mem.load, save: mem.save });
    expect(roll()).toBe(false); // Oct 5: already current, nothing to save.
    now = new Date(2026, 9, 5, 23, 59, 50);
    expect(roll()).toBe(false);
    now = new Date(2026, 9, 6, 0, 0, 30);
    expect(roll()).toBe(true);
    expect(mem.current().activeTargetProfile?.id).toBe(OCT_6.id);
    expect(mem.save).toHaveBeenCalledWith(H, expect.anything(), { silent: true });
    expect(roll()).toBe(false);
    expect(mem.save).toHaveBeenCalledTimes(1);
  });

  it("an account that changed meanwhile is not written", () => {
    const mem = memory(pulledOnOct5());
    const save = vi.fn(() => { throw new Error("AccountChanged"); });
    expect(refreshTargetDay(H, "2026-10-06", { load: mem.load, save })).toBe(false);
  });
});

describe("msUntilNextLocalDay", () => {
  it("counts to just after the next local midnight", () => {
    expect(msUntilNextLocalDay(new Date(2026, 9, 5, 23, 59, 0))).toBe(61_000);
    expect(msUntilNextLocalDay(new Date(2026, 9, 5, 23, 59, 59, 500))).toBe(1500);
  });
});

describe("account sync wiring", () => {
  it("rolls on start, on return to the tab and at local midnight, and says so", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 9, 5, 23, 59, 0));
      const roll = vi.fn(() => true);
      const synced = vi.fn();
      window.addEventListener(SYNCED_EVENT, synced);
      const stop = startAccountSync(H, { run: async () => {}, flushUndos: async () => {},
        rollTargetDay: roll });
      expect(roll).toHaveBeenCalledTimes(1);
      document.dispatchEvent(new Event("visibilitychange"));
      expect(roll).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(61_000);
      expect(roll).toHaveBeenCalledTimes(3);
      expect(synced).toHaveBeenCalledTimes(3);
      stop();
      vi.advanceTimersByTime(86_400_000);
      expect(roll).toHaveBeenCalledTimes(3);
      window.removeEventListener(SYNCED_EVENT, synced);
    } finally {
      vi.useRealTimers();
    }
  });
});
