/** Resolve the effective server target revision for a day. No numeric fallback exists. */
import type { DayType, Macros, Settings } from "./types";
import { deriveTargetRevision } from "./profile/derive";
import { dayTypeFor } from "./plan";
import { targetRevisionOn } from "./targets/revision";

export function categoryFor(dayType: DayType): "training" | "rest" {
  return dayType === "rest" ? "rest" : "training";
}

export type ResolvedTargets = {
  macros: Macros;
  pinned: boolean;
};

type TargetSettings = Pick<Settings, "activeTargetProfile" | "targetHistory">
  & Partial<Pick<Settings, "targetHistorySince">>;

/**
 * The day's targets from the revision in force on `date` (lib/targets/revision.ts
 * targetRevisionOn). Without a date the current cache answers, as before; every per-day caller
 * passes its date so a revision effective tomorrow never sizes today.
 */
export function resolveTargets(
  dayType: DayType,
  settings: TargetSettings,
  date?: string,
): ResolvedTargets | null {
  const current = targetRevisionOn(settings, date);
  if (!current || typeof current.revision !== "number") return null;
  const pins = current.pins;
  return {
    macros: current[categoryFor(dayType)],
    pinned: Boolean(pins
      && (pins.trainingKcal !== null || pins.restKcal !== null || pins.proteinG !== null)),
  };
}

/**
 * A date's day type from the training weekdays of the revision in force on that date; an account
 * whose cache carries no weekdays falls back to its profile's weekdays. An override always wins.
 */
export function targetDayType(
  date: string,
  override: DayType | undefined,
  settings: Pick<Settings, "activeTargetProfile" | "targetHistory" | "trainingWeekdays">
    & Partial<Pick<Settings, "targetHistorySince">>,
): DayType {
  const authorityWeekdays = targetRevisionOn(settings, date)?.inputs?.trainingWeekdays;
  return dayTypeFor(date, override, {
    trainingWeekdays: authorityWeekdays ?? settings.trainingWeekdays,
  });
}

/** Pure onboarding/settings preview; persistence remains in lib/targets/client.ts. */
export function applyDerivedProfile(
  settings: Settings,
  today: Date,
  latestWeighInKg?: number | null,
  trainingWeekdays: readonly number[] = settings.trainingWeekdays ?? [],
): Settings {
  const revision = deriveTargetRevision({
    settings,
    latestWeighInKg: latestWeighInKg ?? null,
    today: today.toISOString().slice(0, 10),
    trainingWeekdays,
    source: settings.trainingKcal !== null || settings.restKcal !== null
      || settings.proteinG !== null ? "manual" : "derived",
  });
  // An unsaved candidate carries no revision number, so `resolveTargets` keeps
  // returning null until `/api/targets` assigns one (design §5.4: the server
  // revision is the sole authority; this preview is not a target).
  const { revision: _revision, id: _id, ...candidate } = revision;
  return { ...settings, activeTargetProfile: candidate };
}
