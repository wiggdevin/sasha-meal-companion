/**
 * Round 3 regression (reviewer finding, apply-profile.ts:97 et al.): `applyActivitySuggestion`
 * dates its target write by the day it was tapped, but its cache projection must pick the
 * revision in force the moment the server actually answers — not the day the tap captured.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TargetRevision } from "@/lib/types";
import { applyActivitySuggestion, type ActivityPromptClientDeps } from "@/lib/activity/prompt-client";
import { persistDerivedTargetRevision } from "@/lib/targets/client";
import { latestWeighInKg } from "@/lib/today/water-and-weight";
import { defaultStore } from "@/lib/store";
import { resetTestAccount } from "@/tests/helpers/account";

describe("applyActivitySuggestion across local midnight", () => {
  let savedTz: string | undefined;

  beforeEach(async () => {
    await resetTestAccount();
    savedTz = process.env.TZ;
    process.env.TZ = "UTC";
  });

  afterEach(() => {
    vi.useRealTimers();
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  });

  it("projects the revision in force when the response lands after midnight, not when it was sent", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-05T23:59:59.000Z") });

    const current: TargetRevision = {
      id: "00000000-0000-4000-8000-000000000008", revision: 8, source: "derived",
      effectiveFrom: "2026-09-18",
      training: { kcal: 2016, protein: 154, carbs: 190, fat: 71 },
      rest: { kcal: 1864, protein: 154, carbs: 152, fat: 71 },
      pins: { trainingKcal: null, restKcal: null, proteinG: null },
      inputs: { effectiveDate: "2026-09-18", weightKg: 60, weightSource: "weigh-in",
        trainingWeekdays: [1, 3, 4, 5], activity: "moderate", goal: "recomp", goalRateBpWeek: 0,
        formulaName: "profile-energy-v1" },
    };
    // Another write already pinned tomorrow's revision before this tap ever resolved.
    const nextDay: TargetRevision = { ...current, id: "00000000-0000-4000-8000-000000000009",
      revision: 9, effectiveFrom: "2026-10-06",
      inputs: { ...current.inputs, effectiveDate: "2026-10-06" } };

    const store = defaultStore();
    store.settings = {
      ...store.settings,
      sex: "female", birthYear: 1996, heightCm: 165, weightKg: 60,
      activityLevel: "moderate", goal: "recomp", trainingWeekdays: [1, 3, 4, 5],
      activeTargetProfile: current,
      targetHistory: [current, nextDay],
      targetHistorySince: current.effectiveFrom,
    };
    const saveStore = vi.fn();
    let resolveFn!: (value: TargetRevision) => void;
    const persistTargets = vi.fn<typeof persistDerivedTargetRevision>(
      () => new Promise<TargetRevision>((resolve) => { resolveFn = resolve; }));

    const deps: ActivityPromptClientDeps = {
      loadStore: () => store,
      saveStore,
      now: () => new Date(),
      latestWeighInKg: vi.fn<typeof latestWeighInKg>(() => 60),
      writeActivityLevel: vi.fn(async () => {}),
      writeDismissal: vi.fn(async () => {}),
      persistTargets,
    };

    const applyPromise = applyActivitySuggestion("active", deps);
    await vi.waitFor(() => expect(persistTargets).toHaveBeenCalled());
    // The request itself is still dated the day it was actually sent.
    expect(persistTargets.mock.calls.at(-1)?.[0]).toMatchObject({ today: "2026-10-05" });

    vi.setSystemTime(new Date("2026-10-06T00:00:05.000Z"));
    resolveFn({ ...current, id: "00000000-0000-4000-8000-000000000010", revision: 10,
      effectiveFrom: "2026-10-05", inputs: { ...current.inputs, effectiveDate: "2026-10-05" } });
    await applyPromise;

    // The cache projects whatever is in force the moment the write actually landed — the day
    // after, where another write had already pinned a revision — never the day it was sent.
    expect(saveStore).toHaveBeenCalledWith(expect.objectContaining({
      settings: expect.objectContaining({
        activeTargetProfile: expect.objectContaining({ id: nextDay.id }),
      }),
    }));
  });
});
