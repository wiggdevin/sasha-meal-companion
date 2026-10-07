import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import ActivityMismatchPrompt, { ActivityMismatchPromptView }
  from "@/components/ActivityMismatchPrompt";
import {
  activityLevelForSteps, activityPromptEligibility, type PromptDay,
} from "@/lib/activity/prompt";
import {
  applyActivitySuggestion, dismissActivityPrompt, DISMISSAL_DAYS,
  readActivityPromptDismissal, writeActivityPromptDismissal,
  type ActivityPromptClientDeps,
} from "@/lib/activity/prompt-client";
import { defaultStore } from "@/lib/store";
import type { TargetRevision } from "@/lib/types";
import { resetTestAccount } from "@/tests/helpers/account";

beforeEach(async () => { await resetTestAccount(); });

const settingsMocks = vi.hoisted(() => ({
  getRow: vi.fn(),
  mutateUserSettings: vi.fn(),
}));

vi.mock("@/lib/sync/idb", () => ({
  getRow: settingsMocks.getRow, closeAllAccountDbs: async () => {},
}));
vi.mock("@/lib/sync/outbox", () => ({
  USER_SETTINGS_KEY: "settings",
  mutateUserSettings: settingsMocks.mutateUserSettings,
}));

const AS_OF = "2026-09-20";
// Local noon on AS_OF, parsed in the process zone like targetDayFor reads it, so "today" is
// AS_OF in every zone (a fixed UTC instant rolls to the next day east of UTC+6).
const NOW = new Date(`${AS_OF}T12:00:00`);

function days(count: number, steps: number | null, startAge = 1): PromptDay[] {
  return Array.from({ length: count }, (_, index) => ({
    local_date: new Date(Date.parse(`${AS_OF}T00:00:00Z`) - (startAge + index) * 86_400_000)
      .toISOString().slice(0, 10),
    steps,
  }));
}

describe("activityLevelForSteps", () => {
  it.each([
    [4_999, "sedentary"], [5_000, "light"], [7_499, "light"],
    [7_500, "moderate"], [9_999, "moderate"], [10_000, "active"],
    [12_499, "active"], [12_500, "very_active"],
  ] as const)("maps %i steps to %s", (stepsPerDay, expected) => {
    expect(activityLevelForSteps(stepsPerDay)).toBe(expected);
  });
});

describe("activityPromptEligibility", () => {
  const eligible = (over: Partial<Parameters<typeof activityPromptEligibility>[0]> = {}) =>
    activityPromptEligibility({ days: days(14, 10_000), asOf: AS_OF,
      savedActivityLevel: "light", profileComplete: true, isSaving: false,
      dismissedUntil: null, now: NOW, ...over });

  it("requires 14 numeric days in the last 28 completed local days", () => {
    expect(eligible({ days: [...days(13, 10_000), ...days(15, null, 14)] })).toBeNull();
    expect(eligible()).toMatchObject({ observed: "active", saved: "light", observedDays: 14 });
    expect(eligible({ days: [...days(14, 10_000), ...days(4, 99_999, 29)] })?.averageSteps)
      .toBe(10_000);
  });

  it("requires at least two ordinal bands and rejects exact or one-band matches", () => {
    expect(eligible({ savedActivityLevel: "active" })).toBeNull();
    expect(eligible({ savedActivityLevel: "moderate" })).toBeNull();
    expect(eligible({ savedActivityLevel: "light" })).not.toBeNull();
  });

  it("hides for incomplete profiles, saves in flight, read failure, and future dismissal", () => {
    expect(eligible({ profileComplete: false })).toBeNull();
    expect(eligible({ isSaving: true })).toBeNull();
    expect(eligible({ savedActivityLevel: null })).toBeNull();
    expect(eligible({ dismissedUntil: new Date(NOW.getTime() + 86_400_000).toISOString() })).toBeNull();
    expect(eligible({ dismissedUntil: NOW.toISOString() })).not.toBeNull();
  });
});

function deps(): ActivityPromptClientDeps {
  const store = defaultStore();
  store.settings = { ...store.settings, sex: "female", birthYear: 1990, heightCm: 165,
    weightKg: 60, activityLevel: "light", goal: "maintain", trainingWeekdays: [1, 3, 5],
    trainingKcal: 2_100, restKcal: null, proteinG: 130 };
  return {
    loadStore: vi.fn(() => store), saveStore: vi.fn(), now: vi.fn(() => NOW),
    latestWeighInKg: vi.fn(() => 59.5), writeActivityLevel: vi.fn(async () => undefined),
    writeDismissal: vi.fn(async () => undefined),
    persistTargets: vi.fn(async () => ({
      id: "target-2", revision: 2, source: "derived", effectiveFrom: AS_OF,
      training: { kcal: 2_100, protein: 130, carbs: 240, fat: 70 },
      rest: { kcal: 1_900, protein: 130, carbs: 190, fat: 70 },
      pins: { trainingKcal: 2_100, restKcal: null, proteinG: 130 },
      inputs: { effectiveDate: AS_OF, weightKg: 59.5, weightSource: "weigh-in",
        trainingWeekdays: [1, 3, 5], activity: "active", goal: "maintain",
        formulaName: "mifflin-st-jeor" },
    } as TargetRevision)),
  };
}

