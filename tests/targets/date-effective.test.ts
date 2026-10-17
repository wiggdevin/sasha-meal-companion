/**
 * Calculation audit 2026-10-05 #16 and #23: a viewed date resolves the revision in force on that
 * date (with its own training weekdays), and a malformed revision is rejected, never read as 0.
 */
import { describe, expect, it } from "vitest";
import type { TargetProfile } from "@/lib/api-types";
import { mealCountFor, resolveSlotTimes } from "@/lib/plan";
import { plannedSlotIds, ratiosFor } from "@/lib/plan/slot-share";
import { resolveDay } from "@/lib/resolve";
import { defaultSettings, defaultStore } from "@/lib/store";
import { resolveTargets, targetDayType } from "@/lib/targets";
import {
  mergeTargetHistory, settingsFromTargetMirror, settingsWithoutTargetRevision,
  settingsWithTargetRevision, settingsWithTargetRevisions, targetRevisionFromProfile, targetRevisionOn, TARGET_HISTORY_LIMIT,
} from "@/lib/targets/revision";
import { waterGoalWeightKg } from "@/lib/today/water-and-weight";
import type { Settings, Store, TargetRevision } from "@/lib/types";

function row(overrides: Partial<TargetProfile> = {}): TargetProfile {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    user_id: "00000000-0000-4000-8000-000000000010",
    effective_from: "2026-09-19",
    rev: 4,
    kcal_train: 1900, kcal_rest: 1700, authored_by: "user", mode: "grams",
    protein_g: 120, fat_g: 70, carb_g: 200, protein_pct: null, fat_pct: null, carb_pct: null,
    kcal_min: 1200, protein_g_min: 100, fat_g_min: 40, carb_g_min: 0,
    goal_rate_bp_week: 0, max_weekly_kcal_step: 150, notes: null,
    target_source: "derived",
    training_macros: { kcal: 1900, protein: 120, carbs: 200, fat: 70 },
    rest_macros: { kcal: 1700, protein: 120, carbs: 160, fat: 66 },
    pin_training_kcal: null, pin_rest_kcal: null, pin_protein_g: null,
    input_weight_kg: 60,
    input_weight_source: "weigh-in",
    // Monday only.
    input_training_weekdays: [1],
    input_activity_level: "moderate",
    input_goal: "recomp",
    formula_name: "profile-energy-v1",
    ...overrides,
  };
}

const OCT_1 = targetRevisionFromProfile(row({ effective_from: "2026-10-01", rev: 4 }))!;
// Effective Monday 5 October: 2,200 kcal training, and Sunday (0) is now a training day.
const OCT_5 = targetRevisionFromProfile(row({
  id: "00000000-0000-4000-8000-000000000002", effective_from: "2026-10-05", rev: 5,
  training_macros: { kcal: 2200, protein: 130, carbs: 250, fat: 76 },
  rest_macros: { kcal: 2000, protein: 130, carbs: 200, fat: 76 },
  input_training_weekdays: [0],
}))!;

const OCT_1_ID = OCT_1.id!;
const OCT_5_ID = OCT_5.id!;

// The phone's "today" for these cases: on or after both revisions.
const TODAY = "2026-10-06";

function settingsWith(...revisions: TargetRevision[]): Settings {
  return settingsOn(TODAY, ...revisions);
}

function settingsOn(today: string, ...revisions: TargetRevision[]): Settings {
  return revisions.reduce((settings, revision) =>
    settingsWithTargetRevision(settings, revision, today),
  { ...defaultSettings(), trainingWeekdays: [1] } as Settings);
}

function store(settings: Settings): Store {
  return { version: 1, firstOpenedAt: "2026-09-01T00:00:00.000Z", settings, days: {}, foods: {} };
}

