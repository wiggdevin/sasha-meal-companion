/**
 * Phase 13 §9 R1: "Unspecified tuna is unverified for the pregnancy profile."
 *
 * Not an allergen (no immune reaction) and not routed through lib/policy/condition-rules.ts's
 * empty, facet-driven table either: that table is for a diagnosis triggering a facet-based
 * warning, and stays empty until a rule has nutritionist-approved copy, applicability boundaries
 * and a labelled facet evaluation (§7, slice 3). This is one literal, spec-mandated exception
 * with fixed wording and no facet involved, so it lives beside allergen evidence and is wired
 * into lib/policy/constraints.ts's own findings list.
 *
 * Mercury varies by species: canned "light"/skipjack/yellowfin/tongol reads low; "white"/
 * albacore/bigeye/bluefin reads high (FDA/EPA fish-consumption advice). A label that just says
 * "tuna" with no species word could be either, so it stays unverified rather than guessed.
 */
import type { AllergenFinding } from "@/lib/policy/allergens";

// sol finding (FIX, review round 2): `conditions` is a free-text field
// (constraint_profiles.conditions) — a real account describing pregnancy as "expecting" (a
// common, ordinary way to say it) matched neither this word nor any allergen rule, so unspecified
// tuna read as fine rather than unverified. "expecting" alone.
const PREGNANCY = /\bpregnan(?:t|cy)\b|\bexpecting\b/i;

const SPECIES_WORDS = [
  "skipjack", "light", "chunk light", "yellowfin", "ahi", "tongol",
  "albacore", "white", "bigeye", "bluefin",
];

/** Whole-word "tuna", the same boundary rule lib/policy/allergens.ts's textNames uses. */
function namesTuna(text: string): boolean {
  return /(^|[^a-z])tuna([^a-z]|$)/i.test(text);
}

const escapeWord = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whole-word match for one species phrase, directly touching an actual mention of "tuna" —
 * the same boundary rule `namesTuna`/`textNames` use, plus adjacency.
 *
 * ORCHESTRATOR fix (round 7): a plain `.includes("ahi")` matched the species word "ahi" INSIDE
 * "mahi" — "Tuna and mahi mahi" (mahi-mahi is a different fish, not tuna at all) then read as
 * species-specified and cleared the pregnancy check, even though no species of TUNA was actually
 * named. Word-boundary matching closes that: "ahi" only matches a standalone "ahi", never the
 * tail of "mahi".
 *
 * sol BLOCK (review round 2): a word-boundary match alone still matched a species word ANYWHERE
 * in the text, including one naming an entirely different fish — "Tuna and yellowfin sole" has no
 * tuna species named at all ("yellowfin" describes the sole, not the tuna), but the bare
 * word-boundary check cleared the pregnancy finding anyway. The species word must sit directly
 * beside an actual "tuna" mention (the ordinary "SPECIES tuna" label phrasing, or its reverse) to
 * count as specifying that tuna's species.
 */
function namesSpecies(text: string, word: string): boolean {
  const w = escapeWord(word);
  return new RegExp(`(^|[^a-z])${w}\\s+tuna([^a-z]|$)|(^|[^a-z])tuna\\s+${w}([^a-z]|$)`, "i")
    .test(text);
}

/**
 * The free-text conditions name pregnancy, or the account holds the `pregnancy` dietary profile
 * (onboarding v2 G7: the life-stage profile alone did not arm this check). `profileIds` is the
 * account's profile-instance ids where the caller read them (lib/server/policy-profile.ts).
 */
export function isPregnant(
  conditions: readonly string[] | undefined, profileIds?: readonly string[] | null,
): boolean {
  return (profileIds ?? []).includes("pregnancy")
    || (conditions ?? []).some((condition) => PREGNANCY.test(condition));
}

/**
 * True when the food names tuna — in its ingredient text, a legacy tag, OR ITS OWN NAME — with no
 * species word anywhere in those three to say which kind.
 *
 * finding #8: the rule used to check only `text` and `tags`, never the food's own name. A product
 * named "Canned tuna" whose ingredient text just says "Water, salt" (the brine, not the fish
 * itself — plenty of real labels read exactly this way) and carries no tuna tag named no tuna at
 * all, so the pregnancy check never ran and the product could read allowed. The name is checked
 * with the same whole-word boundary and the same species-word exemption as the ingredient text.
 *
 * BLOCK (review round 1, phase 13 slice 2): `text` and `name` are independently authored fields —
 * an ordinary ingredient that merely ENDS `text` (e.g. "egg white") and a product name that
 * merely STARTS with "tuna" (e.g. "Tuna Casserole") are unrelated, but joining them with a single
 * space into one `combined` string for `namesSpecies` made the two fields' edges read as adjacent
 * ("white tuna"), falsely specifying the species and fail-open clearing the mercury warning. Each
 * field is now checked for a species word on its own — a species word must sit beside tuna WITHIN
 * one field, never merely across the join.
 */
export function namesUnspecifiedTuna(
  text: string | null | undefined, tags?: readonly string[] | null, name?: string | null,
): boolean {
  const lower = (text ?? "").toLowerCase();
  const nameLower = (name ?? "").toLowerCase();
  const tagged = (tags ?? []).some((tag) => tag.toLowerCase().trim() === "tuna");
  if (!tagged && !namesTuna(lower) && !namesTuna(nameLower)) return false;
  return !SPECIES_WORDS.some((word) => namesSpecies(lower, word) || namesSpecies(nameLower, word));
}

/** The card's line for unspecified tuna on a pregnancy profile, or null when it does not apply. */
export function pregnancyTunaFinding(input: {
  conditions: readonly string[] | undefined;
  profileIds?: readonly string[] | null;
  ingredientsText: string | null | undefined;
  tags?: readonly string[] | null;
  foodName?: string | null;
}): AllergenFinding | null {
  if (!isPregnant(input.conditions, input.profileIds)) return null;
  if (!namesUnspecifiedTuna(input.ingredientsText, input.tags, input.foodName)) return null;
  return {
    allergen: "tuna_mercury",
    outcome: "unknown",
    checkable: false,
    text: "Unspecified tuna — mercury varies by species. Check the label for the kind, or ask "
      + "your clinician about mercury limits during pregnancy.",
  };
}
