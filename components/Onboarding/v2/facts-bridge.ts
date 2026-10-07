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
import { DEFAULT_RATE_BP } from "@/lib/profile/rate-goal";
import type { Settings } from "@/lib/types";

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

/** The same `OnboardingState` shape `useStarterStep`/`useOnboardingFoodAccess`/
 *  `persistCompletedOnboarding` already read — built from confirmed facts instead of the legacy
 *  form's own step reducer, so this shell can reuse that write path unedited (LANES.md: UI lane
 *  may not touch `lib/`). `step` is pinned to 5 ("Your plan"): every required field this shell
 *  asks for IS the legacy flow's step-0/2 set, so there is no earlier step to represent. */
export function buildOnboardingStateFromFacts(settings: Settings, facts: FactsLike): OnboardingState {
  const state = createOnboardingState(settings, 5);
  // The legacy form picks a goal's default rate the moment the goal itself is chosen
  // (`applyGoalChange`, lib/profile/rate-goal.ts) — this shell asks for a goal and nothing about
  // a rate (the brief's required-answer budget has no room for it), so the same default applies
  // here, the one time a goal is set, rather than leaving `confirmedRate` with nothing and
  // blocking completion on an answer never asked for.
  const goalRateBpWeek = facts.goal ? DEFAULT_RATE_BP[facts.goal] : state.goalRateBpWeek;
  // Activity is not one of the brief's required answers either (goal, sex, birth year, height,
  // weight, allergy/condition — six, per BRIEF.md §2), but `missingProfileFields`/
  // `buildCompletedSettings` (both lane-0 code, unedited) treat it as required for a target
  // derivation. "moderate" is the same mid-point default `ACTIVITY_FACTORS` documents as the
  // conservative prior — never silently guessed as "sedentary" or "very_active" — and the account
  // can always refine it later in Settings; this only keeps completion from being blocked on a
  // question this shell never asks.
  const activityLevel = facts.activity ?? state.activityLevel ?? "moderate";
  // `OnboardingState.body.sex` is typed `"female"|"male"|""` (lib/profile/onboarding-state.ts,
  // not edited here) — `createOnboardingState` collapses any other `Settings.sex` value,
  // "unspecified" included, to `""`, which is how a "Prefer not to say" answer would otherwise
  // get reported as a MISSING sex by `missingProfileFields` and then get silently re-nulled by
  // `candidateSettings`'s `sex: state.body.sex || null` on write. Both of those reads only ever
  // check truthiness or pass the value straight through — never a strict `==="female"` branch —
  // so carrying the real value through this one field is safe for every consumer this bridge
  // actually drives (`missingProfileFields`, `buildCompletedSettings`, `persistCompletedOnboarding`).
  // Flagged as a UI-NEEDS in coord.md for the real fix (widen the type at the source); this is the
  // narrow, contained workaround until that lands, not a silent guess at a value.
  const body = facts.sex === "unspecified" ? { ...state.body, sex: "unspecified" as never } : state.body;
  // GPT-6 Sol round-1 BLOCK: this shell never asks a dietary-flag question, so `facts.dietFlags`
  // is undefined on every real run — overwriting `state.flags` with `knownPreferenceFlags(undefined)`
  // (always `[]`) would silently erase an account's already-saved flags (vegan, halal, ...) on
  // completion. `createOnboardingState` already derived `state.flags` correctly from the account's
  // existing saved diet flags (onboarding-state.ts, unedited) — only replace it when the
  // facts flow actually answered a flags question.
  const flags = facts.dietFlags !== undefined ? knownPreferenceFlags(facts.dietFlags) : state.flags;
  return { ...state, body, flags, goalRateBpWeek, activityLevel };
}
