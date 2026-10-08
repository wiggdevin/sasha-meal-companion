import { accountKey, currentAccountOrNull } from "@/lib/device/account";
import type { ConstraintsPut } from "@/lib/coach/types";
import { kgToLb, LB_PER_KG, type WeightUnit } from "@/lib/health/units";
import { applyDerivedProfile } from "@/lib/targets";
import { DEFAULT_RATE_BP, confirmedRate, validateRate } from "@/lib/profile/rate-goal";
import type { ActivityLevel, BodyFatSource, Goal, Settings } from "@/lib/types";
import type { Profile } from "@/lib/constraints-client";
import type { HeightUnit } from "@/lib/units/height";
import { paceAllowed, type TargetEligibility } from "@/lib/profile/rate-eligibility";
import { shiftForFirstMeal } from "@/lib/plan";
import {
  cookingEffortFromDietPrefs,
  dietPrefsTaste,
  type CookingEffort,
  type ProfileDietPrefs,
} from "@/lib/sync/user-settings";

export const PREFERENCE_FLAGS = [
  "vegetarian", "vegan", "pescatarian", "no_pork", "no_beef", "no_shellfish",
  "no_eggs", "no_soy", "no_peanuts", "low_fodmap", "halal", "kosher",
] as const;

export const ONBOARDING_CUTOVER = "2026-09-19T18:20:00Z";
/** The account's own name (Phase 9 §0.4): `smc:u:<userId>:onboarding-invite-dismissed-at`. */
export const ONBOARDING_INVITE_DISMISSED_NAME = "onboarding-invite-dismissed-at";

/** The bound account's key, or null when none is bound (then nothing is remembered). */
export function onboardingInviteDismissedKey(): string | null {
  const h = currentAccountOrNull();
  return h === null ? null : accountKey(h, ONBOARDING_INVITE_DISMISSED_NAME);
}
const ONBOARDING_INVITE_DISMISS_MS = 30 * 24 * 60 * 60 * 1000;

export type PreferenceFlag = (typeof PREFERENCE_FLAGS)[number];
export type BodyDraftKey = "heightCm" | "birthYear" | "bodyFatPct";
export type PlanField = "trainingKcal" | "restKcal" | "proteinG";
export type OnboardingDisposition = "force" | "invite" | "none";
export type ServerOnboardingRow = {
  first_opened_at?: unknown;
  onboarded_at?: unknown;
};
export type LocalOnboardingState = {
  firstOpenedAt?: unknown;
  onboardedAt?: unknown;
};

type OnboardingRowQuery = { maybeSingle: () => PromiseLike<{ data?: unknown; error?: unknown }> };

export type AccountOnboardingClient = {
  from: (table: string) => {
    select: (columns: string) => OnboardingRowQuery & {
      eq?: (column: string, value: string) => OnboardingRowQuery;
    };
  };
};

export type OnboardingState = {
  step: number;
  body: Record<BodyDraftKey, string> & { sex: "female" | "male" | "unspecified" | "" };
  /** Where the body-fat number came from (step C); a new number clears both. */
  bodyFatSource: BodyFatSource | null;
  bodyFatMeasuredOn: string | null;
  heightUnit: HeightUnit;
  weight: string;
  weightUnit: WeightUnit;
  /**
   * The exact kilograms behind a `weight` text this module wrote itself (a seeded or converted
   * value). The text is rounded for display (68 kg shows as "149.9" lb), so reading it back would
   * store 67.993 kg for an untouched 68 kg answer. While `weight` still equals `text` in `unit`,
   * `parsedWeightKg` returns `kg`; any edit makes the text differ and the typed value wins.
   */
  weightSeed?: { text: string; unit: WeightUnit; kg: number };
  activityLevel: ActivityLevel | null;
  trainingWeekdays: number[];
  goal: Goal | null;
  /** A preset for the goal (step D); null until the user confirms one for a loss or gain goal. */
  goalRateBpWeek: number | null;
  prefsText: string;
  flags: PreferenceFlag[];
  cookingEffort: CookingEffort | null;
  userOverrides: Partial<Record<PreferenceFlag, boolean>>;
  planEdits: Partial<Record<PlanField, number | null>>;
  mealsPerDay: number | null;
  /** "Your day" (onboarding v2 §1b): the first meal as 24-hour "HH:MM", saved as the whole-day
   *  shift (`shiftForFirstMeal`, lib/plan.ts). Unset or null keeps the layout's own times. */
  firstMealTime?: string | null;
  /**
   * The country chip (ruling docs/decisions/2026-10-08-us-default-country.md). Unset means the
   * flow never showed the chip, and completion leaves `countryCode` alone. A flow that shows the
   * pre-selected "I'm in the U.S." chip sets `ONBOARDING_COUNTRY_CHIP` itself, on screen; null is
   * the user switching it off. Never filled from a zone, a locale or a model.
   */
  countryCode?: string | null;
};

