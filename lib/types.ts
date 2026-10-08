import type { Snapshot } from "./nutrients/snapshot";
import type { EnergyFloorBound } from "./profile/energy";
import type { CuisineKey } from "./profile/cuisines";
/**
 * Shared contract for the app.
 *
 * Everything in the app derives from a calendar date: no programme start date, no expiry (PRD §1.1).
 */

// ---------------------------------------------------------------- day types

export type DayType = "training-10" | "training-7-fasted" | "rest";

/** Ritual slot ids are historical; training weekdays are `training-10`, fasted is an override. */
export type SlotId =
  | "coffee"
  | "pouches-pre"
  | "post-refuel" // Wednesday only: shake + pouches + latte
  | "meal-1"
  | "meal-2"
  | "meal-3"
  | "meal-4"
  | "meal-5"
  | "meal-6"
  | "hot-chocolate"; // optional, rest days

export type Macros = {
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
};

export type TargetSet = {
  training: Macros;
  rest: Macros;
};

export type ActivityLevel = "sedentary" | "light" | "moderate" | "active" | "very_active";

export const BODY_FAT_SOURCES = ["dexa", "inbody", "clinical_bia", "consumer_scale",
  "visual_estimate", "typed_unknown"] as const;
export type BodyFatSource = (typeof BODY_FAT_SOURCES)[number];

export type Goal = "lose_fat" | "recomp" | "maintain" | "gain_muscle";

export type TargetSource = "derived" | "proposal" | "manual";
/** `trend` is the adaptive engine's smoothed weight, the basis once a proposal is approved. */
export type TargetWeightSource = "weigh-in" | "onboarding" | "trend";
/** Where a revision's `kcal_min` came from: the account's own macro minimum, an explicit account
 *  minimum, or the database default a row got before step D. Never a medical limit. */
export const KCAL_MIN_SOURCES = ["macro_minimum", "account_minimum", "legacy_default"] as const;
export type KcalMinSource = (typeof KCAL_MIN_SOURCES)[number];
export type TargetPins = {
  trainingKcal: number | null;
  restKcal: number | null;
  proteinG: number | null;
};
export type TargetInputs = {
  effectiveDate: string;
  weightKg: number;
  weightSource: TargetWeightSource;
  trainingWeekdays: number[];
  activity: ActivityLevel;
  goal: Goal;
  /** The rate the revision was derived at; 0 for maintenance and for an unconfirmed rate. */
  goalRateBpWeek: number;
  formulaName: string;
};
export type TargetRevisionFloors = {
  kcalMin: number;
  kcalMinSource: KcalMinSource;
  proteinGMin: number;
  fatGMin: number;
  carbGMin: number;
};
/** The formula start a derived revision was built on (TDEE step E1). The expenditure engine reads
 *  it instead of re-deriving the seed from tonight's profile; null on rows written before E1. */
export type TargetSeed = {
  initialTdeeKcal: number;
  bmrKcal: number;
  bmrMethod: "mifflin" | "katch";
  activityModelVersion: string;
  derivationVersion: string;
};
export type TargetRevision = TargetSet & {
  id?: string;
  revision: number;
  source: TargetSource;
  effectiveFrom: string;
  pins: TargetPins;
  inputs: TargetInputs;
  floors?: TargetRevisionFloors;
  seed?: TargetSeed | null;
};

/** Older local blobs carry only the two macro sets; a synchronized cache carries every field. */
export type ActiveTargetProfile = TargetSet
  & Partial<Omit<TargetRevision, keyof TargetSet>>
  & { floorsBound?: EnergyFloorBound[] };

export type DietPrefs = { flags: string[]; text?: string };

// ---------------------------------------------------------------- meals

export type FoodComponent = {
  name: string;
  /** Base quantity in the authored meal library. Scaled per §7.5. */
  qty: number;
  unit: "oz" | "cup" | "tbsp" | "tsp" | "whole" | "pouch" | "can" | "g" | "ml";
  /** Protein components DO NOT scale with calorie changes (bodyweight-derived target, PRD §7.5). */
  role: "protein" | "carb" | "fat" | "free";
  macros: Macros;
  /** Phase 18 W3: the generated food's identity (lib/meals/taste-identity.ts); optional on the wire. */
  foodKey?: string; /** A malformed key arrived: the taste reader treats this line as unreadable. */
  foodKeyInvalid?: true;
};

