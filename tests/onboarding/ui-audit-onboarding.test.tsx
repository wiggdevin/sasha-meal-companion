// @vitest-environment jsdom
/**
 * UI audit 2026-10-18 §10 (onboarding flow and picker): the picker says when a write or the catalog
 * load failed, rule kinds read as words, the fall uses three lanes on a narrow phone, and the
 * reward card writes meal times the way the rest of the flow does.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DietaryProfilePickerView } from "@/components/Onboarding/DietaryProfilePicker";
import { laneCount, pickLane } from "@/components/Onboarding/FallingFoodPile";
import RewardPlateCard from "@/components/Onboarding/reward/RewardPlateCard";
import type { ProfileSummary } from "@/lib/policy/profiles/catalog-summary";

afterEach(cleanup);

const VEGAN: ProfileSummary = {
  id: "vegan", label: "Vegan", category: "ethical_lifestyle", synonyms: ["vegan"],
  do: [], dont: [], hardBasis: "user_rule", requiresUserConfirmation: false, options: [],
  items: [{ facet: "contains_animal_product", strength: "never", hardBasis: "user_rule" }],
};

function picker(props: Partial<React.ComponentProps<typeof DietaryProfilePickerView>> = {}) {
  return render(<DietaryProfilePickerView catalog={[VEGAN]} instances={[]} query="vegan" busyId={null}
    onQueryChange={() => {}} onConfirm={() => {}} onRemove={() => {}} {...props} />);
}

describe("the dietary profile picker", () => {
  it("says on the row when a confirm did not save", () => {
    picker({ rowError: { profileId: "vegan", message: "Couldn’t save this rule. Check your connection and try again." } });
    expect(screen.getByRole("alert").textContent).toContain("Couldn’t save this rule");
  });

  it("says when the catalog did not load, with a retry, instead of a blank list", () => {
    const retry = vi.fn();
    picker({ catalog: [], catalogReady: false, catalogError: true, onRetryCatalog: retry });
    expect(screen.getByRole("alert").textContent).toContain("Couldn’t load the dietary profiles.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("names no internal model and labels rule kinds in words", () => {
    picker({ onAddCustomRule: async () => true,
      customRules: [{ id: "r1", kind: "ingredient", text: "garlic" }, { id: "r2", kind: "cuisine", text: "Thai" }] });
    expect(screen.queryByText(/Jev/)).toBeNull();
    expect(screen.getByRole("radio", { name: "Ingredient" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Cuisine" })).toBeTruthy();
    expect(screen.getByText("garlic · Avoid this ingredient")).toBeTruthy();
    expect(screen.getByText("Thai · Avoid this cuisine")).toBeTruthy();
  });
});

describe("the falling food lanes", () => {
  it("uses three lanes below 420 px so neighbouring discs never overlap", () => {
    expect(laneCount(320)).toBe(3);
    expect(laneCount(390)).toBe(3);
    expect(laneCount(430)).toBe(4);
    // Three lane centres 54 px from each edge stay at least a disc (104 px) apart from 316 px up.
    expect((320 - 108) / 2).toBeGreaterThanOrEqual(104);
  });

  it("never picks a fourth lane when three are in use", () => {
    for (let issued = 0; issued < 12; issued += 1) {
      for (const rand of [0, 0.3, 0.6, 0.99]) {
        const lane = pickLane({ issued, laneUsedAt: [-3, -3, -3, -3], lastLane: -2 }, rand, 3);
        expect(lane).not.toBe(3);
      }
    }
  });
});

describe("the reward card", () => {
  it("writes meal times in 12-hour form", () => {
    const day = { kcal: 2000, protein: 150, carbs: 200, fat: 70 };
    render(<RewardPlateCard targets={{ training: day, rest: day }} lovedFoods={[]} showNumbers={false} onToggleNumbers={vi.fn()}
      meals={[{ label: "Meal 1", time: "08:00", name: "Oats", kcal: 400 },
        { label: "Meal 3", time: "18:30", name: "Rice bowl", kcal: 600 }] as never} />);
    expect(screen.getByText("Meal 1 · 8:00 AM")).toBeTruthy();
    expect(screen.getByText("Meal 3 · 6:30 PM")).toBeTruthy();
    expect(screen.queryByText(/18:30/)).toBeNull();
  });
});

describe("the legacy form's draft", () => {
  it("restores answers but never past Goal, where the safety round is asked again", async () => {
    const { readLegacyDraft } = await import("@/components/Onboarding/OnboardingFlow");
    const { accountKey } = await import("@/lib/device/account");
    const { createOnboardingState } = await import("@/lib/profile/onboarding-state");
    const { defaultSettings } = await import("@/lib/store");
    const handle = { userId: "u-draft", epoch: 1 };
    const fresh = createOnboardingState(defaultSettings());
    window.localStorage.setItem(accountKey(handle, "onboarding-legacy-draft"), JSON.stringify({
      savedAt: Date.now(), state: { ...fresh, step: 4, prefsText: "no mushrooms", body: { heightCm: "170" } },
    }));
    const draft = readLegacyDraft(handle, fresh)!;
    expect(draft.step).toBe(2);
    expect(draft.prefsText).toBe("no mushrooms");
    expect(draft.body.heightCm).toBe("170");
    // A body key the draft lacks keeps its fresh value instead of going missing.
    expect(draft.body.birthYear).toBe(fresh.body.birthYear);
    expect(readLegacyDraft({ userId: "someone-else", epoch: 1 }, fresh)).toBeNull();
  });
});