/** The one pre-selected, editable onboarding country chip ("I'm in the U.S."). */
export const ONBOARDING_COUNTRY_CHIP = "US";

export type OnboardingAction =
  | { type: "replace"; state: OnboardingState }
  | { type: "step"; value: number }
  | { type: "edit_body"; key: BodyDraftKey; value: string }
  | { type: "set_sex"; value: "female" | "male" | "unspecified" | "" }
  | { type: "set_body_fat_source"; source: BodyFatSource | null; measuredOn: string | null }
  | { type: "set_height_unit"; value: HeightUnit }
  | { type: "edit_weight"; value: string }
  | { type: "set_weight_unit"; value: WeightUnit }
  | { type: "set_activity"; value: ActivityLevel }
  | { type: "toggle_weekday"; value: number }
  | { type: "set_goal"; value: Goal }
  | { type: "set_goal_rate"; value: number }
  | { type: "set_prefs_text"; value: string }
  | { type: "toggle_flag"; flag: PreferenceFlag }
  | { type: "merge_flags"; flags: PreferenceFlag[] }
  | { type: "set_cooking_effort"; value: CookingEffort | null }
  | { type: "edit_plan"; field: PlanField; value: number }
  | { type: "set_meals_per_day"; value: number }
  | { type: "set_first_meal_time"; value: string | null }
  | { type: "set_country"; value: string | null }
  | { type: "reset_plan" };

function text(value: number | null | undefined): string {
  return typeof value === "number" ? String(value) : "";
}

export function normalizePreferenceFlags(flags: readonly string[] | undefined): PreferenceFlag[] {
  const normalized = new Set(flags?.map((flag) => flag === "no_nuts" ? "no_peanuts" : flag));
  return PREFERENCE_FLAGS.filter((flag) => normalized.has(flag));
}

export function isExistingAccount(firstOpenedAt: string): boolean {
  const openedAt = Date.parse(firstOpenedAt);
  return Number.isFinite(openedAt) && openedAt <= Date.parse(ONBOARDING_CUTOVER);
}

function finiteTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

/**
 * The disposition of the ACCOUNT, from the account's own `user_settings` row and nothing else.
 *
 * `lib/store.ts` is one device-wide blob shared by every account that has ever signed in on this
 * browser, so its `firstOpenedAt`/`onboardedAt` cannot answer a question about one account
 * (D1 §1.3). A missing row is therefore a brand-new account — `force` — rather than whatever the
 * last person to use this phone happened to leave behind. A read that FAILED is not a row and
 * never reaches here: the caller falls back to that account's own cache, or fails closed.
 */
export function accountDisposition(serverRow: ServerOnboardingRow | null): OnboardingDisposition {
  if (serverRow === null) return "force";
  if (finiteTimestamp(serverRow.onboarded_at) !== null) return "none";
  // Only an explicit JSON null may force. A value that is present but unusable — or a shape the
  // select did not return at all — means the account has state this classifier cannot read, and
  // sending it back through setup would be the more damaging guess.
  if (serverRow.onboarded_at !== null) return "invite";

  const openedAt = finiteTimestamp(serverRow.first_opened_at);
  if (openedAt === null) return "invite";
  return openedAt > Date.parse(ONBOARDING_CUTOVER) ? "force" : "invite";
}

