/**
 * Free-text taste chips (Phase 18 D9 item 3, slice W5b): the fixed Jev question set for a taste text
 * that passed the local safety check (lib/profile/taste-safety.ts), and the reading of Jev's answers
 * into chips the user confirms. Jev only answers fixed yes/no questions over fixed vocabularies; it
 * never writes a rule, a like or a dislike, and every proposal is validated with the same parsers
 * the settings write uses (`tasteDislike`, `parseTaste`, `parseCuisines`) and dropped when invalid.
 *
 *   likes     `f:<family>`   a universe family the text names, in `baseFoodName` form
 *   dislikes  `f:<family>` or `t:<sensory tag>`
 *   cuisines  one of the 12 cuisine keys
 *
 * A chip is suggested at a probability of 0.8 or more (D9). The question ids are positional
 * (`like_0`, `tag_3`, `cuisine_7`) so no account word or stored value is ever a question name.
 *
 * Pure. No I/O. No runtime imports beyond the vocabulary and the question helpers: the payload
 * builder (lib/ai/payloads.ts) imports it, and that module is client-reachable.
 */
import { noul, type NoulQuestion } from "@/lib/ai/jev-types";
import { baseFoodName } from "@/lib/foods/base-name";
import { CUISINE_LABELS, CUISINES, parseCuisines, type CuisineKey } from "@/lib/profile/cuisines";
import { parseTaste, SENSORY_TAGS, tasteDislike, type SensoryTag, type TasteDislike } from "@/lib/profile/taste";
import { normalizeTasteText, type TasteLocalReason } from "@/lib/profile/taste-safety";

export const TASTE_CHIP_THRESHOLD = 0.8;
/** 12 tag + 12 cuisine questions + 2 per family stays within 32 questions. */
export const TASTE_FAMILIES_MAX = 4;

export type TasteChip<K extends string = string> = { key: K; label: string; p: number };
export type TasteChips = {
  likes: TasteChip<`f:${string}`>[];
  dislikes: TasteChip<TasteDislike>[];
  cuisines: TasteChip<CuisineKey>[];
};

/** What the phone does with kept text: the rule editor ("Add this as a food rule?") or plain prefs. */
export type TasteLocalOffer = "rule_editor" | "plain_prefs";

/** The answer to a taste text (`POST /api/profile/prefs` with `{ taste }`). */
export type TasteSuggestion =
  | { route: "local"; reason: TasteLocalReason; offer: TasteLocalOffer }
  | ({ route: "send"; jev: boolean } & TasteChips);

export function localOffer(reason: TasteLocalReason): TasteLocalOffer {
  return reason === "unsure" ? "plain_prefs" : "rule_editor";
}

/** How each tag reads in a question and on a chip. */
export const SENSORY_TAG_TEXT: Readonly<Record<SensoryTag, { question: string; label: string }>> = {
  soft: { question: "soft or mushy in texture", label: "Soft or mushy textures" },
  slimy: { question: "slimy in texture", label: "Slimy textures" },
  spicy_hot: { question: "spicy hot (chili heat)", label: "Spicy heat" },
  strong_fish: { question: "strongly fishy in taste or smell", label: "Strong fishy flavors" },
  bitter: { question: "bitter", label: "Bitter flavors" },
  crunchy: { question: "crunchy", label: "Crunchy textures" },
  chewy: { question: "chewy", label: "Chewy textures" },
  pungent: { question: "pungent or strong-smelling", label: "Pungent smells" },
  sour: { question: "sour", label: "Sour flavors" },
  creamy: { question: "creamy", label: "Creamy textures" },
  gamey: { question: "gamey (a strong wild-meat taste)", label: "Gamey meats" },
  organ_meat: { question: "organ meat, such as liver or kidney", label: "Organ meats" },
};

const CUISINE_HINTS: Partial<Record<CuisineKey, string>> = {
  american: "including Southern, soul food and barbecue",
  latin_american: "including Tex-Mex",
  mediterranean: "including Greek, Turkish, Lebanese and Persian",
  south_asian: "including Pakistani, Bangladeshi and Sri Lankan",
  southeast_asian: "including Thai, Vietnamese, Filipino and Indonesian",
  caribbean: "including Jamaican, Cuban and Puerto Rican",
};

const yesNo = (yes: string, no: string) => ({ yes, no });

/** A family a chip may carry: canonical, short, and one `tasteDislike` accepts as `f:`. */
export function chipFamily(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 80) return null;
  return tasteDislike(`f:${value}`) === null ? null : value;
}

/**
 * The fixed questions for up to four families the text names. Throws on anything that is not a
 * canonical family: the caller passes `matchFamilies` output only.
 */
