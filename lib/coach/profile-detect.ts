/**
 * Phase 13 slice 4 (§4 "Detecting profiles in the user's words is not Jev"): the deterministic
 * half of detection — a synonym match against the catalog's own `synonyms` strings, nothing
 * inferred. Audit round 1 finding 7's resolution ("trigger categories not representable") is the
 * whole design here: a candidate is only ever a concrete profile id the sentence named in the
 * catalog's own words, never a category this module guesses at. Pure: no I/O, no model call —
 * safe to run on every turn's raw text.
 *
 * Reads lib/coach/profile-synonyms.generated.ts (id + synonyms only) rather than the full catalog
 * (lib/policy/profiles/catalog-summary.ts): that module's build-time schema validation is real
 * work this file's own header explains, and it belongs on the rarer path
 * (lib/coach/profile-propose.ts) that only runs once this module already found a candidate.
 *
 * Plain `indexOf` plus a manual boundary check, not one RegExp per synonym: V8 compiles each
 * distinct pattern's bytecode lazily, on its own first use, so ~500 unicode-property patterns
 * (`\p{L}\p{N}`, the "u" flag) cost real time exactly where this module cannot afford it — inline
 * in a coach turn (§7 gate). A boundary is a non-word character or a string edge; apostrophes and
 * hyphens count as word characters so "pescetarian's" and "plant-based" still bound correctly.
 */
import { PROFILE_SYNONYMS } from "@/lib/coach/profile-synonyms.generated";

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

const WORD_CHAR = /[a-z0-9'-]/;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR.test(ch);
}

/** True when `needle` appears in `haystack` as a whole phrase — never inside a longer word. */
function containsPhrase(haystack: string, needle: string): boolean {
  if (needle.length === 0) return false;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return false;
    if (!isWordChar(haystack[at - 1]) && !isWordChar(haystack[at + needle.length])) return true;
    from = at + 1;
  }
}

type NormalizedProfile = { id: string; synonyms: readonly string[] };

/** Every profile's synonyms, lower-cased and whitespace-collapsed once at module load, so
 *  detection never re-normalizes the same ~500 strings on every call. */
const NORMALIZED_PROFILES: readonly NormalizedProfile[] = PROFILE_SYNONYMS.map((profile) => ({
  id: profile.id,
  synonyms: profile.synonyms.map(normalize).filter((synonym) => synonym.length > 0),
}));

/**
 * Every profile id whose own catalog synonym appears in `text`, in catalog order, each id at most
 * once. An empty or synonym-free message returns an empty list — never a guess.
 */
export function detectProfileCandidates(text: string): string[] {
  const haystack = ` ${normalize(text)} `;
  if (haystack.trim().length === 0) return [];
  const found: string[] = [];
  for (const profile of NORMALIZED_PROFILES) {
    if (profile.synonyms.some((synonym) => containsPhrase(haystack, synonym))) {
      found.push(profile.id);
    }
  }
  return found;
}