export type Meal = {
  id: string;
  name: string;
  slot: SlotId;
  components: FoodComponent[];
  /** Sum of components. Precomputed for speed; must be validated by test. */
  macros: Macros;
  /** Minutes of prep. Used to surface quick options on a bad day. */
  prepMinutes: number;
  tags: MealTag[]; /** W8: why an open-world meal was suggested (lib/meals/open-world.ts); else absent. */
  reasons?: ("eaten_often" | "on_list")[];
};

export type MealTag =
  | "no-cook"
  | "leftovers-friendly"
  | "low-fibre"
  | "eat-out-ok"
  | "floor-day";

// ---------------------------------------------------------------- settings

export type Settings = {
  /** Nullable pins mirrored from the effective target revision. */
  trainingKcal: number | null;
  restKcal: number | null;
  proteinG: number | null;
  /** Protein is locked by default — changing it needs a deliberate unlock. */
  proteinLocked: boolean;
  /** Per-slot time overrides, e.g. { "meal-1": "12:30" } */
  slotTimes: Partial<Record<SlotId, string>>;
  /** Whole-day offset in minutes, applied on top of slotTimes. */
  shiftMinutes: number;
  /** Explicit meal count; null derives 3-5 from this account's training target. */
  mealsPerDay?: number | null;
  /** Transient server-confirmed provenance gate; never inferred from local food rules. */
  ruleReviewReady?: boolean;
  changedAt: string | null;
  /** Nullable profile fields mirrored from the normalized user_settings row. */
  heightCm?: number | null;
  /** Display preferences only; measurements remain metric in storage. */
  heightUnit?: "ft_in" | "cm";
  weightUnit?: "lb" | "kg";
  birthYear?: number | null;
  sex?: "female" | "male" | "unspecified" | null;
  bodyFatPct?: number | null;
  /** Where the body-fat value came from; null or absent means unverified (step C). */
  bodyFatSource?: BodyFatSource | null;
  /** The scan date, YYYY-MM-DD, for a measured source. */
  bodyFatMeasuredOn?: string | null;
  weightKg?: number | null;
  activityLevel?: ActivityLevel | null;
  goal?: Goal | null;
  /** Basis points of body weight per week, a preset for the goal (step D); null until the user
   *  confirms one, and a null derives at maintenance. */
  goalRateBpWeek?: number | null;
  /** JS weekday numbers: Sunday = 0 through Saturday = 6. */
  trainingWeekdays?: number[] | null;
  dietPrefs?: DietPrefs | null;
  /** W5 (lib/profile/cuisines.ts): up to 6 cuisines and a chosen country; mascot (lib/profile/mascot.ts) absent = 'sprout'. */
  cuisines?: CuisineKey[] | null; countryCode?: string | null; mascot?: import("./profile/mascot").MascotKey;
  onboardedAt?: string | null;
  /** Synchronized cache of the latest server target revision. Legacy blobs may hold only macros. */
  activeTargetProfile?: ActiveTargetProfile | null;
  /** Bounded, dated history of server revisions (one per effective date, oldest first), so a
   *  viewed day resolves the revision in force on that day (lib/targets/revision.ts
   *  targetRevisionOn). Never the authority for "current": that stays `activeTargetProfile`. */
  targetHistory?: TargetRevision[] | null;
  /** The account's earliest known effective date (the first revision's), kept when the history
   *  cap drops older revisions, so a date in between still resolves (lib/targets/revision.ts). */
  targetHistorySince?: string | null;
  /** Stamped by the store on every settings save; drives newer-wins sync. */
  updatedAt?: string;
};

// ---------------------------------------------------------------- stored day

/**
 * One food inside a logged entry, Phase 2 shape: grams-first with a frozen nutrient snapshot
 * (`compute_item_snapshot`), plus the display half so a legacy logged meal renders as it did.
 */
export type LoggedItem = {
  id: string; seq: number; food_ref_id: string; grams: number | null; qty: number; unit: string; // grams null: mass unknown (t17)
  /** Frozen per-item nutrients; `{}` on a legacy or migrated item that was never measured. */
  snapshot: Partial<Snapshot>;
  /** Display half, kept so a legacy logged meal renders exactly as it did. */
  foodId: string; name: string; portionLabel: string; macros: Macros;
};

