// @vitest-environment jsdom
/**
 * Phase 18 W5b UI hand-off (docs/specs/phase-18-open-world-foods.md §W5b acceptance 2's last line:
 * "The UI then offers the rule editor or asks for plain likes and dislikes"). `classifyDietaryPreferences`
 * (lib/profile/prefs-client.ts) already answers `{ route: "local", offer }` for text the phone's local
 * safety check keeps; this is the UI side that reads `offer` and shows the hand-off.
 *
 * The local safety check (lib/profile/taste-safety.ts) runs for real here — no Jev/network mock is
 * needed for "local" text, since the local route never calls the server.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetTestAccount } from "@/tests/helpers/account";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("@/components/Onboarding/useStarterStep", () => ({
  useStarterStep: () => ({ choices: null, marks: {}, mark: vi.fn(), retry: vi.fn(), error: null }),
}));
vi.mock("@/components/Onboarding/useOnboardingFoodAccess", () => ({
  useOnboardingFoodAccess: () => ({ status: "pilot", retry: vi.fn(), revalidate: vi.fn(async () => "pilot") }),
}));
vi.mock("@/lib/profile/profile-pilot-client", () => ({ readProfilePilot: vi.fn(async () => false) }));

import OnboardingFlow from "@/components/Onboarding/OnboardingFlow";
import { defaultSettings } from "@/lib/store";
import type { Settings } from "@/lib/types";

function answeredProfile(): Settings {
  return { ...defaultSettings(), sex: "female", birthYear: 1996, heightCm: 165, weightKg: 60,
    activityLevel: "moderate", goal: "recomp" };
}

function textarea(): HTMLTextAreaElement {
  return screen.getByLabelText(/Anything you don.t eat/) as HTMLTextAreaElement;
}

/** The rule hand-off hint renders as an attention `Notice`; every `Button` also carries its own
 *  empty `role="status"` live region (components/ui/Button.tsx), so this scopes past those. */
function hint(): HTMLElement | null {
  return document.querySelector('[data-tone="attention"]');
}

async function openStep3(): Promise<void> {
  render(<OnboardingFlow initial={3} initialSettings={answeredProfile()} returnTo="/" />);
  await act(async () => {});
}

async function typeAndBlur(text: string): Promise<void> {
  await act(async () => {
    fireEvent.change(textarea(), { target: { value: text } });
    fireEvent.blur(textarea());
  });
}

beforeEach(async () => {
  await resetTestAccount();
});

afterEach(() => cleanup());

describe("the rule hand-off hint on the dietary preferences field", () => {
  it("offers the rule editor for a rule or allergy, without calling it a diagnosis", async () => {
    await openStep3();
    await typeAndBlur("I'm allergic to peanuts");
    await waitFor(() => expect(hint()?.textContent).toContain("food rule"));
    expect(hint()?.textContent?.toLowerCase()).not.toMatch(/diagnos/);
    expect(screen.getByRole("button", { name: "Add it as a rule" })).toBeTruthy();
  });

  it("offers the rule editor for a symptom, without calling it a diagnosis", async () => {
    await openStep3();
    await typeAndBlur("dairy gives me cramps");
    await waitFor(() => expect(hint()?.textContent).toContain("food rule"));
    expect(hint()?.textContent?.toLowerCase()).not.toMatch(/diagnos/);
  });

  it("jumps to the account's own rule editor already on this step, never away from onboarding", async () => {
    await openStep3();
    await typeAndBlur("I keep kosher");
    await waitFor(() => screen.getByRole("button", { name: "Add it as a rule" }));
    const search = screen.getByPlaceholderText(/halal, peanut allergy/) as HTMLInputElement;
    const scrollSpy = vi.fn();
    search.scrollIntoView = scrollSpy;
    fireEvent.click(screen.getByRole("button", { name: "Add it as a rule" }));
    expect(scrollSpy).toHaveBeenCalled();
    expect(document.activeElement).toBe(search);
    // Still on the same onboarding step: progress is not lost.
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Dietary preferences");
  });

  it("asks for plain likes and dislikes for unsure text, with no action to click", async () => {
    await openStep3();
    await typeAndBlur("a".repeat(250));
    await waitFor(() => expect(hint()?.textContent).toContain("plain likes and dislikes"));
    expect(screen.queryByRole("button", { name: "Add it as a rule" })).toBeNull();
  });

  it("hides the hint the moment the text changes", async () => {
    await openStep3();
    await typeAndBlur("I have celiac");
    await waitFor(() => expect(hint()).not.toBeNull());
    await act(async () => {
      fireEvent.change(textarea(), { target: { value: "I have celiac and" } });
    });
    expect(hint()).toBeNull();
  });

  it("shows no hint while the field is empty", async () => {
    await openStep3();
    expect(hint()).toBeNull();
  });
});
