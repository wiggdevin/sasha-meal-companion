/**
 * Onboarding v2, lane 3 (facts flow) — re-exports of L1's landed `OnboardingFacts` schema
 * (`lib/coach/ui-blocks.ts`, BRIEF.md §5), plus the UI-only presence/confidence helpers this
 * lane's components need that L1's module has no reason to own.
 *
 * CONTRACT ONB2-L1 posted to coord.md (2026-10-07, "sex-unspecified") and L1 landed on
 * `origin/main` as #493 ("LANDED onb2-l1-r3"). This file was the local stand-in BRIEF.md §5 asked
 * for ("build against the type in BRIEF.md section 5 behind a local adapter, so the switch is one
 * file") until that happened — per the orchestrator (coord.md, 2026-10-07), this is that one-file
 * switch: every facts-flow component in this folder still imports `OnboardingFacts`/field types
 * from here, but here now re-exports L1's real schema instead of redefining it. No other file in
 * this folder needed to change.
 */
import {
  onboardingConfidenceBand,
  type OnboardingFacts as RealOnboardingFacts,
  type OnboardingFactKey as RealOnboardingFactKey,
} from "@/lib/coach/ui-blocks";

export {
  ONBOARDING_FACT_KEYS, ONBOARDING_GOALS, ONBOARDING_ACTIVITIES, ONBOARDING_COOKING_EFFORTS,
  onboardingFactsSchema, onboardingConfidenceBand, type OnboardingConfidenceBand,
} from "@/lib/coach/ui-blocks";
export type OnboardingFacts = RealOnboardingFacts;
export type OnboardingFactKey = RealOnboardingFactKey;

export type Goal = NonNullable<OnboardingFacts["goal"]>;
export type Sex = Exclude<NonNullable<OnboardingFacts["sex"]>, "unspecified">;
export type ActivityLevel = NonNullable<OnboardingFacts["activity"]>;
export type CookingEffort = NonNullable<OnboardingFacts["cookingEffort"]>;

/**
 * L1's own schema already carries `"unspecified"` as a real `sex` value (CONTRACT ONB2-L1,
 * coord.md 2026-10-07: `EnergyProfile.sex: "female" | "male" | "unspecified"` in
 * `lib/profile/energy.ts`, with `SEX_BMR_TERM.unspecified` the exact Mifflin-St Jeor midpoint;
 * male/female results are byte-identical to before, regression-tested by L1). `SexAnswer` is
 * simply `OnboardingFacts["sex"]` narrowed to non-`undefined`, kept as its own alias so this
 * lane's components read the same name they always have. Never auto-confirmed: `bandConfidence`
 * and the sentence renderer always ask for this answer's own tap, the same as any other sex
 * value — and L3/L5 both send `"unspecified"` for it, never `null` (null stays reserved for
 * "never asked").
 */
export type SexAnswer = NonNullable<OnboardingFacts["sex"]>;

/** Orchestrator copy (2026-10-07): shown once "Prefer not to say" is tapped. Never explains why. */
export const PREFER_NOT_TO_SAY_NOTE = "No problem. Your numbers will be a close estimate.";

/** BRIEF §5 bands: ≥0.85 auto-confirms in the sentence, ≤0.50 is dropped and asked plainly, the
 *  open middle is a ghost chip that needs a tap. Delegates to L1's own `onboardingConfidenceBand`
 *  for the actual threshold comparison (imported above and re-exported) — this just collapses its
 *  four-state `"high" | "ghost" | "dropped" | "none"` into the three a chip can actually render
 *  as, since a chip draws no visual difference between "dropped for low confidence" and "never
 *  set at all".
 *
 *  A non-finite score (`NaN`, `Infinity`) is rejected HERE, before calling L1's function: that
 *  function's own threshold comparisons (`score >= 0.85`, `score <= 0.5`) are both `false` for
 *  `NaN`, so it falls through to "ghost" instead of treating a non-finite score as absent — a gap
 *  Sol r3 closed in this lane's own code and would otherwise silently reopen now that this lane
 *  delegates to L1's shared function, which UI cannot edit (LANES.md: UI never edits lib/). */
export type ChipConfidence = "high" | "ghost" | "empty";

