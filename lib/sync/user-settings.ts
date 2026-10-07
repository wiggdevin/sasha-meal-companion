import { BODY_FAT_SOURCES, type ActivityLevel, type BodyFatSource, type DietPrefs, type Goal,
  type Settings } from "../types";
import { isoDay } from "../profile/energy";
import { waterPrefsFrom, type WaterPrefs } from "../water-prefs";
import { cuisinesFrom, parseCountryCode, parseCuisines, type CuisineKey } from "../profile/cuisines";
import { tasteToStore, type TastePrefs } from "../profile/taste";

export const COOKING_EFFORTS = ["none", "minimal", "full"] as const;
export type CookingEffort = (typeof COOKING_EFFORTS)[number];
export type DietPrefsLifestyle = { cookingEffort: CookingEffort };
/** `water` holds the water unit and goal mode (lib/water-prefs.ts) and `taste` the confirmed taste
 *  dislikes (lib/profile/taste.ts); every writer carries both. */
export type ProfileDietPrefs = DietPrefs & {
  lifestyle?: DietPrefsLifestyle; water?: WaterPrefs; taste?: TastePrefs;
};

export type UserSettingsProfileRow = {
  time_zone?: string | null;
  activity_prompt_dismissed_until?: string | null;
  height_cm?: number | null;
  height_unit?: "ft_in" | "cm" | null;
  weight_unit?: "lb" | "kg" | null;
  birth_year?: number | null;
  sex?: "female" | "male" | "unspecified" | null;
  body_fat_pct?: number | null;
  body_fat_source?: BodyFatSource | null;
  body_fat_measured_on?: string | null;
  weight_kg?: number | null;
  activity_level?: ActivityLevel | null;
  goal?: Goal | null;
  goal_rate_bp_week?: number | null;
  training_weekdays?: number[] | null;
  diet_prefs?: ProfileDietPrefs | null;
  onboarded_at?: string | null;
  meals_per_day?: number | null;
  /** Phase 18 W5. NOT NULL on the server: the wire clears with [], never null. */
  cuisines?: CuisineKey[];
  country_code?: string | null;
};

export type ProfileSettings = Omit<Pick<Settings,
  "heightCm" | "heightUnit" | "weightUnit" | "birthYear" | "sex" | "bodyFatPct" | "bodyFatSource"
  | "bodyFatMeasuredOn" | "weightKg" | "activityLevel" | "goal" | "goalRateBpWeek"
  | "trainingWeekdays" | "dietPrefs" | "onboardedAt" | "mealsPerDay">, "dietPrefs"> & {
  dietPrefs?: ProfileDietPrefs | null;
  /** Omitted: keep the stored list. `[]` or null: clear it. */
  cuisines?: CuisineKey[] | null;
  /** Omitted: keep the stored country. null: clear it. */
  countryCode?: string | null;
  timeZone?: string | null;
  activityPromptDismissedUntil?: string | null;
  };

/** A stored source outside the enum reads as unverified; so does a date `isoDay` refuses. */
function bodyFatSourceFromRow(value: unknown): BodyFatSource | null {
  return typeof value === "string" && (BODY_FAT_SOURCES as readonly string[]).includes(value)
    ? value as BodyFatSource
    : null;
}


export function parseCookingEffort(value: unknown): CookingEffort | null {
  return typeof value === "string" && (COOKING_EFFORTS as readonly string[]).includes(value)
    ? value as CookingEffort
    : null;
}

function dietPrefsFromRow(value: unknown): ProfileDietPrefs | null {
  if (value == null) return null;
  const row = typeof value === "object" ? value as Record<string, unknown> : {};
  const flags = Array.isArray(row.flags)
    ? row.flags.filter((flag): flag is string => typeof flag === "string")
    : [];
  const lifestyle = typeof row.lifestyle === "object" && row.lifestyle !== null
    ? row.lifestyle as Record<string, unknown>
    : {};
  const effort = parseCookingEffort(lifestyle.cookingEffort);
  const water = waterPrefsFrom(row.water);
  const taste = tasteToStore(row.taste);
  return {
    flags,
    ...(typeof row.text === "string" ? { text: row.text } : {}),
    ...(effort ? { lifestyle: { cookingEffort: effort } } : {}),
    ...(Object.keys(water).length > 0 ? { water } : {}),
    ...(taste ? { taste } : {}),
  };
}