describe("the revision in force on a date (audit #16)", () => {
  it("applies a revision from its effective date, not to the day before", () => {
    const settings = settingsWith(OCT_1, OCT_5);
    expect(settings.activeTargetProfile?.revision).toBe(5);
    // Sunday 4 October is still the 1 October revision: a rest day at 1,700 kcal.
    expect(ratiosFor(store(settings), "2026-10-04")).toMatchObject({
      dayType: "rest", targets: { kcal: 1700 } });
    // Monday 5 October is the new revision; Monday is no longer a training day in it.
    expect(ratiosFor(store(settings), "2026-10-05")).toMatchObject({
      dayType: "rest", targets: { kcal: 2000 } });
    // Sunday 11 October: the new revision's own weekday trains at 2,200.
    expect(ratiosFor(store(settings), "2026-10-11")).toMatchObject({
      dayType: "training-10", targets: { kcal: 2200 } });
  });

  it("takes the training weekdays from the revision in force, not the current one", () => {
    const settings = settingsWith(OCT_1, OCT_5);
    // Monday 28 September predates both: no revision was in force, as the server answers
    // (effective_from <= date). The day type falls back to the profile weekdays (Monday trains).
    expect(targetDayType("2026-09-28", undefined, settings)).toBe("training-10");
    expect(resolveTargets("training-10", settings, "2026-09-28")).toBeNull();
    // Sunday 4 October under the 1 October revision rests; Sunday 11 October trains.
    expect(targetDayType("2026-10-04", undefined, settings)).toBe("rest");
    expect(targetDayType("2026-10-11", undefined, settings)).toBe("training-10");
    // An override still wins.
    expect(targetDayType("2026-10-04", "training-10", settings)).toBe("training-10");
  });

  it("keeps the newer revision current when an older one arrives later", () => {
    const settings = settingsWith(OCT_5, OCT_1);
    expect(settings.activeTargetProfile?.revision).toBe(5);
    expect(targetRevisionOn(settings, "2026-10-04")?.revision).toBe(4);
    expect(targetRevisionOn(settings, "2026-10-06")?.revision).toBe(5);
  });

  it("makes a lower rev with a later effective date current on and after its date", () => {
    // rev 7 effective 1 October, then a backdated-number row: rev 6 effective 5 October.
    const high = { ...OCT_1, id: "high", revision: 7 };
    const later = { ...OCT_5, id: "later", revision: 6 };
    for (const order of [[high, later], [later, high]]) {
      expect(settingsOn("2026-10-05", ...order).activeTargetProfile?.id).toBe("later");
      expect(settingsOn("2026-10-04", ...order).activeTargetProfile?.id).toBe("high");
    }
  });

  it("keeps a future-dated revision out of current until its date", () => {
    const before = settingsOn("2026-10-04", OCT_1, OCT_5);
    expect(before.activeTargetProfile?.revision).toBe(4);
    expect(before.targetHistory?.map((r) => r.revision)).toEqual([4, 5]);
    expect(resolveTargets("training-10", before)?.macros.kcal).toBe(1900);
    // The next pass on 5 October retargets the cache with no new revision.
    const after = settingsFromTargetMirror(before, [OCT_1, OCT_5], "2026-10-05");
    expect(after.activeTargetProfile?.revision).toBe(5);
    expect(resolveTargets("training-10", after)?.macros.kcal).toBe(2200);
  });

  it("moves the settings pins with the current effective revision", () => {
    const pinned = { ...OCT_5, pins: { trainingKcal: 2200, restKcal: null, proteinG: 130 } };
    const before = settingsOn("2026-10-04", OCT_1, pinned);
    expect([before.trainingKcal, before.restKcal, before.proteinG]).toEqual([null, null, null]);
    const after = settingsFromTargetMirror(before, [OCT_1, pinned], "2026-10-05");
    expect([after.trainingKcal, after.restKcal, after.proteinG]).toEqual([2200, null, 130]);
    expect(settingsFromTargetMirror(after, [OCT_1, pinned], "2026-10-05")).toBe(after);
  });

  it("rebuilds from the mirror: a same-rev correction replaces the cached copy, a malformed row leaves", () => {
    const coerced = { ...OCT_5, training: { kcal: 0, protein: 0, carbs: 0, fat: 0 } };
    const cached = settingsWith(OCT_1, coerced);
    expect(cached.activeTargetProfile?.training.kcal).toBe(0);
    const rebuilt = settingsFromTargetMirror(cached, [OCT_5], TODAY, [OCT_1_ID]);
    expect(rebuilt.activeTargetProfile?.training.kcal).toBe(2200);
    expect(rebuilt.targetHistory?.map((r) => r.revision)).toEqual([5]);
  });

  it("returns a coerced cache to needs_profile when every mirrored row is malformed (#23)", () => {
    const coerced = { ...OCT_5, training: { kcal: 0, protein: 0, carbs: 0, fat: 0 },
      pins: { trainingKcal: 2200, restKcal: null, proteinG: 130 } };
    const cached = settingsWith(coerced);
    expect(cached.activeTargetProfile?.training.kcal).toBe(0);
    // The mirror holds the row (by id) but it parses to nothing.
    const rebuilt = settingsFromTargetMirror(cached, [], TODAY, [OCT_5_ID]);
    expect(rebuilt.activeTargetProfile).toBeNull();
    expect(rebuilt.targetHistory).toEqual([]);
    expect([rebuilt.trainingKcal, rebuilt.restKcal, rebuilt.proteinG]).toEqual([null, null, null]);
    expect(resolveTargets("training-10", rebuilt, "2026-10-06")).toBeNull();
    // Even a mirror with no row at all never keeps a 0 kcal copy as a save awaiting its pull.
    expect(settingsFromTargetMirror(cached, [], TODAY).activeTargetProfile).toBeNull();
    // Already at needs_profile: nothing changes.
    expect(settingsFromTargetMirror(rebuilt, [], TODAY, [OCT_5_ID])).toBe(rebuilt);
  });

  it("drops a current row the mirror holds but cannot parse, and keeps the rest", () => {
    const cached = settingsWith(OCT_1, OCT_5);
    const rebuilt = settingsFromTargetMirror(cached, [OCT_1], TODAY, [OCT_1_ID, OCT_5_ID]);
    expect(rebuilt.activeTargetProfile?.id).toBe(OCT_1_ID);
    expect(rebuilt.targetHistory?.map((r) => r.revision)).toEqual([4]);
  });

  it("keeps a saved current revision whose row has not been pulled yet", () => {
    const cached = settingsWith(OCT_1, OCT_5);
    const rebuilt = settingsFromTargetMirror(cached, [OCT_1], TODAY, [OCT_1_ID]);
    expect(rebuilt.activeTargetProfile?.id).toBe(OCT_5_ID);
    expect(rebuilt.targetHistory?.map((r) => r.revision)).toEqual([4, 5]);
  });

  it("never resurrects a deleted current revision", () => {
    const cached = settingsWith(OCT_1, OCT_5);
    const deleted = settingsWithoutTargetRevision(cached, OCT_5_ID, TODAY);
    expect(deleted.activeTargetProfile?.id).toBe(OCT_1_ID);
    expect(deleted.targetHistory?.map((r) => r.revision)).toEqual([4]);
    expect(settingsFromTargetMirror(deleted, [OCT_1], TODAY, [OCT_1_ID])).toBe(deleted);
    // The last revision deleted: needs_profile.
    const none = settingsWithoutTargetRevision(deleted, OCT_1_ID, TODAY);
    expect(none.activeTargetProfile).toBeNull();
    expect(settingsFromTargetMirror(none, [], TODAY)).toBe(none);
  });

  it("leaves an unsaved preview current when a delete is pulled", () => {
    const preview = { ...settingsWith(OCT_1), activeTargetProfile: {
      training: OCT_5.training, rest: OCT_5.rest } };
    const after = settingsWithoutTargetRevision(preview, OCT_1_ID, TODAY);
    expect(after.activeTargetProfile).toBe(preview.activeTargetProfile);
    expect(after.targetHistory).toEqual([]);
  });

  it("re-asserts drifted pins on every pass, the current revision unchanged", () => {
    const pinned = { ...OCT_5, pins: { trainingKcal: 2200, restKcal: null, proteinG: 130 } };
    const drifted = { ...settingsWith(OCT_1, pinned), trainingKcal: 1800, proteinG: null };
    const reapplied = settingsWithTargetRevisions(drifted, [pinned], TODAY);
    expect([reapplied.trainingKcal, reapplied.proteinG]).toEqual([2200, 130]);
    expect(reapplied.activeTargetProfile).toBe(drifted.activeTargetProfile);
    // An empty sync pass (the mirror rebuild) heals them too.
    const healed = settingsFromTargetMirror(drifted, [OCT_1, pinned], TODAY);
    expect([healed.trainingKcal, healed.restKcal, healed.proteinG]).toEqual([2200, null, 130]);
    expect(settingsFromTargetMirror(healed, [OCT_1, pinned], TODAY)).toBe(healed);
  });

  it("keeps a saved revision that is not current until its row is pulled", () => {
    // Saved for tomorrow while 1 October is in force: it lives only in the history.
    const cached = settingsOn("2026-10-04", OCT_1, OCT_5);
    const rebuilt = settingsFromTargetMirror(cached, [OCT_1], "2026-10-04", [OCT_1_ID]);
    expect(rebuilt).toBe(cached);
    expect(targetRevisionOn(rebuilt, "2026-10-05")?.revision).toBe(5);
  });

  it("makes no revision current while every one is future-dated, as the server does", () => {
    // The server's active read is `effective_from <= today`: none yet → needs_profile.
    const waiting = settingsOn("2026-10-04", OCT_5);
    expect(waiting.activeTargetProfile ?? null).toBeNull();
    expect([waiting.trainingKcal, waiting.restKcal, waiting.proteinG]).toEqual([null, null, null]);
    expect(waiting.targetHistory?.map((r) => r.revision)).toEqual([5]);
    expect(resolveTargets("training-10", waiting)).toBeNull();
    expect(resolveTargets("rest", waiting, "2026-10-04")).toBeNull();
    // A viewed future date already resolves it, as the server's dated reads do.
    expect(resolveTargets("rest", waiting, "2026-10-05")?.macros.kcal).toBe(2000);
    // On its date the next pass makes it current.
    const live = settingsFromTargetMirror(waiting, [OCT_5], "2026-10-05");
    expect(live.activeTargetProfile?.revision).toBe(5);
    // A pinned future revision never lends its pins early either.
    const pinned = { ...OCT_5, pins: { trainingKcal: 2200, restKcal: null, proteinG: 130 } };
    expect(settingsOn("2026-10-04", pinned).trainingKcal).toBeNull();
  });

  it("takes a brand-new account's first revision on its local onboarding day", () => {
    // Onboarding dates the revision from the LOCAL day it finished (lib/profile/onboarding-client),
    // and the server's dated reads use the account's local date: 8 pm on 4 October in Los Angeles
    // (already 5 October in UTC) gives a revision effective 4 October, current that evening.
    const first = { ...OCT_1, id: "first", effectiveFrom: "2026-10-04",
      inputs: { ...OCT_1.inputs, effectiveDate: "2026-10-04" } };
    expect(settingsOn("2026-10-04", first).activeTargetProfile?.id).toBe("first");
    // A revision dated by the UTC day instead (5 October) is not in force on the local 4th, on
    // the phone or in the server's local-date reads; it becomes current on the 5th.
    const utcDated = { ...first, id: "utc", effectiveFrom: "2026-10-05" };
    expect(settingsOn("2026-10-04", utcDated).activeTargetProfile ?? null).toBeNull();
    expect(settingsOn("2026-10-05", utcDated).activeTargetProfile?.id).toBe("utc");
  });

  it("draws the water goal weight from the revision in force on the date", () => {
    const heavier = { ...OCT_5, inputs: { ...OCT_5.inputs, weightKg: 70 } };
    const settings = { ...settingsWith(OCT_1, heavier), weightKg: null };
    expect(waterGoalWeightKg("2026-10-04", settings)).toBe(60);
    expect(waterGoalWeightKg("2026-10-06", settings)).toBe(70);
  });

  it("draws a future day's water weight from that day's revision, not today's weigh-in revision", () => {
    // On 4 October the 1 October weigh-in revision (60 kg) is current; 5 October's is 70 kg.
    const heavier = { ...OCT_5, inputs: { ...OCT_5.inputs, weightKg: 70 } };
    const settings = { ...settingsOn("2026-10-04", OCT_1, heavier), weightKg: null };
    expect(settings.activeTargetProfile?.revision).toBe(4);
    expect(waterGoalWeightKg("2026-10-04", settings)).toBe(60);
    expect(waterGoalWeightKg("2026-10-06", settings)).toBe(70);
  });

  it("uses the history even when the cached current carries no effective date", () => {
    const legacy = { ...settingsWith(OCT_1, OCT_5),
      activeTargetProfile: { revision: 5, training: OCT_5.training, rest: OCT_5.rest } };
    expect(targetRevisionOn(legacy, "2026-10-04")?.revision).toBe(4);
  });

  it("uses the highest rev on a shared effective date", () => {
    const same = targetRevisionFromProfile(row({ effective_from: "2026-10-01", rev: 6,
      training_macros: { kcal: 2050, protein: 120, carbs: 230, fat: 70 } }))!;
    const settings = settingsWith(OCT_1, OCT_5, same);
    expect(targetRevisionOn(settings, "2026-10-02")?.training.kcal).toBe(2050);
    expect(settings.targetHistory?.map((r) => r.revision)).toEqual([6, 5]);
  });

  it("answers needs_profile without a saved revision, whatever the date", () => {
    expect(resolveTargets("rest", defaultSettings(), "2026-10-04")).toBeNull();
    const candidate = { ...settingsWith(OCT_1), activeTargetProfile: {
      training: OCT_1.training, rest: OCT_1.rest } };
    expect(resolveTargets("rest", candidate, "2026-10-04")).toBeNull();
  });

  it("resolves a date the capped history dropped to the boundary revision, never needs_profile", () => {
    const daily = Array.from({ length: TARGET_HISTORY_LIMIT + 5 }, (_, i) => ({
      ...OCT_1, id: `daily-${i}`, revision: i + 1,
      effectiveFrom: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
      inputs: { ...OCT_1.inputs, effectiveDate: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10) } }));
    const today = daily.at(-1)!.effectiveFrom;
    const base = { ...defaultSettings(), trainingWeekdays: [1] } as Settings;
    for (const settings of [
      settingsWithTargetRevisions(base, daily, today),
      settingsFromTargetMirror(base, daily, today),
    ]) {
      expect(settings.targetHistory).toHaveLength(TARGET_HISTORY_LIMIT);
      expect(settings.targetHistory?.[0].effectiveFrom).toBe("2026-01-06");
      expect(settings.targetHistorySince).toBe("2026-01-01");
      // 3 January: the server finds the 3 January revision; the phone, which dropped it, gives
      // the boundary revision (the oldest kept), not needs_profile.
      expect(targetRevisionOn(settings, "2026-01-03")?.id).toBe("daily-5");
      expect(resolveTargets("rest", settings, "2026-01-03")).not.toBeNull();
      // Before the account's first revision there is none, on the server and here.
      expect(targetRevisionOn(settings, "2025-12-31")).toBeNull();
      // Re-applying an already-held revision keeps the earliest date.
      expect(settingsWithTargetRevisions(settings, [daily.at(-1)!], today).targetHistorySince)
        .toBe("2026-01-01");
    }
  });

  it("bounds the history to the newest effective dates", () => {
    const many = Array.from({ length: TARGET_HISTORY_LIMIT + 5 }, (_, i) => ({
      ...OCT_1, revision: i + 1,
      effectiveFrom: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10) }));
    const history = mergeTargetHistory(null, many);
    expect(history).toHaveLength(TARGET_HISTORY_LIMIT);
    expect(history[0].revision).toBe(6);
    expect(history.at(-1)?.revision).toBe(TARGET_HISTORY_LIMIT + 5);
  });
});

