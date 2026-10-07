/**
 * Phase 13 §9 R5: the draft JSON's `time_window` field is prose ("all Fridays in Lent", "user
 * calendar", "course + 3 days"). This table types every one of them, so no conditional rule
 * loads as an every-day "never" (sol BLOCK, p13-s3 fix round). A profile with a `time_window`
 * this table does not name fails to load — at build time, via lib/policy/profiles/catalog.ts.
 * Pure: no I/O.
 *
 * - `expiry`: the rule runs until an end date (a course, a directive, a 30-day plan). A hard item
 *   confirms only once the user was asked for that date — a date, or an explicit `null` for
 *   "no end date".
 * - `calendar`: the rule applies only on the user's own days (Lent Fridays, a parish calendar,
 *   dawn to sunset). A hard item confirms only with the user's own dated windows, and is active
 *   only inside one of them.
 * - `option_only`: the window belongs to one of the profile's options (kosher's Passover), not to
 *   its base rules, which stay unconditional. The option itself is not coded.
 */
export const TIME_WINDOW_KINDS = ["none", "expiry", "calendar", "option_only"] as const;
export type TimeWindowKind = (typeof TIME_WINDOW_KINDS)[number];

export const PROFILE_TIME_WINDOWS: Readonly<Record<string, Exclude<TimeWindowKind, "none">>> = {
  eosinophilic_esophagitis: "expiry",
  ibs_low_fodmap: "expiry",
  low_residue_directive: "expiry",
  low_iodine_directive: "expiry",
  chewing_difficulty: "expiry",
  linezolid: "expiry",
  antibiotic_mineral_binding: "expiry",
  disulfiram: "expiry",
  metronidazole: "expiry",
  whole30: "expiry",
  kosher: "option_only",
  ramadan_fasting: "calendar",
  lent_catholic: "calendar",
  orthodox_fasting: "calendar",
  religious_fast_generic: "calendar",
  intermittent_fasting: "calendar",
};

/** One user-supplied span, ISO date-times, `start` inclusive and `end` exclusive. */
export type ActiveWindow = { start: string; end: string };

export function timeWindowKind(profile: { id: string; time_window: unknown }): TimeWindowKind {
  if (profile.time_window === null || profile.time_window === undefined) return "none";
  const kind = Object.hasOwn(PROFILE_TIME_WINDOWS, profile.id) ? PROFILE_TIME_WINDOWS[profile.id] : undefined;
  if (!kind) {
    throw new Error(`profile ${profile.id} has a time_window with no typed classification `
      + "(lib/policy/profiles/time-windows.ts): convert it to a typed window or drop it (§9 R5)");
  }
  return kind;
}

export function insideAnyWindow(windows: readonly ActiveWindow[] | undefined, now: Date): boolean {
  const t = now.getTime();
  return (windows ?? []).some((w) => Date.parse(w.start) <= t && t < Date.parse(w.end));
}