/** A food logged on top of the plan — anything, at any amount. */
export type LoggedFood = {
  id: string; // unique per entry
  foodId: string; // food-db id, or an account-owned food id
  name: string;
  /** The log kind shown as secondary card text; `snack` is not a plan slot. */
  slot?: SlotId | "snack";
  portionLabel: string;
  qty: number; // number of portions
  grams: number;
  massUnknown?: true; // an item's mass is unknown (t17): `grams` is only the known part
  macros: Macros;
  flags?: string[];
  nutritionPartial?: boolean; // #21: a partly measured recipe serving; "at least …", never `flags`
  /** Account-entered note, editable any time. */
  note?: string;
  /** A logged MEAL: its foods. `macros` is their sum. */
  items?: LoggedItem[];
  /**
   * The server revision this entry is known to be at, when one is known. Absent means the server
   * has not acknowledged it — it is still pending, or the reply could not vouch for it — which is
   * what lets Today tell a settled card from one that is still on its way (T0 §3).
   */
  rev?: number;
  localOnly?: true; // never sent or queued: kept on this phone after a not-sent pick
  notSaved?: string; // the server refused this saved-later log (t17): why, for the UI to show
  at: string; // ISO timestamp
};

/**
 * A slot edited for one date. The WHOLE resulting component list, not a patch
 * keyed by position — a positional patch stops meaning anything once the rotation or an authored
 * meal changes, and the list is the honest record of what was eaten. See lib/plan/slot-override.ts.
 */
export type SlotOverride = {
  /** The meal the edit started from, so the card can still say what it was. */
  baseMealId: string | null;
  /** What the slot actually holds now. Empty means it was cleared. */
  components: FoodComponent[];
  /** Dish name for this date-specific materialized meal. */
  title?: string;
  /** Time-only edits follow the plan; components remain a safe snapshot for older clients. */
  followPlan?: boolean;
  /** Local clock time for this date only. */
  time?: string;
  /** Per-date extra meal or hidden meal; never inferred from a legacy ritual. */
  added?: boolean;
  removed?: boolean;
  /** Explicit Clear; distinguishes an empty card from an added slot awaiting generation. */
  cleared?: boolean;
  /** One user slot intent; retained unchanged by outbox retries and full-day replays. */
  mutationId?: string;
  /**
   * Projection only: the server's current-rules verdict for an accepted recipe selection, set by
   * `withAcceptedRecipeSelections`. Never synced (the plan_days schema strips it); resolveDay
   * trusts it only on a `recipe:` override and treats its absence there as unknown.
   */
  ruleMark?: RuleMark | null;
  /** Projection only: the phone's rules epoch when `ruleMark` was fetched (lib/foods/rules-epoch.ts). */
  ruleMarkEpoch?: number;
  /** Projection only: `foodRulesKey` of the diet flags the server judged `ruleMark` under. */
  ruleMarkRulesKey?: string;
  /** Projection only: the accepted recipe's ingredient names, judged against live Food status. */
  ruleIngredients?: string[];
};

/** A recorded recipe portion, independent of the meal still planned for that slot. */
export type ConsumedRecipeSnapshot = {
  baseMealId: string;
  title: string;
  components: [FoodComponent];
};

export type EatenSlotState = {
  eaten_at: string | null;
  changed_at: string;
  consumed?: ConsumedRecipeSnapshot;
  history_epoch?: string;
};