describe("a malformed revision is rejected, never coerced (audit #23)", () => {
  it.each([
    ["a null training kcal", { training_macros: { kcal: null, protein: 120, carbs: 200, fat: 70 } }],
    ["a missing rest protein", { rest_macros: { kcal: 1700, carbs: 160, fat: 66 } }],
    ["a blank string kcal", { training_macros: { kcal: "", protein: 120, carbs: 200, fat: 70 } }],
    ["a zero kcal", { rest_macros: { kcal: 0, protein: 120, carbs: 160, fat: 66 } }],
    ["a negative fat", { rest_macros: { kcal: 1700, protein: 120, carbs: 160, fat: -1 } }],
    ["a null input weight", { input_weight_kg: null }],
    ["a weekday outside 0–6", { input_training_weekdays: [1, 7] }],
    ["a null weekday", { input_training_weekdays: [1, null] }],
    ["a zero pin", { pin_training_kcal: 0 }],
    ["a non-numeric rate", { goal_rate_bp_week: "fast" }],
  ])("rejects %s", (_label, overrides) => {
    expect(targetRevisionFromProfile(row(overrides as unknown as Partial<TargetProfile>))).toBeNull();
  });

  it("keeps a valid row, numeric strings included, and zero carbs or fat", () => {
    const revision = targetRevisionFromProfile(row({
      rest_macros: { kcal: 1700, protein: 120, carbs: 0, fat: 66 },
      kcal_min: "1200" as unknown as number, goal_rate_bp_week: null as unknown as number,
    }));
    expect(revision?.rest.carbs).toBe(0);
    expect(revision?.floors?.kcalMin).toBe(1200);
    expect(revision?.inputs.goalRateBpWeek).toBe(0);
  });

  it("keeps the macros and drops the floors when a floor column is missing or malformed", () => {
    for (const overrides of [{ protein_g_min: null }, { kcal_min: "" }, { fat_g_min: -1 }]) {
      const revision = targetRevisionFromProfile(row(overrides as unknown as Partial<TargetProfile>));
      expect(revision?.training.kcal).toBe(1900);
      expect(revision?.floors).toBeUndefined();
    }
    expect(targetRevisionFromProfile(row({ kcal_min: 0 }))?.floors?.kcalMin).toBe(0);
  });

  it("rejects a blank seed instead of storing 0 kcal", () => {
    const revision = targetRevisionFromProfile(row({ initial_tdee_kcal: "" as unknown as number,
      bmr_kcal: 1300, bmr_method: "mifflin", activity_model_version: "a",
      derivation_version: "d" }));
    expect(revision?.seed).toBeNull();
  });
});