export async function readAccountOnboardingRow(
  client: AccountOnboardingClient, expectedUserId?: string,
): Promise<ServerOnboardingRow | null | undefined> {
  try {
    const query = client.from("user_settings").select("first_opened_at, onboarded_at");
    // The row of the account the caller expects (PR #248 review r1 #3), never whatever row a
    // session that changed underneath it would see.
    const scoped = expectedUserId !== undefined && query.eq
      ? query.eq("user_id", expectedUserId) : query;
    const { data, error } = await scoped.maybeSingle();
    if (error) return undefined;
    if (data === null) return null;
    if (typeof data !== "object") return undefined;
    const row = data as Record<string, unknown>;
    return {
      ...(Object.hasOwn(row, "first_opened_at") ? { first_opened_at: row.first_opened_at } : {}),
      ...(Object.hasOwn(row, "onboarded_at") ? { onboarded_at: row.onboarded_at } : {}),
    };
  } catch {
    return undefined;
  }
}

export function shouldShowOnboardingInvite(
  disposition: OnboardingDisposition,
  dismissedAt: string | null,
  now: Date,
): boolean {
  if (disposition !== "invite") return false;
  if (!dismissedAt) return true;
  const dismissedMs = Date.parse(dismissedAt);
  return !Number.isFinite(dismissedMs) || now.getTime() - dismissedMs >= ONBOARDING_INVITE_DISMISS_MS;
}

