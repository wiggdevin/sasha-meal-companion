/**
 * Onboarding v2, lane 5 — the one bridge between lane 1/3's landed facts shape
 * (`@/components/Onboarding/facts`, which re-exports `lib/coach/ui-blocks.ts`'s real
 * `OnboardingFacts` schema as of CONTRACT ONB2-L1, #493) and the write path the legacy flow
 * already owns (`lib/profile/onboarding-state.ts`, `lib/profile/onboarding-client.ts` — neither
 * edited here, both imported as-is per LANES.md's UI-lane boundary).
 */
import type { OnboardingFacts } from "@/components/Onboarding/facts";
import { createOnboardingState, type OnboardingState, type PreferenceFlag, PREFERENCE_FLAGS }
  from "@/lib/profile/onboarding-state";
import type { ActivityLevel, Settings } from "@/lib/types";

/** Alias kept so the rest of this file (and its tests) read naturally; it is the same type
 *  `OnboardingFacts` already is — not a parallel shape. */
export type FactsLike = OnboardingFacts;

const KNOWN_FLAGS = new Set<string>(PREFERENCE_FLAGS);

/** Only real, known flags cross the bridge — a malformed or future flag the facts flow has not
 *  learned about yet is dropped here rather than written as an opaque string a constraint write
 *  would not recognise either. */
export function knownPreferenceFlags(dietFlags: readonly string[] | undefined): PreferenceFlag[] {
  if (!dietFlags) return [];
  return dietFlags.filter((flag): flag is PreferenceFlag => KNOWN_FLAGS.has(flag));
}

/** Only the fields a confirmed fact actually set, in `Settings`' own field names — the one
 *  mapping both `applyFactsToSettings` (below) and the draft/fallback path (`draft-store.ts`,
 *  `OnboardingErrorBoundary.tsx`) share, so a resumed or recovered draft reads back exactly the
 *  fields a live session would have written. */
export function factsToPartialSettings(facts: FactsLike): Partial<Settings> {
  return {
    ...(facts.goal !== undefined ? { goal: facts.goal } : {}),
    // CONTRACT ONB2-L1 sex-unspecified (#493): `Settings.sex` carries "unspecified" as its own
    // real wire value now, distinct from `null` ("never asked") — passed through as-is.
    ...(facts.sex !== undefined ? { sex: facts.sex } : {}),
    ...(facts.birthYear !== undefined ? { birthYear: facts.birthYear } : {}),
    ...(facts.heightCm !== undefined ? { heightCm: facts.heightCm } : {}),
    ...(facts.weightKg !== undefined ? { weightKg: facts.weightKg } : {}),
    ...(facts.activity !== undefined ? { activityLevel: facts.activity } : {}),
  };
}

/** Merges confirmed facts onto the account's existing settings — never onto a blank slate, so a
 *  field the facts flow never touched (e.g. this device's existing `heightUnit`) is preserved. */
export function applyFactsToSettings(base: Settings, facts: FactsLike): Settings {
  return { ...base, ...factsToPartialSettings(facts) };
}

/** What the question-set beats after the body facts answered (QUESTION-SET-v2.md §1b–§2):
 *  every field is the person's own tap, or the conservative default the plan card names. */
export type PlanStateAnswers = {
  /** The confirmed pace preset; null until the pace beat (or a route without one) settles it. */
  goalRateBpWeek: number | null;
  activityLevel: ActivityLevel;
  trainingWeekdays: readonly number[];
  mealsPerDay: number | null;
  firstMealTime: string | null;
  /** "US" while the visible chip is on, null when switched off; undefined: the chip never showed. */
  countryCode?: string | null;
};

/** The same `OnboardingState` shape `useStarterStep`/`useOnboardingFoodAccess`/
 *  `persistCompletedOnboarding` already read — built from confirmed facts instead of the legacy
 *  form's own step reducer. `step` is pinned to 5 ("Your plan").
 *
 *  Question set v2 (V1, V3–V5): the pace, activity, training days, meals and first meal come from
 *  the beats (`plan`), never a silent default. Without `plan` (a caller that has not reached those
 *  beats) the pace stays unconfirmed, so completion stays blocked on the pace tap, and activity is
 *  the conservative `sedentary` (ruling R1), never the old "moderate". */
export function buildOnboardingStateFromFacts(
  settings: Settings, facts: FactsLike, plan?: PlanStateAnswers,
): OnboardingState {
  const state = createOnboardingState(settings, 5);
  const goalRateBpWeek = plan ? plan.goalRateBpWeek
    : facts.goal && facts.goal !== state.goal ? null : state.goalRateBpWeek;
  const activityLevel = plan?.activityLevel ?? facts.activity ?? "sedentary";
  // GPT-6 Sol round-1 BLOCK: only replace the account's saved flags when the facts flow actually
  // answered a flags question.
  const flags = facts.dietFlags !== undefined ? knownPreferenceFlags(facts.dietFlags) : state.flags;
  return {
    ...state, flags, goalRateBpWeek, activityLevel,
    ...(plan ? {
      trainingWeekdays: [...plan.trainingWeekdays].sort((a, b) => a - b),
      mealsPerDay: plan.mealsPerDay,
      firstMealTime: plan.firstMealTime,
      ...(plan.countryCode !== undefined ? { countryCode: plan.countryCode } : {}),
    } : {}),
  };
}
