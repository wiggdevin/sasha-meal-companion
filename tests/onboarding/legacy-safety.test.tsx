// @vitest-environment jsdom
/**
 * Audit 2026-10-10 F13 (W009): the legacy profile form — the default /onboarding while the chat
 * flag is off, Settings › Edit profile, the Today invite, and the v2 crash fallback.
 *
 * - A093: an under-18 birth year crashed the page (the preview threw `AdultOnlyError` in render).
 *   It now meets the friendly stop, and the stop's "I typed my age wrong" goes back to the body.
 * - A092: in the calendar year the birth year turns 18 the form asks for the full date of birth,
 *   so a 17-year-old whose birthday is still ahead is stopped instead of planned for.
 * - A087: the form asks the safety round before the goal; a "Pregnant" tap is written as a
 *   condition before the target, and no pace is asked.
 * - A088: the preview and save read the stored holds; until the round and the stored read are
 *   both known, the plan holds the pace at 0 and says why.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetTestAccount } from "@/tests/helpers/account";
import type { TargetEligibility } from "@/lib/profile/rate-eligibility";

const navigation = vi.hoisted(() => ({ replace: vi.fn() }));
const persistence = vi.hoisted(() => ({
  persistCompletedOnboarding: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  persistSkippedOnboarding: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));
const storedRead = vi.hoisted(() => ({
  value: { status: "ready", eligibility: { holds: [], minor: false } } as {
    status: "loading" | "ready" | "failed"; eligibility: TargetEligibility | null },
  refresh: vi.fn(async () => null),
}));
const STARTER_CHOICES = vi.hoisted(() => [
  { id: "p1", role: "protein" }, { id: "p2", role: "protein" }, { id: "p3", role: "protein" },
  { id: "p4", role: "protein" }, { id: "p5", role: "protein" }, { id: "p6", role: "protein" },
  { id: "c1", role: "carb" }, { id: "c2", role: "carb" }, { id: "f1", role: "fat" }, { id: "f2", role: "fat" },
]);

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: navigation.replace }) }));
vi.mock("@/components/Onboarding/useStarterStep", () => ({
  useStarterStep: () => ({ choices: STARTER_CHOICES,
    marks: Object.fromEntries(STARTER_CHOICES.map((choice) => [choice.id, "eats"])),
    mark: vi.fn(), retry: vi.fn(), reread: vi.fn(async () => STARTER_CHOICES), error: null }),
}));
vi.mock("@/components/Onboarding/useOnboardingFoodAccess", () => ({
  useOnboardingFoodAccess: () => ({ status: "pilot", retry: vi.fn(), revalidate: vi.fn(async () => "pilot") }),
}));
vi.mock("@/components/Onboarding/DietaryProfilePicker", () => ({ default: () => null }));
vi.mock("@/components/Onboarding/v2/stored-eligibility", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/Onboarding/v2/stored-eligibility")>()),
  useStoredEligibility: () => ({ ...storedRead.value, refresh: storedRead.refresh }),
}));
vi.mock("@/lib/sync/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sync/client")>()),
  flushOutboxNow: vi.fn(async () => true),
}));
vi.mock("@/lib/profile/onboarding-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/profile/onboarding-client")>()),
  persistCompletedOnboarding: persistence.persistCompletedOnboarding,
  persistSkippedOnboarding: persistence.persistSkippedOnboarding,
  mirroredOnboardedAt: vi.fn(async () => "2026-10-10T12:00:00.000Z"),
}));

import OnboardingFlow, { isBodyStepComplete } from "@/components/Onboarding/OnboardingFlow";
import { PlanStep } from "@/components/Onboarding/OnboardingSteps";
import { legacyEligibility } from "@/components/Onboarding/legacy-eligibility";
import {
  buildCompletedSettings, createOnboardingState, onboardingReducer,
} from "@/lib/profile/onboarding-state";
import { defaultSettings } from "@/lib/store";
import type { Settings } from "@/lib/types";

const TODAY = new Date(2026, 9, 10, 12, 0);

function profile(overrides: Partial<Settings> = {}): Settings {
  return { ...defaultSettings(), sex: "female", birthYear: 1996, heightCm: 165, weightKg: 70,
    activityLevel: "moderate", goal: "lose_fat", goalRateBpWeek: -50, ...overrides };
}

function click(name: string): void {
  fireEvent.click(screen.getByRole("button", { name }));
}

/** Next, then wait for the step to change (step 3's Next awaits the preference read first). */
async function next(): Promise<void> {
  const before = screen.getByRole("heading", { level: 1 }).textContent;
  click("Next");
  await waitFor(() => expect(screen.getByRole("heading", { level: 1 }).textContent).not.toBe(before));
}

