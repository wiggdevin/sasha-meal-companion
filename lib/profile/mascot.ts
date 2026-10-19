/**
 * UI-NEEDS MASCOT (coord.md 2026-10-07T12:38Z): the companion a person chose, stored as
 * `user_settings.mascot` (migration 20261225090000; text, default 'sprout', never cleared to
 * null -- an omitted or `null` write keeps the stored value). The server never validates the
 * string beyond length (free text, so a new mascot ships without a migration); this module is
 * where the phone's own allowed set and its fallback rule live.
 *
 * Mirrors components/today/island/mascots.ts's `MascotKey`/`MASCOT_KEYS` (the UI lane's richer
 * presentation catalog: display name, one line, and art per pose). This file is the thin id-only
 * twin lib/today/pet-mood.ts and lib/sync/user-settings.ts need, so neither has to import from
 * components/. Keep the key list and the "unknown falls back to sprout" rule identical in both
 * places; a test holds them equal.
 *
 * Pure. No I/O.
 */

export const MASCOT_KEYS = ["sprout", "blueberry", "mushroom", "peapod"] as const;
export type MascotKey = (typeof MASCOT_KEYS)[number];

export const DEFAULT_MASCOT: MascotKey = "sprout";

/** The display name mascots.ts also uses ("the names are working names"). */
export const MASCOT_NAMES: Record<MascotKey, string> = {
  sprout: "Sprout", blueberry: "Blu", mushroom: "Button", peapod: "Pod",
};

export const isMascotKey = (value: unknown): value is MascotKey =>
  typeof value === "string" && (MASCOT_KEYS as readonly string[]).includes(value);

/** A stored or typed value, read leniently: anything not a known key falls back to Sprout
 *  (the column is free text, so an older or unrecognised value is expected, not an error). */
export function mascotKeyOf(value: unknown): MascotKey {
  return isMascotKey(value) ? value : DEFAULT_MASCOT;
}

/** The display name for a (possibly unknown) stored value, falling back the same way. */
export function mascotNameOf(value: unknown): string {
  return MASCOT_NAMES[mascotKeyOf(value)];
}

/** A stored hidden-companions list, read leniently: keys the phone does not know are dropped,
 *  repeats kept once, in order (never `mascotKeyOf`, which would turn an unknown key into Sprout). */
export function companionKeysOf(value: unknown): MascotKey[] {
  return Array.isArray(value) ? [...new Set(value.filter(isMascotKey))] : [];
}

/** A hidden-companions list as stored, every key the database accepts kept (1–40 characters, once,
 *  in order, at most 8), so a phone that does not know a newer companion never drops it on a write. */
export function storedCompanionKeysOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const keys = value.filter((k): k is string => typeof k === "string" && k.length >= 1 && k.length <= 40);
  return [...new Set(keys)].slice(0, 8);
}