export function readOnboardingInviteDismissedAt(
  storage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined" ? null : localStorage,
): string | null {
  const key = onboardingInviteDismissedKey();
  if (key === null) return null;
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function dismissOnboardingInvite(
  now: Date,
  storage: Pick<Storage, "setItem"> | null = typeof localStorage === "undefined" ? null : localStorage,
): string {
  const dismissedAt = now.toISOString();
  const key = onboardingInviteDismissedKey();
  try {
    if (key !== null) storage?.setItem(key, dismissedAt);
  } catch {
    // A blocked localStorage should still dismiss the card for this mounted session.
  }
  return dismissedAt;
}

export function createOnboardingState(settings: Settings, initial = 0): OnboardingState {
  const weightUnit = settings.weightUnit ?? "lb";
  const seededWeight = settings.weightKg === null || settings.weightKg === undefined
    ? ""
    : text(weightUnit === "lb" ? Math.round(kgToLb(settings.weightKg) * 10) / 10 : settings.weightKg);
  return {
    step: Math.max(0, Math.min(5, initial)),
    body: {
      heightCm: text(settings.heightCm),
      birthYear: text(settings.birthYear),
      bodyFatPct: text(settings.bodyFatPct),
      // The legacy two-option control still has no UI for "unspecified" (onboarding v2 §2's
      // "prefer not to say"), but the draft's own type now carries the value through rather than
      // collapsing it to "" — a chat-onboarding account that answered "Prefer not to say" and
      // then reopens the legacy form must not have that answer silently erased (UI-NEEDS onb2-l5).
      sex: settings.sex === "female" || settings.sex === "male" || settings.sex === "unspecified"
        ? settings.sex : "",
    },
    bodyFatSource: settings.bodyFatSource ?? null,
    bodyFatMeasuredOn: settings.bodyFatMeasuredOn ?? null,
    heightUnit: settings.heightUnit ?? "ft_in",
    weight: seededWeight,
    weightUnit,
    ...(seededWeight && typeof settings.weightKg === "number"
      ? { weightSeed: { text: seededWeight, unit: weightUnit, kg: settings.weightKg } } : {}),
    activityLevel: settings.activityLevel ?? null,
    // No weekday is preselected (D1 §6.3). An empty list is an explicit rest-only schedule,
    // not "unset", so a new account is never handed someone else's training week.
    trainingWeekdays: settings.trainingWeekdays ? [...settings.trainingWeekdays] : [],
    goal: settings.goal ?? null,
    goalRateBpWeek: confirmedRate(settings.goal, settings.goalRateBpWeek),
    prefsText: settings.dietPrefs?.text ?? "",
    flags: normalizePreferenceFlags(settings.dietPrefs?.flags),
    cookingEffort: cookingEffortFromDietPrefs(settings.dietPrefs),
    userOverrides: {},
    planEdits: {},
    mealsPerDay: settings.mealsPerDay ?? null,
  };
}

function toggle<T>(values: T[], value: T): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

export function parsedWeightKg(state: OnboardingState): number | null {
  const seed = state.weightSeed;
  if (seed && seed.text === state.weight && seed.unit === state.weightUnit
    && Number.isFinite(seed.kg) && seed.kg >= 20 && seed.kg <= 400) {
    return Math.round(seed.kg * 1000) / 1000;
  }
  const raw = Number(state.weight.trim());
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const kg = state.weightUnit === "lb" ? raw / LB_PER_KG : raw;
  if (kg < 20 || kg > 400) return null;
  return Math.round(kg * 1000) / 1000;
}

function convertedWeight(state: OnboardingState, unit: WeightUnit): string {
  const kg = parsedWeightKg(state);
  if (kg === null) return state.weight;
  return unit === "kg" ? String(kg) : String(Math.round(kg * LB_PER_KG * 10) / 10);
}

export function onboardingReducer(
  state: OnboardingState,
  action: OnboardingAction,
): OnboardingState {
  switch (action.type) {
    case "replace":
      return action.state;
    case "step":
      return { ...state, step: Math.max(0, Math.min(5, action.value)) };
    case "edit_body":
      return { ...state, body: { ...state.body, [action.key]: action.value },
        // A different number is a different measurement: its source has to be picked again.
        ...(action.key === "bodyFatPct" && action.value.trim() !== state.body.bodyFatPct.trim()
          ? { bodyFatSource: null, bodyFatMeasuredOn: null } : {}) };
    case "set_body_fat_source":
      return { ...state, bodyFatSource: action.source, bodyFatMeasuredOn: action.measuredOn };
    case "set_sex":
      return { ...state, body: { ...state.body, sex: action.value } };
    case "set_height_unit":
      return { ...state, heightUnit: action.value };
    case "edit_weight":
      return { ...state, weight: action.value };
    case "set_weight_unit":
      if (action.value === state.weightUnit) return state;
      {
        const kg = parsedWeightKg(state);
        const weight = convertedWeight(state, action.value);
        return { ...state, weight, weightUnit: action.value,
          ...(kg === null ? { weightSeed: undefined }
            : { weightSeed: { text: weight, unit: action.value, kg } }) };
      }
    case "set_activity":
      return { ...state, activityLevel: action.value };
    case "toggle_weekday":
      return { ...state, trainingWeekdays: toggle(state.trainingWeekdays, action.value)
        .sort((a, b) => a - b) };
    case "set_goal":
      // A new goal starts at its recommended rate; the same goal keeps what was chosen.
      return { ...state, goal: action.value,
        goalRateBpWeek: action.value === state.goal && state.goalRateBpWeek !== null
          ? state.goalRateBpWeek : DEFAULT_RATE_BP[action.value] };
    case "set_goal_rate":
      return state.goal !== null && validateRate(state.goal, action.value)
        ? { ...state, goalRateBpWeek: action.value } : state;
    case "set_prefs_text":
      return { ...state, prefsText: action.value };
    case "toggle_flag":
      return {
        ...state,
        flags: toggle(state.flags, action.flag),
        userOverrides: {
          ...state.userOverrides,
          [action.flag]: !state.flags.includes(action.flag),
        },
      };
    case "merge_flags":
      return {
        ...state,
        flags: PREFERENCE_FLAGS.filter((flag) =>
          state.userOverrides[flag] ?? action.flags.includes(flag)),
      };
    case "set_cooking_effort":
      return { ...state, cookingEffort: action.value };
    case "edit_plan":
      return { ...state, planEdits: { ...state.planEdits, [action.field]: action.value } };
    case "set_meals_per_day":
      return Number.isInteger(action.value) && action.value >= 2 && action.value <= 6
        ? { ...state, mealsPerDay: action.value } : state;
    case "set_first_meal_time":
      return action.value === null || shiftForFirstMeal(action.value) !== null
        ? { ...state, firstMealTime: action.value } : state;
    case "set_country":
      return action.value === null || /^[A-Z]{2}$/.test(action.value)
        ? { ...state, countryCode: action.value } : state;
    case "reset_plan":
      return { ...state, planEdits: { trainingKcal: null, restKcal: null, proteinG: null } };
  }
}

function finiteInRange(raw: string, min: number, max: number, integer = false): number | null {
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value < min || value > max) return null;
  if (integer && !Number.isInteger(value)) return null;
  return value;
}