/** Only touched days are stored; an untouched day is computed from its date (a small blob over months). */
export type StoredDay = {
  date: string; // ISO yyyy-mm-dd — the primary key
  dayTypeOverride?: DayType;
  floorDay?: boolean;
  extras?: LoggedFood[];
  /** Notes on the plan's own meals, per slot. */
  notes?: Partial<Record<SlotId, string>>;
  /** mealId chosen per slot when swapped away from the rotation. */
  swaps?: Partial<Record<SlotId, string>>;
  /**
   * Slots edited by hand for THIS date — the whole resulting component list, not a patch.
   * Wins over the swap, Floor Day and the rotation. See lib/plan/slot-override.ts.
   */
  itemOverrides?: Partial<Record<SlotId, SlotOverride>>;
  eaten?: Partial<Record<SlotId, string>>; // slot -> ISO timestamp
  consumedSlots?: Partial<Record<SlotId, ConsumedRecipeSnapshot>>;
  /** When the user marked this day "fully logged" (ISO timestamp); absent = not marked. Only this
   *  mark lets the expenditure engine trust the day's intake (TDEE step E6). */
  dayCompleteAt?: string;
  gut?: "good" | "iffy" | "flare";
  weightLb?: number;
  waterMl?: number;
  /** Stamped on every write; drives newer-wins sync. */
  updatedAt?: string;
};

export type Store = {
  version: 1;
  /** When this blob was first written; drives the onboarding invitation, not any warning. */
  firstOpenedAt: string;
  settings: Settings;
  days: Record<string, StoredDay>;
  /** Projection of this account's synchronized foods and preferences. */
  foods: Record<string, import("./foods").Food>;
};

// ------------------------------------------------------- resolved view model

/** What the UI actually renders. Fully derived; never stored. */
/**
 * Saved plan content judged against the account's CURRENT food rules on read (2026-10-05 audit
 * F1/F2). `blocked`: a current rule excludes it. `unknown`: it could not be proven to pass (not in
 * the server-verified eligible set, or the rules have not been checked since they changed).
 * Content is never hidden or deleted; eaten content is history and is never re-judged.
 */
export type RuleMark = { verdict: "blocked" | "unknown"; reason: string };

export type ResolvedSlot = {
  slot: SlotId;
  time: string; // "08:30"
  label: string;
  meal: Meal | null;
  /** Components with quantities already scaled for the day's targets. */
  components: FoodComponent[];
  macros: Macros;
  eaten: boolean;
  eatenAt?: string;
  note?: string;
  /**
   * Worst mark over the slot's saved, uneaten content; null when clear, generated or eaten.
   * resolveDay always sets it; optional only so hand-built fixtures stay valid (absent = null).
   */
  ruleMark?: RuleMark | null;
  /** One entry per `components` line, same order; null when that line is clear. Set by resolveDay. */
  componentRuleMarks?: (RuleMark | null)[];
};

export type ResolvedDay = {
  date: string;
  dayType: DayType;
  isFloorDay: boolean;
  targets: Macros | null;
  slots: ResolvedSlot[];
  /** Logged foods outside the plan. Counted in `consumed`. */
  extras: LoggedFood[];
  consumed: Macros;
  /** Water logged, in cups (240 ml). */
  waterCups: number;
  gut?: "good" | "iffy" | "flare";
  weightLb?: number;
};

// ---------------------------------------------------------------- constants

/** Arbitrary fixed epoch for deterministic meal rotation; never shown in the UI. */
export const ROTATION_EPOCH = "2026-01-01";

/** Hard floors — the settings screen must clamp to these. PRD §7.5. */
export const FLOORS = {
  carbsTraining: 100,
  carbsRest: 80,
  fat: 50,
} as const;

// ---------------------------------------------------------------- AI provenance

/**
 * Who produced a piece of content an API payload carries, so the phone can label AI work
 * (AI-integration audit 2026-10-04, P2 #16). One shape for every surface:
 * - `{ ai: true, source: "model" }` — a generative model call (coach turn, capture read, weekly
 *   review, plan photo or document read). `purpose` is the `ai_calls` purpose when known.
 * - `{ ai: true, source: "jev" }` — a TypeSafe System One (Jev) judgment decided it: the intent
 *   fast path, or a Jev-ranked suggestion card.
 * - `{ ai: false, source: "app" }` — written by the app from data and rules alone (a fallback
 *   review from logged days, a barcode or catalog match, a recipe page's JSON-LD, a fit-ordered card).
 * The server derives it from facts it holds (the path that ran, stored `model_id`/`ai_call_id`),
 * never from a guess. An absent field means the server could not tell (a legacy row).
 * Helpers and the zod schema live in lib/provenance.ts.
 */
export type Provenance =
  | { ai: true; source: "model" | "jev"; purpose?: string }
  | { ai: false; source: "app" };
