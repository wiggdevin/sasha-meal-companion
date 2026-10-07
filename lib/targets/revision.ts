import type { TargetProfile } from "@/lib/api-types";
import { localIsoDate, todayIso } from "@/lib/settings/date";
import {
  KCAL_MIN_SOURCES, type ActiveTargetProfile, type KcalMinSource, type Macros, type Settings,
  type TargetRevision, type TargetRevisionFloors, type TargetSeed,
} from "@/lib/types";

/** A row written before step D has no source column; its minimum is the database default. */
function kcalMinSource(value: unknown): KcalMinSource {
  return typeof value === "string" && (KCAL_MIN_SOURCES as readonly string[]).includes(value)
    ? value as KcalMinSource
    : "legacy_default";
}

/**
 * A stored number: a finite JSON number or a non-blank numeric string (Postgres `numeric`).
 * `null`, `undefined`, `""`, booleans and objects are malformed — never coerced to 0
 * (calculation audit 2026-10-05 #23: `Number(null)` turned a null kcal into a 0 kcal target).
 */
function strictNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positive(value: unknown): number | null {
  const parsed = strictNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function nonNegative(value: unknown): number | null {
  const parsed = strictNumber(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

/** kcal and protein must be positive; carbs and fat may be zero. Any malformed field rejects the set. */
function macros(value: unknown): Macros | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const kcal = positive(row.kcal);
  const protein = positive(row.protein);
  const carbs = nonNegative(row.carbs);
  const fat = nonNegative(row.fat);
  if (kcal === null || protein === null || carbs === null || fat === null) return null;
  return { kcal, protein, carbs, fat };
}

/** A pin is absent (null) or a positive number; anything else makes the revision malformed. */
function pin(value: unknown): { ok: true; value: number | null } | { ok: false } {
  if (value == null) return { ok: true, value: null };
  const parsed = positive(value);
  return parsed === null ? { ok: false } : { ok: true, value: parsed };
}

function weekdays(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const days = value.map(strictNumber);
  return days.every((day): day is number => day !== null && Number.isInteger(day)
    && day >= 0 && day <= 6) ? days : null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** All five seed columns or none: a partial seed is not a seed the engine may trust. */
export function targetSeedFromProfile(profile: TargetProfile): TargetSeed | null {
  const initialTdeeKcal = positive(profile.initial_tdee_kcal);
  const bmrKcal = positive(profile.bmr_kcal);
  if (initialTdeeKcal === null || bmrKcal === null
    || (profile.bmr_method !== "mifflin" && profile.bmr_method !== "katch")
    || !profile.activity_model_version || !profile.derivation_version) return null;
  return { initialTdeeKcal, bmrKcal, bmrMethod: profile.bmr_method,
    activityModelVersion: profile.activity_model_version,
    derivationVersion: profile.derivation_version };
}

/**
 * The floor columns, all four or none. Floors are a display and guard copy of what the server
 * enforces on write; they never size a day. So a projection that never selected them, or any
 * missing or malformed floor value, leaves the revision without floors rather than rejecting its
 * macros (never coerced to 0 either). A 0 kcal minimum is a real, if weak, floor.
 */
function revisionFloors(profile: TargetProfile): TargetRevisionFloors | undefined {
  const kcalMin = nonNegative(profile.kcal_min);
  const proteinGMin = nonNegative(profile.protein_g_min);
  const fatGMin = nonNegative(profile.fat_g_min);
  const carbGMin = nonNegative(profile.carb_g_min);
  if (kcalMin === null || proteinGMin === null || fatGMin === null || carbGMin === null) {
    return undefined;
  }
  return { kcalMin, kcalMinSource: kcalMinSource(profile.kcal_min_source),
    proteinGMin, fatGMin, carbGMin };
}

/**
 * New authority rows map losslessly; legacy rows keep using the Phase 6 fallback. A row with any
 * malformed numeric field is rejected (null), so the phone treats it as missing — `needs_profile`
 * when it is the only one — and never shows a target coerced to 0.
 */
export function targetRevisionFromProfile(profile: TargetProfile): TargetRevision | null {
  const training = macros(profile.training_macros);
  const rest = macros(profile.rest_macros);
  const source = profile.target_source;
  const weightSource = profile.input_weight_source;
  const weightKg = positive(profile.input_weight_kg);
  const trainingWeekdays = weekdays(profile.input_training_weekdays);
  const revisionNumber = strictNumber(profile.rev);
  if (!training || !rest || !source || !weightSource || weightKg === null || !trainingWeekdays
    || revisionNumber === null || !Number.isInteger(revisionNumber)
    || typeof profile.effective_from !== "string" || !ISO_DATE.test(profile.effective_from)
    || !profile.input_activity_level || !profile.input_goal || !profile.formula_name) return null;
  const pinTraining = pin(profile.pin_training_kcal);
  const pinRest = pin(profile.pin_rest_kcal);
  const pinProtein = pin(profile.pin_protein_g);
  if (!pinTraining.ok || !pinRest.ok || !pinProtein.ok) return null;
  // A null rate is the documented maintenance default; a present one must be a real number.
  const goalRateBpWeek = profile.goal_rate_bp_week == null ? 0 : strictNumber(profile.goal_rate_bp_week);
  if (goalRateBpWeek === null) return null;
  const floors = revisionFloors(profile);
  return {
    id: profile.id,
    revision: revisionNumber,
    source,
    effectiveFrom: profile.effective_from,
    training,
    rest,
    pins: {
      trainingKcal: pinTraining.value,
      restKcal: pinRest.value,
      proteinG: pinProtein.value,
    },
    inputs: {
      effectiveDate: profile.effective_from,
      weightKg,
      weightSource,
      trainingWeekdays,
      activity: profile.input_activity_level,
      goal: profile.input_goal,
      goalRateBpWeek,
      formulaName: profile.formula_name,
    },
    ...(floors ? { floors } : {}),
    seed: targetSeedFromProfile(profile),
  };
}

/**
 * How many effective dates the phone keeps: about six months of daily weigh-in revisions. Older
 * ones are dropped from the cache, and `Settings.targetHistorySince` remembers the account's
 * earliest effective date, so a date between the two still has a target (see revisionOn).
 */
export const TARGET_HISTORY_LIMIT = 180;

type DatedRevision = Pick<TargetRevision, "effectiveFrom" | "revision">;

/**
 * The server's own order (lib/server/targets.ts activeProfile and every SQL picker:
 * `order by effective_from desc, rev desc`): effective date first, then `rev`. Ascending here.
 */
function compareRevisions(a: DatedRevision, b: DatedRevision): number {
  if (a.effectiveFrom !== b.effectiveFrom) return a.effectiveFrom < b.effectiveFrom ? -1 : 1;
  return a.revision - b.revision;
}

function isDatedRevision(value: ActiveTargetProfile | TargetRevision | null | undefined):
  value is TargetRevision {
  return !!value && typeof value.revision === "number"
    && typeof value.effectiveFrom === "string" && ISO_DATE.test(value.effectiveFrom);
}

/**
 * Merge revisions into the phone's bounded history: one entry per effective date (the highest
 * `rev` wins, as on the server; on an equal `rev` the later argument wins, so a re-read row
 * replaces a stale copy), oldest first, at most TARGET_HISTORY_LIMIT dates (the newest).
 */
export function mergeTargetHistory(
  history: readonly TargetRevision[] | null | undefined,
  revisions: readonly TargetRevision[],
): TargetRevision[] {
  const byDate = new Map<string, TargetRevision>();
  for (const revision of [...(history ?? []), ...revisions]) {
    if (!isDatedRevision(revision)) continue;
    const held = byDate.get(revision.effectiveFrom);
    if (!held || compareRevisions(held, revision) <= 0) byDate.set(revision.effectiveFrom, revision);
  }
  return [...byDate.values()].sort(compareRevisions).slice(-TARGET_HISTORY_LIMIT);
}

/**
 * The one selection rule, for "current" and for any viewed date alike, and the server's own
 * (lib/server/targets.ts activeProfile and the SQL pickers: `effective_from <= date order by
 * effective_from desc, rev desc limit 1`): the latest revision whose `effectiveFrom` is on or
 * before `date`. A date before every known revision has none (null → needs_profile), exactly as
 * the server's dated reads (day context, coach, recipe plan) answer. `history` must be sorted
 * ascending.
 */
export function revisionInForce(
  history: readonly TargetRevision[],
  date: string,
): TargetRevision | null {
  let selected: TargetRevision | null = null;
  for (const revision of history) {
    if (revision.effectiveFrom > date) break;
    selected = revision;
  }
  return selected;
}

/** The earliest effective date across the lists, or null when none holds a dated revision. */
function earliestEffective(
  ...lists: (readonly (TargetRevision | ActiveTargetProfile)[] | null | undefined)[]
): string | null {
  let earliest: string | null = null;
  for (const list of lists) for (const revision of list ?? []) {
    if (isDatedRevision(revision) && (earliest === null || revision.effectiveFrom < earliest)) {
      earliest = revision.effectiveFrom;
    }
  }
  return earliest;
}

/**
 * revisionInForce over a possibly capped history. The server answers every date on or after the
 * account's first revision (`since`) with some revision. When the cap dropped the older ones, a
 * date before the oldest KEPT revision but on or after `since` resolves to that oldest kept one,
 * the boundary revision nearest in time to the server's answer: the account had a target then,
 * so it is never needs_profile. Exact numbers for such a day are the server's. A date before
 * `since` has none, as on the server.
 */
function revisionOn(
  history: readonly TargetRevision[],
  since: string | null | undefined,
  date: string,
): TargetRevision | null {
  const selected = revisionInForce(history, date);
  if (selected || history.length === 0) return selected;
  return since && since <= date ? history[0] : null;
}

function sameJson(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** The cached current revision, when it is a real dated revision the history can hold. */
function datedCurrent(settings: Pick<Settings, "activeTargetProfile">): TargetRevision[] {
  const current = settings.activeTargetProfile;
  return isDatedRevision(current) ? [current] : [];
}

function soundMacros(value: Macros | undefined): boolean {
  return !!value && [value.kcal, value.protein, value.carbs, value.fat].every(Number.isFinite)
    && value.kcal > 0 && value.protein > 0 && value.carbs >= 0 && value.fat >= 0;
}

/** A cached revision whose macros a strict parse would also accept (never a coerced 0 kcal copy). */
function soundRevision(revision: TargetRevision): boolean {
  return soundMacros(revision.training) && soundMacros(revision.rest);
}

function samePins(settings: Settings, revision: TargetRevision): boolean {
  return settings.trainingKcal === revision.pins.trainingKcal
    && settings.restKcal === revision.pins.restKcal
    && settings.proteinG === revision.pins.proteinG;
}

/**
 * No revision is in force: the needs_profile state. A cached server revision and its pins are
 * cleared (never kept as a stale or coerced copy); a cache without a revision number (an unsaved
 * onboarding preview or a legacy blob) and pins typed before any revision exists are left alone.
 */
function withoutCurrentTarget(
  settings: Settings, history: TargetRevision[], since: string | null,
): Settings {
  const cached = settings.activeTargetProfile;
  if (cached && typeof cached.revision === "number") {
    return { ...settings, targetHistory: history, targetHistorySince: since,
      activeTargetProfile: null, trainingKcal: null, restKcal: null, proteinG: null };
  }
  return sameJson(settings.targetHistory ?? [], history)
    && (settings.targetHistorySince ?? null) === since
    ? settings : { ...settings, targetHistory: history, targetHistorySince: since };
}

/**
 * Install `history` and make the revision in force on `today` the current cache, with its pins.
 * A future-dated revision waits in the history until its date; with none in force yet (every
 * revision future-dated, or none at all) the cache is needs_profile, as the server answers. The
 * settings pins always mirror the revision in force: drifted pins are re-asserted on every pass
 * (no local writer stores a pin before its revision is saved). Returns `settings` itself when
 * nothing changed.
 */
function withTargetHistory(
  settings: Settings,
  history: TargetRevision[],
  today: string,
  earliest: string | null,
): Settings {
  // `since` is never later than the oldest kept revision, and null with no history.
  const since = history.length === 0 ? null
    : earliest !== null && earliest < history[0].effectiveFrom ? earliest : history[0].effectiveFrom;
  const next = revisionOn(history, since, today);
  if (!next) return withoutCurrentTarget(settings, history, since);
  const historyChanged = !sameJson(settings.targetHistory ?? [], history)
    || (settings.targetHistorySince ?? null) !== since;
  if (sameJson(settings.activeTargetProfile, next) && samePins(settings, next)) {
    return historyChanged ? { ...settings, targetHistory: history, targetHistorySince: since }
      : settings;
  }
  return {
    ...settings,
    targetHistory: history,
    targetHistorySince: since,
    trainingKcal: next.pins.trainingKcal,
    restKcal: next.pins.restKcal,
    proteinG: next.pins.proteinG,
    activeTargetProfile: next,
  };
}

/**
 * The one phone rule for a target revision's day: the device's LOCAL calendar day. A phone write
 * dates its revision by it and the phone resolves the revision in force by it (`todayIso`, the
 * default `today` below), so a write and its projection always agree and a new pin is in force
 * at once. Never the UTC date, and never a different zone: a travelling phone keeps its device
 * day (owner ruling), and the phone sends this day to the server with its sync batches and target
 * reads, so the server never dates the same action later (t24b, lib/server/account-day.ts).
 */
export function targetDayFor(now: Date = new Date()): string {
  return localIsoDate(now);
}

/**
 * Mirror server revisions into the synchronous phone cache. Every revision joins the dated
 * history; the current cache becomes the one in force today by the server's order, whatever
 * order the revisions arrived in, so a lower `rev` with a later effective date still wins on and
 * after its date, and an older revision never wins as current.
 */
export function settingsWithTargetRevisions(
  settings: Settings,
  revisions: readonly TargetRevision[],
  today: string = todayIso(),
): Settings {
  const history = mergeTargetHistory(
    mergeTargetHistory(settings.targetHistory, datedCurrent(settings)), revisions);
  const known = earliestEffective(settings.targetHistory, datedCurrent(settings), revisions);
  const earliest = [settings.targetHistorySince ?? null, known]
    .filter((date): date is string => date !== null).sort()[0] ?? null;
  return withTargetHistory(settings, history, today, earliest);
}

/** One revision: see settingsWithTargetRevisions. */
export function settingsWithTargetRevision(
  settings: Settings,
  revision: TargetRevision,
  today: string = todayIso(),
): Settings {
  return settingsWithTargetRevisions(settings, [revision], today);
}

/**
 * Rebuild from the account's full mirror of `target_profiles` rows (each sync pass). The history
 * becomes exactly the rows that parse. `heldIds` names every row the mirror holds, parsed or not.
 *
 * Target rows are insert-only on the server, and the phone caches a revision only from a server
 * answer (a save is queued as a request body, lib/targets/client.ts, never as a revision). So a
 * cached revision the mirror may legitimately lack is a saved one (current, future-dated or
 * backdated) whose change has not been pulled yet: its id is in no mirrored row. Those are kept,
 * if their macros are sound.
 * A current row the mirror holds but cannot parse is dropped (audit #23), and a deleted row was
 * already removed from the cache when its delete was pulled (settingsWithoutTargetRevision). With
 * no revision left the cache returns to needs_profile.
 */
export function settingsFromTargetMirror(
  settings: Settings,
  mirrored: readonly TargetRevision[],
  today: string = todayIso(),
  heldIds: Iterable<string> = [],
): Settings {
  const held = new Set(heldIds);
  for (const revision of mirrored) if (revision.id) held.add(revision.id);
  // Without an id a cached copy cannot be told apart from a gone row, so it is not kept.
  const awaitingPull = mergeTargetHistory(settings.targetHistory, datedCurrent(settings))
    .filter((cached) => !!cached.id && !held.has(cached.id) && soundRevision(cached));
  // The mirror holds every row, uncapped: its earliest date is the account's first revision.
  return withTargetHistory(settings, mergeTargetHistory(awaitingPull, mirrored), today,
    earliestEffective(awaitingPull, mirrored));
}

/**
 * A pulled delete: the revision leaves the history and, when it was current, the cache re-selects
 * the revision in force today from what remains (or returns to needs_profile). An unsaved preview
 * stays the current cache.
 */
export function settingsWithoutTargetRevision(
  settings: Settings,
  id: string,
  today: string = todayIso(),
): Settings {
  const remaining = (history: readonly TargetRevision[]) =>
    history.filter((revision) => revision.id !== id);
  const all = mergeTargetHistory(settings.targetHistory, datedCurrent(settings));
  const removed = all.find((revision) => revision.id === id);
  if (!removed) return settings;
  // Deleting the earliest known revision moves `since` to what remains; the next mirror pass
  // restores the exact date from the uncapped mirror.
  const earliest = settings.targetHistorySince && settings.targetHistorySince !== removed.effectiveFrom
    ? settings.targetHistorySince : null;
  if (!isDatedRevision(settings.activeTargetProfile)) {
    const history = remaining(settings.targetHistory ?? []);
    const since = history.length === 0 ? null : earliest ?? history[0].effectiveFrom;
    return { ...settings, targetHistory: history, targetHistorySince: since };
  }
  return withTargetHistory(settings, remaining(all), today, earliest);
}

/**
 * The revision in force on `date` (calculation audit 2026-10-05 #16), by revisionInForce over the
 * dated history and the current cache (revisionOn: the capped history's boundary revision for a
 * date it no longer covers): null before the first revision, as on the server. Without
 * a date, the current cache (itself the revision in force today). An unsaved onboarding candidate
 * (a cache without a `revision` number) answers null → needs_profile. A legacy cache with no dated
 * history keeps answering with that cache.
 */
export function targetRevisionOn(
  settings: Pick<Settings, "activeTargetProfile" | "targetHistory">
    & Partial<Pick<Settings, "targetHistorySince">>,
  date: string | undefined,
): ActiveTargetProfile | null {
  const current = settings.activeTargetProfile;
  if (current && typeof current.revision !== "number") return null;
  if (!date) return current ?? null;
  const known = mergeTargetHistory(settings.targetHistory, datedCurrent(settings));
  return known.length > 0 ? revisionOn(known, settings.targetHistorySince, date) : current ?? null;
}