// Audit A063: a viewed date's meal count and slot clocks come from the revision in force on it.
describe("the viewed date's meal layout", () => {
  // OCT_1 trains at 1,900 kcal (four meals); a 1,700 kcal revision before it gives three.
  const SEP_1 = targetRevisionFromProfile(row({
    id: "00000000-0000-4000-8000-000000000003", effective_from: "2026-09-01", rev: 3,
    training_macros: { kcal: 1700, protein: 120, carbs: 180, fat: 60 },
  }))!;
  const layoutStore = (): Store => ({ ...defaultStore(), settings: settingsWith(SEP_1, OCT_1) });
  const meals = (date: string) => resolveDay(layoutStore(), date).slots
    .filter((slot) => slot.slot.startsWith("meal-")).map((slot) => `${slot.slot}@${slot.time}`);

  it("gives a past date its own revision's count and clocks, not today's", () => {
    expect(layoutStore().settings.activeTargetProfile?.id).toBe(OCT_1_ID);
    expect(meals("2026-09-15")).toEqual(["meal-1@08:00", "meal-2@12:30", "meal-3@18:30"]);
    expect(meals(TODAY)).toEqual(["meal-1@08:00", "meal-2@11:30", "meal-3@15:00", "meal-4@18:30"]);
    expect(plannedSlotIds(layoutStore(), "2026-09-15", "rest")).toEqual(["meal-1", "meal-2", "meal-3"]);
  });

  it("reads the same layout through mealCountFor and resolveSlotTimes with the date", () => {
    const settings = layoutStore().settings;
    expect(mealCountFor(settings, "2026-09-15")).toBe(3);
    expect(mealCountFor(settings, TODAY)).toBe(4);
    expect(mealCountFor(settings)).toBe(4);
    expect(resolveSlotTimes("rest", settings, "2026-09-15").map((row) => row.time))
      .toEqual(["08:00", "12:30", "18:30"]);
  });
});