export function cookingEffortFromDietPrefs(value: unknown): CookingEffort | null {
  return dietPrefsFromRow(value)?.lifestyle?.cookingEffort ?? null;
}

export function settingsWithCookingEffort<T extends ProfileSettings>(
  settings: T,
  effort: CookingEffort,
): T & { dietPrefs: ProfileDietPrefs } {
  return {
    ...settings,
    dietPrefs: {
      flags: [...(settings.dietPrefs?.flags ?? [])],
      ...(settings.dietPrefs?.text !== undefined ? { text: settings.dietPrefs.text } : {}),
      lifestyle: { cookingEffort: effort },
      ...(settings.dietPrefs?.water ? { water: { ...settings.dietPrefs.water } } : {}),
      ...dietPrefsTaste(settings.dietPrefs),
    },
  };
}

/** `{ taste }` for a spread, copied and cleaned, or `{}` when there is none to keep. */
export function dietPrefsTaste(dietPrefs: ProfileDietPrefs | null | undefined): { taste?: TastePrefs } {
  const taste = tasteToStore(dietPrefs?.taste);
  return taste ? { taste } : {};
}

const owns = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

/**
 * The W5 columns' omit/null rule, phone side. An omitted or undefined field keeps the stored
 * value. `cuisines` null or `[]` clears to `[]` (the column is NOT NULL); `countryCode` null clears
 * it. A value the server's checks would refuse is left out, not sent: one refused settings op parks
 * every pending settings change.
 */
function placeAndCuisineRow(settings: ProfileSettings): Pick<UserSettingsProfileRow, "cuisines" | "country_code"> {
  const row: Pick<UserSettingsProfileRow, "cuisines" | "country_code"> = {};
  if (settings.cuisines !== undefined) {
    const cuisines = settings.cuisines === null ? [] : parseCuisines(settings.cuisines);
    if (cuisines) row.cuisines = cuisines;
  }
  if (settings.countryCode !== undefined) {
    const code = settings.countryCode === null ? null : parseCountryCode(settings.countryCode);
    if (settings.countryCode === null || code) row.country_code = code;
  }
  return row;
}

/** The stored diet_prefs object: flags copied, `taste` cleaned, every other key kept. */
function dietPrefsRow(prefs: ProfileDietPrefs): ProfileDietPrefs {
  const { taste: _taste, ...rest } = prefs;
  void _taste;
  return { ...rest, flags: [...prefs.flags], ...dietPrefsTaste(prefs) };
}

export function settingsProfileFromRow(row: UserSettingsProfileRow): ProfileSettings {
  return {
    ...(owns(row, "cuisines") ? { cuisines: cuisinesFrom(row.cuisines) } : {}),
    ...(owns(row, "country_code") ? { countryCode: parseCountryCode(row.country_code) } : {}),
    ...(Object.prototype.hasOwnProperty.call(row, "time_zone")
      ? { timeZone: row.time_zone ?? null }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(row, "activity_prompt_dismissed_until")
      ? { activityPromptDismissedUntil: row.activity_prompt_dismissed_until ?? null }
      : {}),
    heightCm: row.height_cm ?? null,
    heightUnit: row.height_unit ?? "ft_in",
    weightUnit: row.weight_unit ?? "lb",
    birthYear: row.birth_year ?? null,
    sex: row.sex ?? null,
    bodyFatPct: row.body_fat_pct ?? null,
    bodyFatSource: bodyFatSourceFromRow(row.body_fat_source),
    bodyFatMeasuredOn: isoDay(row.body_fat_measured_on),
    weightKg: row.weight_kg ?? null,
    activityLevel: row.activity_level ?? null,
    goal: row.goal ?? null,
    goalRateBpWeek: typeof row.goal_rate_bp_week === "number" ? row.goal_rate_bp_week : null,
    trainingWeekdays: row.training_weekdays ? [...row.training_weekdays] : null,
    dietPrefs: dietPrefsFromRow(row.diet_prefs),
    onboardedAt: row.onboarded_at ?? null,
    mealsPerDay: typeof row.meals_per_day === "number" && Number.isInteger(row.meals_per_day)
      && row.meals_per_day >= 2 && row.meals_per_day <= 6 ? row.meals_per_day : null,
  };
}

