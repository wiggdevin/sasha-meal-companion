/**
 * The account's confirmed taste dislikes (Phase 18 D6, slice W5): `user_settings.diet_prefs.taste`.
 *
 *   diet_prefs.taste = { dislikes?: TasteDislike[] }   at most 50, no duplicates
 *   TasteDislike     = "f:<food family>"               a name family (lib/foods/base-name.ts)
 *                    | "t:<sensory tag>"               a reviewed tag (lib/foods/universe/vocabulary.ts)
 *
 * A dislike lowers a food's rank and never excludes it: it is not Avoid and not an occasion's
 * "Not this". Written only by the user through a confirmed chip or the food sheet (W5b); never by
 * Jev. Like `water`, every `diet_prefs` writer carries `taste` (tests/profile/diet-prefs-taste.test.ts).
 * Taste data never enters a model prompt (D15).
 *
 * The database holds a storage contract (`diet_prefs_taste_valid`, migration 20261217090000): shape,
 * at most 50 distinct keys, exact tags, `f:` plus 1-80 characters. Canonical families live here:
 * `parseTaste` / `tasteDislike` (new writes) also require `baseFoodName(family) === family`;
 * `tasteFrom` / `tasteToStore` (pull and push) keep every key the database accepted unchanged.
 *
 * Pure. No I/O.
 */
import { baseFoodName } from "@/lib/foods/base-name";
import { SENSORY_TAGS, type SensoryTag } from "@/lib/foods/universe/vocabulary";

/** Re-exported for the W5b taste chips, which read the vocabulary through this module only. */
export { SENSORY_TAGS, type SensoryTag };

export const TASTE_DISLIKES_MAX = 50;
const FAMILY_MAX = 80;

export type TasteDislike = `f:${string}` | `t:${SensoryTag}`;
export type TastePrefs = { dislikes?: TasteDislike[] };

/** jsonb cannot hold U+0000 or a lone surrogate, so a family with either could never be stored. */
function storableInJsonb(point: string): boolean {
  const code = point.codePointAt(0) ?? 0;
  return code !== 0 && (code < 0xd800 || code > 0xdfff);
}

/**
 * A stored dislike key: the database's storage contract (`diet_prefs_taste_valid`), read as is. A
 * reviewed tag, or `f:` plus 1-80 code points that jsonb can hold. Any family string the database
 * accepted passes unchanged: a reader never drops or rewrites a stored key. Matching may normalize a
 * temporary copy.
 */
export function storedTasteKey(value: unknown): TasteDislike | null {
  if (typeof value !== "string") return null;
  if (value.startsWith("t:")) {
    return (SENSORY_TAGS as readonly string[]).includes(value.slice(2)) ? value as TasteDislike : null;
  }
  if (value.startsWith("f:")) {
    // Code points, as the database's char_length counts them. jsonb cannot hold U+0000 or a lone
    // surrogate, so neither can reach the database's check.
    const points = [...value.slice(2)];
    return points.length > 0 && points.length <= FAMILY_MAX && points.every(storableInJsonb)
      ? value as TasteDislike : null;
  }
  return null;
}

/**
 * One dislike key for a NEW client write, or null: a stored key whose family is also already in
 * `baseFoodName` form (the canonical family the phone writes). Stricter than the database.
 */
export function tasteDislike(value: unknown): TasteDislike | null {
  const key = storedTasteKey(value);
  if (!key || key.startsWith("t:")) return key;
  const family = key.slice(2);
  return baseFoodName(family) === family ? key : null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The stored taste, read leniently with the storage contract (`storedTasteKey`): every key the
 * database accepted is kept exactly; only what it could never hold (an unknown tag, a non-string, a
 * repeat, past 50) is dropped. Null when there is no taste object; no dislikes reads as `{}`.
 */
export function tasteFrom(value: unknown): TastePrefs | null {
  if (!isRecord(value)) return null;
  if (!Array.isArray(value.dislikes)) return {};
  const keys = [...new Set(value.dislikes.map(storedTasteKey).filter((key): key is TasteDislike => key !== null))];
  return { dislikes: keys.slice(0, TASTE_DISLIKES_MAX) };
}

/** Strict, for new client writes: the taste exactly as given, or null when any part is invalid. */
export function parseTaste(value: unknown): TastePrefs | null {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "dislikes")) return null;
  if (!("dislikes" in value)) return {};
  const raw = value.dislikes;
  if (!Array.isArray(raw) || raw.length > TASTE_DISLIKES_MAX) return null;
  const keys = raw.map(tasteDislike);
  if (keys.some((key) => key === null) || new Set(keys).size !== keys.length) return null;
  return { dislikes: keys as TasteDislike[] };
}

/** A copy of `taste` safe to store, or undefined when there is nothing valid to keep. */
export function tasteToStore(taste: unknown): TastePrefs | undefined {
  const read = tasteFrom(taste);
  return read ? { ...(read.dislikes ? { dislikes: [...read.dislikes] } : {}) } : undefined;
}
