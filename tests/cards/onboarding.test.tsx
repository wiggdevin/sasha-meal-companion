/**
 * Design §8.3 — the render spec for the onboarding steps: Body, Activity, Goal, Preferences idle
 * and classifying, the Plan step with a profile that is still incomplete, and the Plan step once
 * it is complete.
 *
 * Static renders from `createOnboardingState`, so every state here is the one a real account
 * reaches by answering (or not answering) the steps before it.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityStep, BodyStep, GoalStep, PlanStep, PreferencesStep }
  from "@/components/Onboarding/OnboardingSteps";
import {
  createOnboardingState, missingProfileFields, onboardingReducer,
  type OnboardingAction, type OnboardingState,
} from "@/lib/profile/onboarding-state";
import { defaultSettings } from "@/lib/store";

const BASE = defaultSettings();

function stateAfter(...actions: OnboardingAction[]): OnboardingState {
  return actions.reduce(onboardingReducer, createOnboardingState(BASE));
}

/** Every answer the Plan step needs before it can draw a number. */
const COMPLETE = stateAfter(
  { type: "set_sex", value: "female" },
  { type: "edit_body", key: "birthYear", value: "1994" },
  { type: "edit_body", key: "heightCm", value: "168" },
  { type: "edit_weight", value: "62" },
  { type: "set_activity", value: "moderate" },
  { type: "set_goal", value: "recomp" },
);

const step = (node: React.ReactElement) => renderToStaticMarkup(node);

describe("the Body step", () => {
  it("asks for the four fields and says what they are for", () => {
    const markup = step(<BodyStep state={createOnboardingState(BASE)} dispatch={() => {}} />);
    expect(markup).toContain("Used to calculate your starting plan.");
    expect(markup).toContain('aria-label="Height"');
    expect(markup).toContain('aria-label="Birth year"');
    expect(markup).not.toContain("Stored in kilograms.");
  });

  it("shows the age only once the birth year is plausible", () => {
    expect(step(<BodyStep state={createOnboardingState(BASE)} dispatch={() => {}} />))
      .not.toContain("Age today:");
    expect(step(<BodyStep state={COMPLETE} dispatch={() => {}} />)).toContain("Age today:");
  });
});

describe("the Activity step", () => {
  it("offers all five levels and no weekday preselected", () => {
    const markup = step(<ActivityStep state={createOnboardingState(BASE)} dispatch={() => {}} />);
    for (const level of ["Sedentary", "Light", "Moderate", "Active", "Very active"]) {
      expect(markup).toContain(level);
    }
    expect(markup).toContain("Training days");
    expect(markup).not.toContain('aria-pressed="true"');
  });

  it("marks the chosen level and the chosen days, and nothing else", () => {
    const markup = step(<ActivityStep state={COMPLETE} dispatch={() => {}} />);
    expect(markup).toContain('aria-pressed="true"');
  });

  it("draws the chosen level as a chosen option card the legacy well cannot override", () => {
    // 2026-10-04: the rows carried `well`, an unlayered recipe whose beige beat the chosen wash, so
    // "Moderate" was pressed and looked like every other row.
    const markup = step(<ActivityStep state={COMPLETE} dispatch={() => {}} />);
    const chosen = /<button[^>]*aria-pressed="true"[^>]*class="([^"]*)"[^>]*><span[^>]*>Moderate</.exec(markup)?.[1] ?? "";
    expect(chosen.split(/\s+/)).toEqual(expect.arrayContaining(["bg-selected-soft", "rounded-[16px]"]));
    expect(chosen.split(/\s+/)).not.toContain("well");
    const rest = /<button[^>]*aria-pressed="false"[^>]*class="([^"]*)"[^>]*><span[^>]*>Sedentary</.exec(markup)?.[1] ?? "";
    expect(rest.split(/\s+/)).toEqual(expect.arrayContaining(["bg-fog"]));
  });
});

describe("the Goal step", () => {
  it("offers all four goals with none chosen for a new account", () => {
    const markup = step(<GoalStep state={createOnboardingState(BASE)} dispatch={() => {}} />);
    for (const goal of ["Lose fat", "Recomp", "Maintain", "Gain muscle"]) {
      expect(markup).toContain(goal);
    }
    expect(markup).not.toContain('aria-pressed="true"');
  });
});

describe("the Preferences step", () => {
  const prefs = (classifying: boolean) => step(
    <PreferencesStep state={createOnboardingState(BASE)} dispatch={() => {}}
      onBlur={() => {}} classifying={classifying} />);

  it("says what confirming a preference does, and confirms nothing on its own", () => {
    const markup = prefs(false);
    expect(markup).toContain("Confirm anything that applies.");
    expect(markup).toContain("Vegetarian");
    expect(markup).not.toContain('aria-pressed="true"');
  });

  it("is classifying: it says it is reading the text while the classifier runs", () => {
    expect(prefs(true)).toContain("Reading your preferences…");
    expect(prefs(true)).not.toContain("Confirm anything that applies.");
    // The live status is never inside a paragraph (audit b4b #11).
    expect(prefs(true)).not.toMatch(/<p[^>]*>(?:(?!<\/p>)[\s\S])*data-thinking/);
  });
});

describe("the Plan step", () => {
  const plan = (state: OnboardingState) =>
    step(<PlanStep state={state} base={BASE} dispatch={() => {}} />);

  it("draws the plan incomplete card: it names the fields still missing, not a plan out of nothing", () => {
    const empty = createOnboardingState(BASE);
    expect(missingProfileFields(empty).length).toBeGreaterThan(0);
    const markup = plan(empty);
    expect(markup).toContain("Your profile needs");
    expect(markup).toContain("Go back to fill them in, or skip for now.");
    expect(markup).not.toContain("Training day");
  });

  it("does not throw on a half-answered profile", () => {
    const half = stateAfter({ type: "set_sex", value: "female" },
      { type: "edit_body", key: "birthYear", value: "1994" });
    expect(() => plan(half)).not.toThrow();
    expect(plan(half)).toContain("Your profile needs");
  });

  it("draws the plan complete: both day panels and the three steppers, once the profile is"
    + " complete", () => {
    expect(missingProfileFields(COMPLETE)).toEqual([]);
    const markup = plan(COMPLETE);
    expect(markup).toContain("Training day");
    expect(markup).toContain("Rest day");
    expect(markup).toContain("Reset to suggested");
    expect(markup).toContain("Estimated from your body and activity: about");
    expect(markup).not.toMatch(/Mifflin-St Jeor|Katch-McArdle|BMR/);
    expect(markup).not.toContain("Your profile needs");
  });
});