describe("activity prompt writes", () => {
  afterEach(() => { vi.clearAllMocks(); });

  it("writes and reads the dismissal through the canonical user-settings mirror", async () => {
    const until = "2026-10-20T18:00:00.000Z";
    let mutation: { row: Record<string, unknown>; op: { payload: Record<string, unknown>;
      base_rev: number | null; kind: string } } | undefined;
    settingsMocks.mutateUserSettings.mockImplementationOnce(async (_h, mutate) => {
      mutation = mutate({ rev: 7, user_id: "user-1", time_zone: "America/Denver",
        activity_level: "light" });
      return undefined;
    });

    await writeActivityPromptDismissal(until);

    expect(mutation?.row).toMatchObject({ rev: 7, time_zone: "America/Denver",
      activity_level: "light", activity_prompt_dismissed_until: until });
    expect(mutation?.op).toMatchObject({ base_rev: 7, kind: "update",
      payload: { time_zone: "America/Denver", activity_level: "light",
        activity_prompt_dismissed_until: until } });
    expect(mutation?.op.payload).not.toHaveProperty("rev");
    expect(mutation?.op.payload).not.toHaveProperty("user_id");

    settingsMocks.getRow.mockResolvedValueOnce({
      activity_prompt_dismissed_until: until,
    });
    await expect(readActivityPromptDismissal()).resolves.toBe(until);
  });

  it("dismisses for exactly 30 days", async () => {
    const ports = deps();
    await dismissActivityPrompt(ports);
    expect(DISMISSAL_DAYS).toBe(30);
    expect(ports.writeDismissal).toHaveBeenCalledWith(
      new Date(NOW.getTime() + 30 * 86_400_000).toISOString(),
    );
  });

  it("changes the category and asks target authority to derive without caller-authored targets", async () => {
    const ports = deps();
    const calls: string[] = [];
    const persistTargets = vi.mocked(ports.persistTargets).getMockImplementation();
    vi.mocked(ports.writeActivityLevel).mockImplementationOnce(async () => {
      calls.push("settings");
    });
    vi.mocked(ports.persistTargets).mockImplementationOnce(async (input) => {
      calls.push("targets");
      return persistTargets!(input);
    });
    await applyActivitySuggestion("active", ports);
    expect(calls).toEqual(["settings", "targets"]);
    expect(ports.writeActivityLevel).toHaveBeenCalledWith("active");
    expect(ports.persistTargets).toHaveBeenCalledWith({
      settings: expect.objectContaining({ activityLevel: "active", trainingKcal: 2_100,
        restKcal: null, proteinG: 130 }),
      latestWeighInKg: 59.5, today: AS_OF, trainingWeekdays: [1, 3, 5], source: "manual",
    });
    const call = vi.mocked(ports.persistTargets).mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(call).not.toHaveProperty("kcalTrain");
    expect(call).not.toHaveProperty("kcalRest");
    expect(call).not.toHaveProperty("proteinG");
    expect(ports.saveStore).toHaveBeenCalledOnce();
  });

  it("does not derive targets or save the phone cache when the activity mirror write fails", async () => {
    const ports = deps();
    vi.mocked(ports.writeActivityLevel).mockRejectedValueOnce(new Error("settings write failed"));

    await expect(applyActivitySuggestion("active", ports)).rejects.toThrow("settings write failed");

    expect(ports.persistTargets).not.toHaveBeenCalled();
    expect(ports.saveStore).not.toHaveBeenCalled();
  });
});

describe("ActivityMismatchPrompt", () => {
  afterEach(() => { delete process.env.NEXT_PUBLIC_ACTIVITY_PROMPT_UI; });

  it("uses the exact ready, saving, saved and failed copy with 44 px controls", () => {
    const suggestion = { observed: "active" as const, saved: "light" as const,
      averageSteps: 10_000, observedDays: 14 };
    const view = (state: "ready" | "saving" | "success" | "failure") =>
      renderToStaticMarkup(createElement(ActivityMismatchPromptView,
        { suggestion, state, onUpdate: () => {}, onDismiss: () => {} }));
    const ready = view("ready");
    expect(ready).toContain("Activity check");
    expect(ready).toContain("Your steps look active, but your profile says light. Update your activity level?");
    expect(ready).toContain("Update to active");
    expect(ready).toContain("Not now");
    // Two system buttons at md, 44 px (components/ui/Button, DESIGN.md §Buttons).
    expect((ready.match(/\bbtn-md\b/g) ?? [])).toHaveLength(2);

    // Saving keeps the label (and its width) and shows the button's pending dots.
    const saving = view("saving");
    expect(saving).toContain("Update to active");
    expect(saving).toMatch(/aria-busy="true"[^>]*data-status="pending"|data-status="pending"[^>]*aria-busy="true"/);
    expect(view("success"))
      .toContain("Activity level updated. Your targets were recalculated.");
    const failure = view("failure");
    expect(failure).toContain("That did not save. Try again.");
    expect(failure).toContain("Update to active");
  });

  it("renders nothing with the flag off — only the literal string true offers the prompt", () => {
    process.env.NEXT_PUBLIC_ACTIVITY_PROMPT_UI = "1";
    expect(renderToStaticMarkup(createElement(ActivityMismatchPrompt))).toBe("");
    process.env.NEXT_PUBLIC_ACTIVITY_PROMPT_UI = "true";
    expect(renderToStaticMarkup(createElement(ActivityMismatchPrompt))).toBe("");
  });
});