export function settingsProfileToRow(settings: ProfileSettings): UserSettingsProfileRow {
  return {
    ...(Object.prototype.hasOwnProperty.call(settings, "timeZone")
      ? { time_zone: settings.timeZone ?? null }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(settings, "activityPromptDismissedUntil")
      ? { activity_prompt_dismissed_until: settings.activityPromptDismissedUntil ?? null }
      : {}),
    height_cm: settings.heightCm ?? null,
    height_unit: settings.heightUnit ?? "ft_in",
    weight_unit: settings.weightUnit ?? "lb",
    birth_year: settings.birthYear ?? null,
    sex: settings.sex ?? null,
    body_fat_pct: settings.bodyFatPct ?? null,
    body_fat_source: settings.bodyFatSource ?? null,
    // A date _sync_upsert cannot cast would fail the whole coalesced settings op, so a bad one
    // is sent as null (unverified) rather than parking every pending settings change.
    body_fat_measured_on: isoDay(settings.bodyFatMeasuredOn),
    weight_kg: settings.weightKg ?? null,
    activity_level: settings.activityLevel ?? null,
    goal: settings.goal ?? null,
    goal_rate_bp_week: settings.goalRateBpWeek ?? null,
    training_weekdays: settings.trainingWeekdays ? [...settings.trainingWeekdays] : null,
    diet_prefs: settings.dietPrefs ? dietPrefsRow(settings.dietPrefs) : null,
    onboarded_at: settings.onboardedAt ?? null,
    meals_per_day: settings.mealsPerDay ?? null,
    ...placeAndCuisineRow(settings),
  };
}

/**
 * A new body-fat value never inherits the old value's provenance (step C). When `after` carries
 * `body_fat_pct` and it differs from `before` while the source and the scan date stay the same —
 * or the value is cleared — both are cleared. The same rule runs server-side as the
 * `user_settings_body_fat_provenance` trigger; this copy keeps the phone's own row honest before
 * the next pull.
 */
export function withBodyFatProvenance<T extends Record<string, unknown>>(
  before: Record<string, unknown>, after: T,
): T {
  if (!Object.prototype.hasOwnProperty.call(after, "body_fat_pct")) return after;
  // An omitted key keeps the stored value, exactly as _sync_upsert treats it.
  const same = (key: string) => !Object.prototype.hasOwnProperty.call(after, key)
    || (after[key] ?? null) === (before[key] ?? null);
  const cleared = after.body_fat_pct === null || after.body_fat_pct === undefined;
  const changed = !same("body_fat_pct");
  if (!cleared && !(changed && same("body_fat_source") && same("body_fat_measured_on"))) {
    return after;
  }
  return { ...after, body_fat_source: null, body_fat_measured_on: null };
}

/**
 * The one place a client settings write is rewritten before it is stored and queued: the mirror
 * row and the op payload both pass `withBodyFatProvenance`, so a new body-fat value cannot keep
 * the old value's source. It lives here beside that rule rather than in the outbox, which only
 * delegates to it.
 */
export function withSettingsProvenance<T extends { row: R; op: { payload?: unknown } }, R extends Record<string, unknown>>(
  current: Record<string, unknown>, out: T,
): T {
  const payload = out.op.payload as Record<string, unknown> | undefined;
  return { ...out, row: withBodyFatProvenance(current, out.row),
    op: payload ? { ...out.op, payload: withBodyFatProvenance(current, payload) } : out.op };
}
