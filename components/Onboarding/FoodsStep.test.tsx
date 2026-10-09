// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FoodsStep, { FallingFoodsStep } from "./FoodsStep";
import { PILE_TIMING } from "./FallingFoodPile";
import { starterChoices } from "@/lib/foods/starter";
import { resetTestAccount } from "@/tests/helpers/account";
import { defaultSettings } from "@/lib/store";
import type { Settings } from "@/lib/types";

/* The onboarding write's boundaries, stubbed so its feedback can be read (FluidVoice F01-F09). */
const flow = vi.hoisted(() => ({
  replace: vi.fn(),
  persist: vi.fn<() => Promise<{ settings: unknown; constraintsSaved: boolean }>>(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: flow.replace }) }));
vi.mock("@/components/Onboarding/useOnboardingFoodAccess", () => ({
  useOnboardingFoodAccess: () => ({ status: "pilot", retry: vi.fn(), revalidate: async () => "pilot" }),
}));
vi.mock("@/components/Onboarding/useStarterStep", () => ({
  useStarterStep: () => ({ choices: [], marks: {}, mark: vi.fn(), retry: vi.fn(), error: null }),
}));
vi.mock("@/lib/sync/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sync/client")>()),
  flushOutboxNow: async () => true,
}));
vi.mock("@/lib/profile/onboarding-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/profile/onboarding-client")>()),
  persistCompletedOnboarding: flow.persist,
  mirroredOnboardedAt: async () => "2026-09-20T12:00:00.000Z",
}));

const { default: OnboardingFlow } = await import("./OnboardingFlow");
const vibrate = vi.fn(() => true);

afterEach(cleanup);
const profile = { avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [], conditions: [], notes: null };

/** `FallingFoodsStep` now renders its own `FoodsSafetyGate` (the allergy card always renders
 *  before any food UI — GPT-6 Sol r3/r4 BLOCK), so every test below has to clear that gate
 *  ("No, nothing") before the game/food UI it actually wants to exercise ever appears. */
function confirmNoAllergy(): void {
  fireEvent.click(screen.getByRole("button", { name: "No, nothing" }));
}

describe("onboarding Foods step — default export stays the classic grid while the flag is off", () => {
  it("shows reviewed starters by role, accepts search, and makes Eat/Avoid explicit", () => {
    const onMark = vi.fn();
    render(<FoodsStep choices={starterChoices([], profile)}
      marks={{ "chicken-breast-roasted": "eats", "apple-with-skin": "avoid" }}
      onMark={onMark} />);
    expect(screen.getByRole("button", { name: /I eat Chicken breast, roasted/i })
      .getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /Avoid Apple/i })
      .getAttribute("aria-pressed")).toBe("true");
    fireEvent.change(screen.getByRole("searchbox", { name: "Find a starter food" }),
      { target: { value: "tofu" } });
    fireEvent.click(screen.getByRole("button", { name: /I eat Tofu/i }));
    expect(onMark).toHaveBeenCalledWith("tofu-firm", "eats");
  });

  it("keeps a named avoid visible but cannot select it to Eat when allergy excludes it", () => {
    render(<FoodsStep choices={starterChoices([], { ...profile, avoid_allergens: ["dairy"] })}
      marks={{ "whey-protein-powder": "avoid" }} onMark={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Avoid Whey protein/i })
      .getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByRole("button", { name: /I eat Whey protein/i }) as HTMLButtonElement).disabled)
      .toBe(true);
  });
});