export function tasteQuestions(families: readonly string[]): Record<string, NoulQuestion> {
  if (families.length > TASTE_FAMILIES_MAX || families.some((family) => chipFamily(family) === null)) {
    throw new Error("taste questions take at most four canonical family names");
  }
  const questions: Record<string, NoulQuestion> = {};
  families.forEach((family, index) => {
    questions[`like_${index}`] = noul(
      `Does state.text say the person likes, loves or enjoys eating state.foods[${index}] ("${family}")?`,
      yesNo("The text states a liking for this food.", "The text states no liking for it, or a dislike."));
    questions[`dislike_${index}`] = noul(
      `Does state.text say the person dislikes, hates or cannot stand eating state.foods[${index}] ("${family}")?`,
      yesNo("The text states a dislike of this food.", "The text states no dislike of it, or a liking."));
  });
  SENSORY_TAGS.forEach((tag, index) => {
    questions[`tag_${index}`] = noul(
      `Does state.text say the person dislikes food that is ${SENSORY_TAG_TEXT[tag].question}?`,
      yesNo("The text states a dislike of food with this quality.",
        "The text states no dislike of this quality, or a liking for it."));
  });
  CUISINES.forEach((cuisine, index) => {
    const hint = CUISINE_HINTS[cuisine];
    questions[`cuisine_${index}`] = noul(
      `Does state.text say the person likes, enjoys or grew up eating ${CUISINE_LABELS[cuisine]} food${hint ? ` (${hint})` : ""}?`,
      yesNo("The text states a liking for, or a background in, this cuisine.",
        "The text says nothing about this cuisine, or states a dislike of it."));
  });
  return questions;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** The words a family may be written as: itself, its parts and their plural or singular forms. */
function phrasesOf(family: string): string[] {
  const inner = /\(([^)]+)\)/.exec(family)?.[1];
  const bases = [family.replace(/\s*\([^)]*\)\s*/g, " ").trim(), ...(inner ? [inner.trim()] : [])]
    .flatMap((phrase) => phrase.split(/\s*\/\s*/)).filter((phrase) => phrase.length > 1);
  return [...new Set(bases.flatMap((phrase) => {
    const forms = [phrase];
    if (/ies$/.test(phrase)) forms.push(phrase.replace(/ies$/, "y"));
    else if (/(o|ch|sh|s|x)es$/.test(phrase)) forms.push(phrase.replace(/es$/, ""));
    else if (/s$/.test(phrase)) forms.push(phrase.slice(0, -1));
    else if (/y$/.test(phrase)) forms.push(`${phrase.slice(0, -1)}ies`);
    else if (/(o|ch|sh|x)$/.test(phrase)) forms.push(`${phrase}es`, `${phrase}s`);
    else forms.push(`${phrase}s`);
    return forms;
  }))];
}

/**
 * The families the text names, at most four, longest match first ("sweet potatoes" is the sweet
 * potato family, not potato), in the order the text names them. Only names from `families` (the
 * server's universe family list) can come back.
 */
export function matchFamilies(text: string, families: readonly string[]): string[] {
  const norm = normalizeTasteText(text);
  const hits: { family: string; start: number; end: number }[] = [];
  for (const family of families) {
    if (chipFamily(family) === null) continue;
    for (const phrase of phrasesOf(family)) {
      const found = new RegExp(`(?<![a-z])${escape(phrase)}(?![a-z])`).exec(norm);
      if (found) hits.push({ family, start: found.index, end: found.index + phrase.length });
    }
  }
  hits.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);
  const kept: typeof hits = [];
  for (const hit of hits) {
    if (kept.some((k) => k.family === hit.family || (hit.start < k.end && k.start < hit.end))) continue;
    kept.push(hit);
  }
  return kept.sort((a, b) => a.start - b.start).slice(0, TASTE_FAMILIES_MAX).map((hit) => hit.family);
}

type NoulAnswers = Readonly<Record<string, { noul: number } | undefined>>;

const byP = <T extends { p: number }>(a: T, b: T) => b.p - a.p;

/**
 * Jev's answers as chips: each at 0.8 or more, validated with the settings parsers; a family both
 * liked and disliked is dropped from both; at most six cuisines (the stored cap).
 */
export function tasteChipsFromAnswers(families: readonly string[], answers: NoulAnswers): TasteChips {
  const p = (id: string) => {
    const value = answers[id]?.noul;
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0;
  };
  const likes: TasteChips["likes"] = [];
  const dislikes: TasteChips["dislikes"] = [];
  families.slice(0, TASTE_FAMILIES_MAX).forEach((raw, index) => {
    const family = chipFamily(raw);
    if (family === null || baseFoodName(family) !== family) return;
    const [like, dislike] = [p(`like_${index}`), p(`dislike_${index}`)];
    const liked = like >= TASTE_CHIP_THRESHOLD;
    const disliked = dislike >= TASTE_CHIP_THRESHOLD;
    if (liked && disliked) return;
    if (liked) likes.push({ key: `f:${family}`, label: family, p: like });
    if (disliked) dislikes.push({ key: `f:${family}` as TasteDislike, label: family, p: dislike });
  });
  SENSORY_TAGS.forEach((tag, index) => {
    const value = p(`tag_${index}`);
    if (value >= TASTE_CHIP_THRESHOLD) dislikes.push({ key: `t:${tag}`, label: SENSORY_TAG_TEXT[tag].label, p: value });
  });
  const cuisines = CUISINES.flatMap((cuisine, index): TasteChip<CuisineKey>[] => {
    const value = p(`cuisine_${index}`);
    return value >= TASTE_CHIP_THRESHOLD ? [{ key: cuisine, label: CUISINE_LABELS[cuisine], p: value }] : [];
  }).sort(byP).slice(0, 6);
  const validDislikes = parseTaste({ dislikes: dislikes.map((chip) => chip.key) }) ? dislikes : [];
  const validCuisines = parseCuisines(cuisines.map((chip) => chip.key)) ? cuisines : [];
  return { likes: likes.sort(byP), dislikes: validDislikes.sort(byP), cuisines: validCuisines };
}