function candidateSettings(base: Settings, state: OnboardingState, onboardedAt: string): Settings {
  const bodyFat = state.body.bodyFatPct.trim() === ""
    ? null : finiteInRange(state.body.bodyFatPct, 3, 70);
  const dietPrefs: ProfileDietPrefs = {
    text: state.prefsText.trim(),
    flags: normalizePreferenceFlags(state.flags),
    ...(state.cookingEffort
      ? { lifestyle: { cookingEffort: state.cookingEffort } }
      : {}),
    // The water unit and goal mode, and the confirmed taste dislikes, are not onboarding's to reset.
    ...((base.dietPrefs as ProfileDietPrefs | null | undefined)?.water
      ? { water: { ...(base.dietPrefs as ProfileDietPrefs).water } } : {}),
    ...dietPrefsTaste(base.dietPrefs as ProfileDietPrefs | null | undefined),
  };
  return {
    ...base,
    sex: state.body.sex || null,
    birthYear: finiteInRange(state.body.birthYear, 1900, new Date().getFullYear(), true),
    heightCm: finiteInRange(state.body.heightCm, 50, 260),
    heightUnit: state.heightUnit,
    bodyFatPct: bodyFat,
    bodyFatSource: bodyFat === null ? null : state.bodyFatSource,
    bodyFatMeasuredOn: bodyFat === null ? null : state.bodyFatMeasuredOn,
    weightKg: parsedWeightKg(state),
    weightUnit: state.weightUnit,
    activityLevel: state.activityLevel,
    goal: state.goal,
    goalRateBpWeek: confirmedRate(state.goal, state.goalRateBpWeek),
    trainingWeekdays: [...state.trainingWeekdays],
    mealsPerDay: state.mealsPerDay,
    ...(state.countryCode !== undefined ? { countryCode: state.countryCode } : {}),
    dietPrefs,
    onboardedAt,
  };
}

/**
 * `eligibility` is the safety round's answer (`eligibilityFromSafetyAnswers`): a held account
 * (pregnant, breastfeeding, an eating disorder, kidney disease, a clinician-set diet) is never
 * asked for a pace, so a loss or gain goal needs none.
 */
export function missingProfileFields(state: OnboardingState, eligibility?: TargetEligibility): string[] {
  const missing: string[] = [];
  if (!state.body.sex) missing.push("sex");
  if (finiteInRange(state.body.birthYear, 1900, new Date().getFullYear(), true) === null) {
    missing.push("birth year");
  }
  if (finiteInRange(state.body.heightCm, 50, 260) === null) missing.push("height");
  if (parsedWeightKg(state) === null) missing.push("weight");
  if (state.activityLevel === null) missing.push("activity level");
  if (state.goal === null) missing.push("goal");
  else if (paceAllowed(eligibility) && confirmedRate(state.goal, state.goalRateBpWeek) === null) {
    missing.push("goal rate");
  }
  return missing;
}