describe("the re-skinned falling-foods step (NEXT_PUBLIC_CHAT_ONBOARDING=1 path)", () => {
  it("shows the love round, toggles a love, and moves to the explicit avoid round", () => {
    vi.useFakeTimers();
    try {
      const onMark = vi.fn();
      render(<FallingFoodsStep choices={starterChoices([], profile)} marks={{}} onMark={onMark} />);
      confirmNoAllergy();
      expect(screen.getByText("Tap the ones you love most.")).toBeTruthy();
      // The first disc's spawn is deferred one tick (GPT-6 Sol r4 WARN fix — see
      // FallingFoodPile.tsx's own doc on why a synchronous first spawn breaks under Strict Mode).
      act(() => { vi.advanceTimersByTime(PILE_TIMING.settleMs); });
      fireEvent.click(screen.getByRole("button", { name: /Love Chicken breast, roasted/i }));
      expect(onMark).toHaveBeenCalledWith("chicken-breast-roasted", "eats");
      fireEvent.click(screen.getByRole("button", { name: "Next: anything you never eat?" }));
      expect(screen.getByText("Anything you never eat?")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: /Never eat Chicken breast, roasted/i }));
      expect(onMark).toHaveBeenCalledWith("chicken-breast-roasted", "avoid");
    } finally {
      vi.useRealTimers();
    }
  });

  it("'Sprout, pick for me' marks two defaults per role as loved, never touching an avoid", () => {
    const onMark = vi.fn();
    render(<FallingFoodsStep choices={starterChoices([], profile)} marks={{ "olive-oil": "avoid" }}
      onMark={onMark} />);
    confirmNoAllergy();
    fireEvent.click(screen.getByRole("button", { name: "Sprout, pick for me" }));
    expect(onMark).toHaveBeenCalledWith("chicken-breast-roasted", "eats");
    expect(onMark).not.toHaveBeenCalledWith("olive-oil", expect.anything());
  });

  it("a confirmed allergy removes matching discs entirely — they are absent, not merely disabled",
    () => {
      vi.useFakeTimers();
      try {
        render(<FallingFoodsStep choices={starterChoices([], { ...profile, avoid_allergens: ["dairy"] })}
          marks={{}} onMark={vi.fn()} />);
        confirmNoAllergy();
        act(() => { vi.advanceTimersByTime(PILE_TIMING.settleMs); });
        expect(screen.queryByRole("button", { name: /Whey protein/i })).toBeNull();
        expect(screen.queryByRole("button", { name: /Greek yogurt/i })).toBeNull();
        // A non-dairy starter is untouched.
        expect(screen.getByRole("button", { name: /Love Chicken breast, roasted/i })).toBeTruthy();
      } finally {
        vi.useRealTimers();
      }
    });

  it("a love recorded in the love round is still marked once the avoid round renders it", () => {
    const onMark = vi.fn();
    render(<FallingFoodsStep choices={starterChoices([], profile)}
      marks={{ "chicken-breast-roasted": "eats" }} onMark={onMark} />);
    confirmNoAllergy();
    fireEvent.click(screen.getByRole("button", { name: "Next: anything you never eat?" }));
    // The avoid round is a stable per-role grid (not the falling game): the earlier love is
    // still reflected, and the avoid tap reports the opposite mark.
    const chicken = screen.getByRole("button", { name: /Never eat Chicken breast, roasted/i });
    fireEvent.click(chicken);
    expect(onMark).toHaveBeenCalledWith("chicken-breast-roasted", "avoid");
  });

  it("spawns at most 5 concurrent discs, holding further spawns for a free slot", () => {
    vi.useFakeTimers();
    try {
      const choices = starterChoices([], profile);
      render(<FallingFoodsStep choices={choices} marks={{}} onMark={vi.fn()} />);
      confirmNoAllergy();
      act(() => { vi.advanceTimersByTime(PILE_TIMING.settleMs); });
      const pile = screen.getByTestId("food-pile");
      expect(pile.querySelectorAll("button").length).toBeGreaterThan(0);
      // Advance well past several spawn intervals: concurrency never exceeds 3, because nothing
      // here ever resolves (no tap, no animation-complete in this fake-timer environment) — the
      // scheduler must be holding every further spawn for a slot that never frees.
      act(() => { vi.advanceTimersByTime(PILE_TIMING.settleMs + 15000); });
      expect(pile.querySelectorAll("button").length).toBeLessThanOrEqual(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a tap marks the disc loved (AnimatePresence then pops it out over its own 220ms exit)", () => {
    vi.useFakeTimers();
    try {
      const onMark = vi.fn();
      const choices = starterChoices([], profile);
      render(<FallingFoodsStep choices={choices} marks={{}} onMark={onMark} />);
      confirmNoAllergy();
      act(() => { vi.advanceTimersByTime(PILE_TIMING.settleMs); });
      const pile = screen.getByTestId("food-pile");
      const firstDisc = pile.querySelector("button")!;
      fireEvent.click(firstDisc);
      expect(onMark).toHaveBeenCalledWith(expect.stringMatching(/.+/), "eats");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a loved tap adds a chip to the tray", () => {
    render(<FallingFoodsStep choices={starterChoices([], profile)}
      marks={{ "chicken-breast-roasted": "eats" }} onMark={vi.fn()} />);
    confirmNoAllergy();
    const tray = screen.getByTestId("food-tray");
    expect(tray.textContent).toContain("Chicken");
  });
});

describe("onboarding write feedback", () => {
  const answered: Settings = { ...defaultSettings(), sex: "female", birthYear: 1996, heightCm: 165,
    weightKg: 60, activityLevel: "moderate", goal: "recomp" };

  beforeEach(async () => {
    await resetTestAccount();
    flow.replace.mockReset();
    flow.persist.mockReset();
    flow.persist.mockResolvedValue({ settings: answered, constraintsSaved: true });
    vibrate.mockClear();
    Object.defineProperty(window.navigator, "vibrate", { configurable: true, value: vibrate });
  });

  it("confirms a saved plan with the shared haptic before leaving", async () => {
    render(<OnboardingFlow initial={5} initialSettings={answered} returnTo="/" />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Use this plan" })); });
    await waitFor(() => expect(flow.replace).toHaveBeenCalledWith("/"));
    expect(vibrate).toHaveBeenCalledTimes(1);
  });

  it("shows a failed save as the shared alert, stays put, and plays no haptic", async () => {
    flow.persist.mockRejectedValue(new Error("offline"));
    render(<OnboardingFlow initial={5} initialSettings={answered} returnTo="/" />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Use this plan" })); });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn’t save your plan. Try again.");
    expect(alert.querySelector('button[aria-label="Dismiss notification"]')).toBeTruthy();
    expect(flow.replace).not.toHaveBeenCalled();
    expect(vibrate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Use this plan" })).toBeTruthy();
  });
});
