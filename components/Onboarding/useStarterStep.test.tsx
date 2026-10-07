// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { createOnboardingState } from "@/lib/profile/onboarding-state";
import { defaultSettings } from "@/lib/store";
import { useStarterStep } from "./useStarterStep";

const reads = vi.hoisted(() => ({ constraints: vi.fn(), review: vi.fn(), instances: vi.fn() }));
vi.mock("@/lib/constraints-client", () => ({ loadConstraints: reads.constraints }));
vi.mock("@/lib/rule-review-client", () => ({ loadRuleReview: reads.review }));
vi.mock("@/lib/profile/instances-client", () => ({ fetchProfileInstances: reads.instances }));

afterEach(() => unbindAccount());

describe("starter step state", () => {
  it("does not enumerate starter foods while the pilot flag is pending or enabled", async () => {
    bindAccount("11111111-1111-4111-8111-111111111111");
    reads.constraints.mockClear();
    reads.review.mockClear();
    reads.instances.mockClear();
    const state = createOnboardingState(defaultSettings(), 4);
    const { result } = renderHook(() => useStarterStep(state, false));
    expect(result.current.choices).toBeNull();
    expect(result.current.marks).toEqual({});
    expect(reads.constraints).not.toHaveBeenCalled();
    expect(reads.review).not.toHaveBeenCalled();
    expect(reads.instances).not.toHaveBeenCalled();
  });

  it("retains reviewed Eat and Avoid marks when advancing to the plan and returning", async () => {
    bindAccount("11111111-1111-4111-8111-111111111111");
    reads.constraints.mockResolvedValue({ profile: { avoid_allergens: [],
      avoid_food_ref_ids: [], banned_categories: [], conditions: [], notes: null }, rev: 0 });
    reads.review.mockResolvedValue({ required: false, candidateAllergens: [],
      candidateCategories: [], rev: 0 });
    reads.instances.mockResolvedValue({ instances: [], catalog: [], legacyProfileIds: [] });
    reads.constraints.mockClear();
    const initial = createOnboardingState(defaultSettings(), 4);
    const { result, rerender } = renderHook(({ step }) => useStarterStep({ ...initial, step }),
      { initialProps: { step: 4 } });
    await waitFor(() => expect(result.current.choices?.length).toBeGreaterThan(0));
    act(() => result.current.mark("tofu-firm", "avoid"));
    rerender({ step: 5 });
    expect(result.current.marks["tofu-firm"]).toBe("avoid");
    rerender({ step: 4 });
    expect(result.current.marks["tofu-firm"]).toBe("avoid");
    expect(reads.constraints).toHaveBeenCalledTimes(1);
  });

  // ONB2-RULE-REREAD (Sol r6 BLOCK on onb2-l4-r2): a rule saved mid-flow (e.g. through the inline
  // rule editor) writes constraints directly and never touches `flags`/`text`, so the hook's own
  // memoized effect would not otherwise notice it. `reread()` must catch this right before the
  // final "I'm done" write, so the just-excluded food can never be persisted as "eats".
  it("reread() drops an eats mark a rule saved mid-flow has just excluded", async () => {
    bindAccount("11111111-1111-4111-8111-111111111111");
    const openProfile = { avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [],
      conditions: [], notes: null };
    reads.constraints.mockResolvedValue({ profile: openProfile, rev: 0 });
    reads.review.mockResolvedValue({ required: false, candidateAllergens: [],
      candidateCategories: [], rev: 0 });
    reads.instances.mockResolvedValue({ instances: [], catalog: [], legacyProfileIds: [] });
    const initial = createOnboardingState(defaultSettings(), 4);
    const { result } = renderHook(() => useStarterStep(initial));
    await waitFor(() => expect(result.current.choices?.some((item) => item.id === "tofu-firm")).toBe(true));
    act(() => result.current.mark("tofu-firm", "eats"));
    expect(result.current.marks["tofu-firm"]).toBe("eats");

    // The user jumps to the rule editor mid-flow and saves a soy allergen rule — this never
    // touches onboarding `flags`/`text`, so only a forced reread can see it.
    reads.constraints.mockResolvedValue({
      profile: { ...openProfile, avoid_allergens: ["soy"] }, rev: 1,
    });

    let fresh: Awaited<ReturnType<typeof result.current.reread>>;
    await act(async () => { fresh = await result.current.reread(); });
    expect(fresh!.some((item) => item.id === "tofu-firm")).toBe(false);
    expect(result.current.choices?.some((item) => item.id === "tofu-firm")).toBe(false);
    // The confirm path must never see the newly-excluded food still marked "eats".
    expect(result.current.marks["tofu-firm"]).not.toBe("eats");
  });
});