function nextDisabled(): boolean {
  return (screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(TODAY);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
  await resetTestAccount();
  navigation.replace.mockReset();
  persistence.persistCompletedOnboarding.mockReset();
  persistence.persistCompletedOnboarding.mockImplementation(async (base) =>
    ({ settings: base, constraintsSaved: true }));
  persistence.persistSkippedOnboarding.mockReset();
  persistence.persistSkippedOnboarding.mockImplementation(async (base) => base);
  storedRead.value = { status: "ready", eligibility: { holds: [], minor: false } };
  storedRead.refresh.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("A093: an under-18 birth year meets the friendly stop, never a crash", () => {
  it("renders the stop for a complete under-18 profile opened on the plan", () => {
    render(<OnboardingFlow initial={5} initialSettings={profile({ birthYear: 2012 })} />);
    expect(screen.getByTestId("minor-stop").textContent).toContain("adults 18 and over");
    expect(screen.queryByRole("button", { name: "Use this plan" })).toBeNull();
  });

  it("stops after the body step, and 'I typed my age wrong' goes back to it", () => {
    render(<OnboardingFlow initial={0} initialSettings={profile({ birthYear: 2012 })} />);
    click("Next");
    expect(screen.getByTestId("minor-stop")).toBeTruthy();
    click("I typed my age wrong");
    expect(screen.queryByTestId("minor-stop")).toBeNull();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Body");
  });

  it("'Look around' on the first-run route is the skip: no plan is built", async () => {
    render(<OnboardingFlow initial={5} initialSettings={profile({ birthYear: 2012 })} />);
    click("Look around");
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/"));
    expect(persistence.persistSkippedOnboarding).toHaveBeenCalledOnce();
    expect(persistence.persistCompletedOnboarding).not.toHaveBeenCalled();
  });

  it("a stored minor profile also stops the plan", () => {
    storedRead.value = { status: "ready", eligibility: { holds: [], minor: true } };
    render(<OnboardingFlow initial={5} initialSettings={profile()} />);
    expect(screen.getByTestId("minor-stop")).toBeTruthy();
  });

  it("the server's 422 adult_only on save shows the stop instead of a generic failure", async () => {
    const { TargetSaveRefusedError } = await import("@/lib/targets/client");
    persistence.persistCompletedOnboarding.mockRejectedValueOnce(new TargetSaveRefusedError(422, "adult_only"));
    render(<OnboardingFlow initial={5} initialSettings={profile({ goal: "maintain", goalRateBpWeek: 0 })} />);
    click("Use this plan");
    await waitFor(() => expect(screen.getByTestId("minor-stop")).toBeTruthy());
    expect(navigation.replace).not.toHaveBeenCalled();
  });
});

describe("A092: the year the birth year turns 18 asks for the full date of birth", () => {
  it("keeps Next off until the date is given, then stops a 17-year-old", () => {
    render(<OnboardingFlow initial={0} initialSettings={profile({ birthYear: 2008 })} />);
    expect(nextDisabled()).toBe(true);
    fireEvent.change(screen.getByLabelText("Date of birth"), { target: { value: "2008-12-01" } });
    expect(nextDisabled()).toBe(false);
    click("Next");
    expect(screen.getByTestId("minor-stop")).toBeTruthy();
  });

  it("lets an 18-year-old whose birthday has passed go on", () => {
    render(<OnboardingFlow initial={0} initialSettings={profile({ birthYear: 2008 })} />);
    fireEvent.change(screen.getByLabelText("Date of birth"), { target: { value: "2008-03-01" } });
    click("Next");
    expect(screen.queryByTestId("minor-stop")).toBeNull();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Activity");
  });

  it("asks nothing for any other birth year, and drops a date when the year changes", () => {
    let state = createOnboardingState(profile({ birthYear: 1996 }));
    expect(isBodyStepComplete(state, "2026-10-10")).toBe(true);
    state = onboardingReducer(state, { type: "edit_body", key: "birthYear", value: "2008" });
    expect(isBodyStepComplete(state, "2026-10-10")).toBe(false);
    state = onboardingReducer(state, { type: "set_birth_date", value: "2008-03-01" });
    expect(isBodyStepComplete(state, "2026-10-10")).toBe(true);
    state = onboardingReducer(state, { type: "edit_body", key: "birthYear", value: "2007" });
    expect(state.birthDate).toBeNull();
  });
});

describe("A087: the legacy form asks the safety round before the goal", () => {
  it("asks the round first, keeps Next off until it is answered, and asks no pace when held", () => {
    render(<OnboardingFlow initial={2} initialSettings={profile()} />);
    expect(screen.getByTestId("safety-round")).toBeTruthy();
    expect(nextDisabled()).toBe(true);
    click("Pregnant or breastfeeding");
    fireEvent.click(screen.getByRole("radio", { name: "Pregnant" }));
    click("Continue");
    expect(screen.queryByTestId("safety-round")).toBeNull();
    expect(screen.queryByLabelText("Goal rate")).toBeNull();
    expect(screen.getByText(/no pace to set/).getAttribute("role")).toBe("status");
    expect(nextDisabled()).toBe(false);
  });

  it("asks the pace as before after 'No, none of these'", () => {
    render(<OnboardingFlow initial={2} initialSettings={profile()} />);
    click("No, none of these");
    expect(screen.getByLabelText("Goal rate")).toBeTruthy();
  });

  it("saves the round's taps (written as conditions before the target) with the held plan", async () => {
    render(<OnboardingFlow initial={2} initialSettings={profile()} />);
    click("Pregnant or breastfeeding");
    fireEvent.click(screen.getByRole("radio", { name: "Pregnant" }));
    click("Continue");
    await next();
    await next();
    await next();
    click("Use this plan");
    await waitFor(() => expect(persistence.persistCompletedOnboarding).toHaveBeenCalledOnce());
    const args = persistence.persistCompletedOnboarding.mock.calls[0];
    expect(args[4]).toEqual({ pregnancy: "pregnant", clinicianDiet: false, conditionText: null });
    expect(args[6]).toEqual({ holds: ["pregnancy"], minor: false });
  });
});

describe("A088: the preview reads the stored holds, and holds the pace until it knows", () => {
  const none = { picks: [], pregnancy: null, medicines: [], conditionText: "" };

  it("holds the pace with a stand-in until the round is answered or the stored read answers", () => {
    const ready = { status: "ready" as const, eligibility: { holds: [], minor: false } };
    expect(legacyEligibility(null, ready)).toMatchObject({ check: "unanswered",
      eligibility: { holds: ["clinician_diet"] }, known: { holds: [] } });
    expect(legacyEligibility(none, { status: "failed", eligibility: null }))
      .toMatchObject({ check: "unread", eligibility: { holds: ["clinician_diet"] } });
    expect(legacyEligibility(none, ready)).toEqual({ check: "answered",
      eligibility: { holds: [], minor: false }, known: { holds: [], minor: false } });
    expect(legacyEligibility(none, { status: "ready", eligibility: { holds: ["kidney"], minor: false } }))
      .toMatchObject({ check: "answered", eligibility: { holds: ["kidney"] } });
  });

  it("previews a stored kidney hold at maintenance with standard protein, as the server saves", () => {
    const state = createOnboardingState(profile());
    const base = profile();
    const kidney = { holds: ["kidney" as const], minor: false };
    render(<PlanStep state={state} base={base} dispatch={() => {}} eligibility={kidney} />);
    const held = buildCompletedSettings(base, state, new Date(), kidney).activeTargetProfile!;
    const free = buildCompletedSettings(base, state, new Date()).activeTargetProfile!;
    expect(held.training.protein).toBeLessThan(free.training.protein);
    expect(held.rest.kcal).toBeGreaterThan(free.rest.kcal);
    expect(screen.getAllByText(`${held.rest.kcal.toLocaleString()} kcal`).length).toBeGreaterThan(0);
    expect(screen.getAllByText(new RegExp(`^${held.training.protein} g protein`)).length).toBeGreaterThan(0);
  });

  it("opened past the round, the plan holds the pace at 0, says why, and offers the round", () => {
    render(<OnboardingFlow initial={5} initialSettings={profile()} />);
    expect(screen.getByText(/Answer the health questions to set a pace/)).toBeTruthy();
    click("Answer them");
    expect(screen.getByTestId("safety-round")).toBeTruthy();
  });

  it("a failed stored read holds the pace and offers a retry", async () => {
    storedRead.value = { status: "failed", eligibility: null };
    render(<OnboardingFlow initial={2} initialSettings={profile()} />);
    click("No, none of these");
    await next();
    await next();
    await next();
    expect(screen.getByText(/Couldn’t check your saved health answers/)).toBeTruthy();
    click("Retry");
    expect(storedRead.refresh).toHaveBeenCalled();
  });
});
