/**
 * The account's favored cuisines and optional country (Phase 18 D2, slice W5):
 * `user_settings.cuisines` and `user_settings.country_code` (migration 20261217090000).
 *
 * - cuisines: at most 6, no duplicates, each from the 12-value vocabulary
 *   (lib/foods/universe/vocabulary.ts). `[]` means none chosen. The column is NOT NULL, so the wire
 *   never carries null: the phone clears with `[]`.
 * - country_code: optional, an ISO 3166-1 alpha-2 shape (`^[A-Z]{2}$`). Only "US" turns on the
 *   U.S. population prior (lib/foods/universe/prior.ts `accountPrior`). Never derived from the time
 *   zone or geolocation, and never sent to a model.
 *
 * No state, region, race or ethnicity field exists or may be added (D2, D15).
 *
 * The database checks are the authority; these parsers match them so the phone never queues a
 * value the server would refuse (a refused settings op would park every pending settings change).
 *
 * Pure. No I/O.
 */
import { CUISINE_LABELS, CUISINES, type CuisineKey } from "@/lib/foods/universe/vocabulary";

export type { CuisineKey };
/** For the UI (Settings, onboarding) and the W5b taste chips: the vocabulary and its labels, so no other
 *  module reaches into the universe module. */
export { CUISINES, CUISINE_LABELS };

export const CUISINES_MAX = 6;
const COUNTRY_CODE = /^[A-Z]{2}$/;

const isCuisine = (value: unknown): value is CuisineKey =>
  typeof value === "string" && (CUISINES as readonly string[]).includes(value);

/** Strict: the list exactly as given, or null for a non-array, an unknown word, a duplicate or a seventh. */
export function parseCuisines(value: unknown): CuisineKey[] | null {
  if (!Array.isArray(value) || value.length > CUISINES_MAX || !value.every(isCuisine)) return null;
  return new Set(value).size === value.length ? [...value] : null;
}

/** The stored list, read leniently: unknown and repeated words are dropped, at most 6 kept. */
export function cuisinesFrom(value: unknown): CuisineKey[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isCuisine))].slice(0, CUISINES_MAX);
}

/** A stored or typed country code, or null for none or anything that is not two capital letters. */
export function parseCountryCode(value: unknown): string | null {
  return typeof value === "string" && COUNTRY_CODE.test(value) ? value : null;
}