export function buildCompletedSettings(
  base: Settings,
  state: OnboardingState,
  now: Date,
  eligibility?: TargetEligibility,
): Settings {
  if (missingProfileFields(state, eligibility).length > 0) {
    throw new Error("Cannot use an incomplete onboarding profile");
  }
  const candidate = candidateSettings(base, state, now.toISOString());
  // A held account stores no pace (null derives at maintenance, and stays unconfirmed if the
  // hold is later removed); the server applies the same hold to every revision.
  const settings = paceAllowed(eligibility) ? candidate : { ...candidate, goalRateBpWeek: null };
  const derived = applyDerivedProfile(settings, now, undefined, settings.trainingWeekdays ?? [],
    eligibility);
  const targets = derived.activeTargetProfile!;
  const defaults: Record<PlanField, number> = {
    trainingKcal: targets.training.kcal,
    restKcal: targets.rest.kcal,
    proteinG: targets.training.protein,
  };
  const pins: Partial<Pick<Settings, PlanField>> = {};
  for (const field of ["trainingKcal", "restKcal", "proteinG"] as const) {
    const value = state.planEdits[field];
    if (value !== undefined) pins[field] = value === defaults[field] ? null : value;
  }
  const completed = { ...derived, ...pins };
  // The first meal's shift is taken against the layout the saved target gives (an automatic
  // meal count follows the calories), never the three-meal default. A plan edit pins the
  // calories, so the layout is the pinned revision's, not the unpinned derivation's.
  const pinned = Object.values(pins).some((value) => value !== null && value !== undefined)
    ? applyDerivedProfile(completed, now, undefined, completed.trainingWeekdays ?? [], eligibility)
    : derived;
  const shift = state.firstMealTime
    ? shiftForFirstMeal(state.firstMealTime, pinned) : null;
  return { ...completed, ...(shift !== null ? { shiftMinutes: shift } : {}) };
}

export function changedPlanFields(base: Settings, completed: Settings): PlanField[] {
  return (["trainingKcal", "restKcal", "proteinG"] as const)
    .filter((field) => base[field] !== completed[field]);
}

export function buildSkippedSettings(base: Settings, now: Date): Settings {
  return { ...base, onboardedAt: now.toISOString() };
}

type ConstraintPatch = Omit<ConstraintsPut, "baseRev">;

const FLAG_ALLERGENS: Partial<Record<PreferenceFlag, string[]>> = {
  no_shellfish: ["shellfish"],
  no_eggs: ["egg"],
  no_soy: ["soy"],
  // `peanut` is the only nut key in reference.ts; add tree-nut keys here when they exist.
  no_peanuts: ["peanut"],
};

const FLAG_CATEGORIES: Partial<Record<PreferenceFlag, string[]>> = {
  low_fodmap: ["onion_garlic", "beans"],
};

export function enforcedFlags(): PreferenceFlag[] {
  return [...PREFERENCE_FLAGS];
}

export function advisoryFlags(): PreferenceFlag[] {
  return [];
}

function appendUnique(current: string[], additions: string[]): string[] {
  return [...current, ...additions.filter((item) => !current.includes(item))];
}

/**
 * `conditions` are the safety round's entries (`safetyConditionEntries`, onboarding v2 G7): added
 * to the account's own list, never replacing an entry it already holds. "Pregnant" arms the
 * pregnancy tuna check; every entry is plain text the user can remove in Foods › Avoids.
 */
export function constraintPatchForFlags(
  flags: readonly PreferenceFlag[],
  profile: Profile,
  conditions: readonly string[] = [],
): ConstraintPatch | null {
  const allergens = flags.flatMap((flag) => FLAG_ALLERGENS[flag] ?? []);
  const categories = flags.flatMap((flag) => FLAG_CATEGORIES[flag] ?? []);
  const avoidAllergens = appendUnique(profile.avoid_allergens, allergens);
  const bannedCategories = appendUnique(profile.banned_categories, categories);
  const current = profile.conditions ?? [];
  const nextConditions = appendUnique(current, conditions
    .map((item) => item.trim().slice(0, 64)).filter((item) => item.length > 0)).slice(0, 20);
  const patch: ConstraintPatch = {};
  if (avoidAllergens.length !== profile.avoid_allergens.length) patch.avoidAllergens = avoidAllergens;
  if (bannedCategories.length !== profile.banned_categories.length) {
    patch.bannedCategories = bannedCategories;
  }
  if (nextConditions.length !== current.length) patch.conditions = nextConditions;
  return Object.keys(patch).length > 0 ? patch : null;
}

export function weightLbFor(state: OnboardingState): number | null {
  const kg = parsedWeightKg(state);
  return kg === null ? null : kg * LB_PER_KG;
}