export function bandConfidence(value: number | undefined): ChipConfidence {
  if (value !== undefined && !Number.isFinite(value)) return "empty";
  const band = onboardingConfidenceBand(value);
  return band === "dropped" || band === "none" ? "empty" : band;
}

const VALID_GOALS: ReadonlySet<string> = new Set<Goal>([
  "lose_fat", "recomp", "maintain", "gain_muscle",
]);
const VALID_SEXES: ReadonlySet<string> = new Set<SexAnswer>(["male", "female", "unspecified"]);
const VALID_ACTIVITIES: ReadonlySet<string> = new Set<ActivityLevel>([
  "sedentary", "light", "moderate", "active", "very_active",
]);
const VALID_COOKING_EFFORTS: ReadonlySet<string> = new Set<CookingEffort>([
  "none", "minimal", "full",
]);
/** Every enum field's real values, keyed the same way the field itself is keyed. */
const ENUM_VALUES: Partial<Record<OnboardingFactKey, ReadonlySet<string>>> = {
  goal: VALID_GOALS, sex: VALID_SEXES, activity: VALID_ACTIVITIES,
  cookingEffort: VALID_COOKING_EFFORTS,
};
/** Every numeric field. A string here — or a number on an enum field below — is wrong-shaped,
 *  not just blank (Sol r5 BLOCK: the r4 fix validated an enum string's membership but still
 *  accepted ANY finite number for that same enum key, and any non-blank string for a numeric
 *  key, because the old code branched on the VALUE's own JS type before asking what type the
 *  FIELD itself expects). */
const NUMERIC_KEYS: ReadonlySet<OnboardingFactKey> = new Set(["birthYear", "heightCm", "weightKg"]);

/**
 * Whether a field actually carries a usable value — one typed predicate covering every "not
 * really there" shape, not a single spot-fixed `undefined` check (Sol r3 re-plan, tightened twice
 * more on Sol r4 and r5 BLOCKs): `undefined` and `null`; a non-finite number; an empty/whitespace
 * string; an empty array; a string on an enum field that matches none of its real values; AND —
 * r5's fix — a value whose JS type doesn't even match what the FIELD expects (a number where an
 * enum string belongs, or a string where a number belongs) is never treated as the right type for
 * that field's own enum/numeric checks just because it happened to pass a same-named check meant
 * for a different field. Branches on the field's own declared shape first, the value's JS type
 * second. Used everywhere a field is read — see `factValue` below — so a malformed payload can
 * never render a blank "confirmed" chip or arm "That's me" on nothing.
 */
export function hasFactValue<K extends OnboardingFactKey>(
  facts: OnboardingFacts, key: K,
): boolean {
  const value = facts[key];
  if (value === undefined || value === null) return false;
  if (NUMERIC_KEYS.has(key)) return typeof value === "number" && Number.isFinite(value);
  const enumValues = ENUM_VALUES[key];
  if (enumValues) return typeof value === "string" && enumValues.has(value);
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim() !== "";
  if (typeof value === "number") return Number.isFinite(value);
  return true;
}

/**
 * The field's own value, but only when `hasFactValue` accepts it — the one accessor every reader
 * of a field should go through (Sol r4 WARN: the presence predicate existed but wasn't actually
 * used everywhere a field was read, which is how the r4 enum gap slipped past `effectiveBand`
 * while `chipLabel` and the birth-year narrowing each re-implemented their own narrower check).
 */
export function factValue<K extends OnboardingFactKey>(
  facts: OnboardingFacts, key: K,
): OnboardingFacts[K] | undefined {
  return hasFactValue(facts, key) ? facts[key] : undefined;
}

/**
 * The band a chip should actually render as, given the field's own value — not confidence alone
 * (Sol r2 WARN, generalized in the r3 re-plan via `hasFactValue`: a malformed payload can carry
 * `confidence.goal` with no usable `goal` value at all; reading confidence in isolation would
 * render a blank "value" chip and let "That's me" confirm nothing). A field with no usable value
 * is always "empty", whatever its confidence score says.
 */
export function effectiveBand<K extends OnboardingFactKey>(
  facts: OnboardingFacts, key: K,
): ChipConfidence {
  return hasFactValue(facts, key) ? bandConfidence(facts.confidence[key]) : "empty";
}

export function emptyFacts(): OnboardingFacts {
  return { confidence: {} };
}
