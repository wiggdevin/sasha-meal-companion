// @vitest-environment jsdom
/**
 * Phase 18 W5 (D2): the optional cuisine screen in onboarding. It follows the food-rule review and
 * shows only while the profile pilot answers `enabled: true` — a closed or failed read keeps the
 * six-step flow exactly as it was, so nobody sees the question before W15 assigns a pilot arm. A
 * chosen list reaches the completed plan; an untouched screen adds nothing to it.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetTestAccount } from "@/tests/helpers/account";

const pilot = vi.hoisted(() => ({ readProfilePilot: vi.fn<() => Promise<boolean>>() }));
const persistence = vi.hoisted(() => ({
  persistCompletedOnboarding: vi.fn<(base: unknown, state: unknown) => Promise<{ settings: unknown; constraintsSaved: boolean }>>(),
}));

vi.mock("@/lib/profile/profile-pilot-client", () => ({ readProfilePilot: pilot.readProfilePilot }));
vi.mock("@/components/Onboarding/useStarterStep", () => ({
  useStarterStep: () => ({ choices: null, marks: {}, mark: vi.fn(), retry: vi.fn(), error: null }),
}));
vi.mock("@/components/Onboarding/useOnboardingFoodAccess", () => ({
  useOnboardingFoodAccess: () => ({ status: "pilot", retry: vi.fn(), revalidate: vi.fn(async () => "pilot") }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("@/lib/sync/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sync/client")>()),
  flushOutboxNow: vi.fn(async () => true),
}));
vi.mock("@/lib/profile/onboarding-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/profile/onboarding-client")>()),
  persistCompletedOnboarding: persistence.persistCompletedOnboarding,
  mirroredOnboardedAt: vi.fn(async () => "2026-10-06T12:00:00.000Z"),
}));

import OnboardingFlow from "@/components/Onboarding/OnboardingFlow";
import { defaultSettings } from "@/lib/store";
import type { Settings } from "@/lib/types";

function answeredProfile(extra: Partial<Settings> = {}): Settings {
  return { ...defaultSettings(), sex: "female", birthYear: 1996, heightCm: 165, weightKg: 60,
    activityLevel: "moderate", goal: "recomp", ...extra };
}

const heading = () => screen.getByRole("heading", { level: 1 }).textContent;
const stepLine = () => screen.getByText(/^Step \d+ of \d+$/).textContent;
async function click(label: string): Promise<void> {
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: label })); });
}

async function openReview(settings = answeredProfile()): Promise<void> {
  render(<OnboardingFlow initial={3} initialSettings={settings} returnTo="/" />);
  await act(async () => {});
  await waitFor(() => expect(pilot.readProfilePilot).toHaveBeenCalled());
}

beforeEach(async () => {
  await resetTestAccount();
  pilot.readProfilePilot.mockReset();
  persistence.persistCompletedOnboarding.mockReset();
  persistence.persistCompletedOnboarding.mockImplementation(async (base) => ({ settings: base, constraintsSaved: true }));
});

afterEach(() => cleanup());

describe("the onboarding cuisine screen", () => {
  it("is not shown while the pilot is off: the rule review leads straight to Foods", async () => {
    pilot.readProfilePilot.mockResolvedValue(false);
    await openReview();
    expect(stepLine()).toBe("Step 4 of 6");
    await click("Next");
    expect(heading()).toBe("Foods");
    expect(stepLine()).toBe("Step 5 of 6");
    expect(screen.queryByRole("group", { name: "Cuisines you like" })).toBeNull();
  });

  it("sits between the rule review and Foods when the pilot is on, both ways", async () => {
    pilot.readProfilePilot.mockResolvedValue(true);
    await openReview();
    await waitFor(() => expect(stepLine()).toBe("Step 4 of 7"));
    await click("Next");
    expect(heading()).toBe("Cuisines");
    expect(stepLine()).toBe("Step 5 of 7");
    await click("Japanese");
    await click("Back");
    expect(heading()).toBe("Dietary preferences");
    await click("Next");
    expect(screen.getByRole("button", { name: "Japanese" }).getAttribute("aria-pressed")).toBe("true");
    await click("Next");
    expect(heading()).toBe("Foods");
    expect(stepLine()).toBe("Step 6 of 7");
    await click("Back");
    expect(heading()).toBe("Cuisines");
  });

  it("saves the chosen cuisines with the plan, in vocabulary order", async () => {
    pilot.readProfilePilot.mockResolvedValue(true);
    await openReview();
    await waitFor(() => expect(stepLine()).toBe("Step 4 of 7"));
    await click("Next");
    await click("Korean");
    await click("Italian");
    await click("Next");
    await click("Next");
    await click("Use this plan");
    await waitFor(() => expect(persistence.persistCompletedOnboarding).toHaveBeenCalledOnce());
    const [base] = persistence.persistCompletedOnboarding.mock.calls[0] as [Settings, unknown];
    expect(base.cuisines).toEqual(["italian", "korean"]);
  });

  it("adds nothing to the plan when the screen is left untouched", async () => {
    pilot.readProfilePilot.mockResolvedValue(true);
    await openReview(answeredProfile());
    await waitFor(() => expect(stepLine()).toBe("Step 4 of 7"));
    await click("Next");
    await click("Next");
    await click("Next");
    await click("Use this plan");
    await waitFor(() => expect(persistence.persistCompletedOnboarding).toHaveBeenCalledOnce());
    const [base] = persistence.persistCompletedOnboarding.mock.calls[0] as [Settings, unknown];
    expect(Object.prototype.hasOwnProperty.call(base, "cuisines")).toBe(false);
  });
});
