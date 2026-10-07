/**
 * PR #248 review r2 #1: onboarding started as A writes nothing for B. Each await in the completion
 * and skip paths is followed by a check of A's handle, before the next write.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { persistCompletedOnboarding, persistSkippedOnboarding } from "@/lib/profile/onboarding-client";
import { createOnboardingState, onboardingReducer } from "@/lib/profile/onboarding-state";
import { AccountChanged, bindAccount, unbindAccount } from "@/lib/device/account";
import { defaultSettings } from "@/lib/store";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function answeredState() {
  let state = createOnboardingState(defaultSettings());
  for (const action of [
    { type: "edit_body", key: "heightCm", value: "165" },
    { type: "edit_body", key: "birthYear", value: "1996" },
    { type: "set_sex", value: "female" },
    { type: "edit_weight", value: "170" },
    { type: "set_activity", value: "moderate" },
    { type: "set_goal", value: "recomp" },
  ] as const) state = onboardingReducer(state, action);
  return state;
}

const EMPTY = { avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [], conditions: [],
  notes: null };

function deps() {
  return {
    saveLocal: vi.fn(),
    saveSynced: vi.fn(async () => undefined),
    saveWeighIn: vi.fn(async () => null),
    loadConstraints: vi.fn(async () => ({ profile: EMPTY, rev: 0 })),
    saveConstraints: vi.fn(async () => ({ status: "ok" }) as never),
    localDate: () => "2026-09-19",
    hasWeighIn: () => false,
  };
}

beforeEach(() => {
  unbindAccount();
  bindAccount(A);
});

describe("onboarding across a switch", () => {
  it("writes no settings or targets for B when the account changes during the weigh-in", async () => {
    const d = deps();
    d.saveWeighIn.mockImplementation(async () => { bindAccount(B); return null; });
    await expect(persistCompletedOnboarding(defaultSettings(), answeredState(),
      new Date("2026-09-19T15:30:00.000Z"), d)).rejects.toBeInstanceOf(AccountChanged);
    expect(d.saveSynced).not.toHaveBeenCalled();
    expect(d.saveLocal).not.toHaveBeenCalled();
    expect(d.saveConstraints).not.toHaveBeenCalled();
  });

  it("saves no constraints for B when the account changes during the constraints read", async () => {
    const d = deps();
    d.loadConstraints.mockImplementation(async () => { bindAccount(B); return { profile: EMPTY, rev: 0 }; });
    await expect(persistCompletedOnboarding(defaultSettings(), answeredState(),
      new Date("2026-09-19T15:30:00.000Z"), d)).rejects.toBeInstanceOf(AccountChanged);
    expect(d.saveConstraints).not.toHaveBeenCalled();
  });

  it("a skip saves no constraints and stamps nothing for B after a switch", async () => {
    const d = deps();
    d.loadConstraints.mockImplementation(async () => { bindAccount(B); return { profile: EMPTY, rev: 0 }; });
    await expect(persistSkippedOnboarding(defaultSettings(), new Date(), d))
      .rejects.toBeInstanceOf(AccountChanged);
    expect(d.saveConstraints).not.toHaveBeenCalled();
    expect(d.saveSynced).not.toHaveBeenCalled();
    expect(d.saveLocal).not.toHaveBeenCalled();
  });
});
