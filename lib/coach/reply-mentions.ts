/**
 * Phase 13 §6 row 5, §9 R7: which foods a coach reply's prose names — the pure half of the reply
 * check (lib/server/reply-check.ts does the I/O).
 *
 * Two sources, in the order the check trusts them:
 *
 * 1. `lexiconMentions` — a deterministic food lexicon (the head names of lib/food-db.json, the
 *    ~430 common foods the app ships, plus a few generic food nouns). A lexicon hit IS a food
 *    name, so it is never capped and never optional: the check must resolve every one of them to
 *    a checked catalog id, or (with an active hard rule) the reply is replaced with a re-ask.
 * 2. `candidatePhrases` — a bounded best-effort sweep of the remaining 1–3 word phrases, for a
 *    food the lexicon does not carry. A sweep phrase counts as a food only when the catalog's own
 *    hit is named by it (`hitNamesPhrase`), so ordinary prose never reads as a food mention.
 *
 * Pure: no I/O.
 */
import raw from "@/lib/food-db.json";

/** The most best-effort sweep phrases one reply pays catalog searches for. */
export const MAX_SWEEP_CANDIDATES = 6;
const MIN_WORD_LENGTH = 3;

// Common English words a food name is never made of alone. Not a food dictionary — a filter that
// keeps ordinary coach prose from reaching the catalog search at all.
const STOPWORDS = new Set([
  "the", "and", "for", "you", "your", "with", "that", "this", "have", "has", "had", "are", "is",
  "was", "were", "will", "would", "could", "should", "can", "today", "about", "some", "more",
  "than", "then", "just", "like", "get", "got", "into", "onto", "from", "when", "what", "how",
  "why", "who", "let", "know", "want", "need", "feel", "feeling", "great", "good", "nice", "try",
  "trying", "meal", "day", "days", "plan", "planned", "still", "also", "any", "other", "one",
  "two", "three", "much", "many", "lot", "lots", "each", "every", "next", "over", "under", "out",
  "sounds", "sound", "look", "looks", "looking", "add", "added", "keep", "keeping", "here", "there",
  "water", "dates", "orange",
]);

// Lexicon heads that are also ordinary English words in coach prose ("drink water", "on those
// dates"): left out, so the check never re-asks over a word that was not a food.
const AMBIGUOUS_HEADS = new Set(["water", "dates", "orange"]);

// Generic food nouns the common-foods table only carries qualified ("Chicken breast, roasted").
const GENERIC_FOODS = [
  "chicken", "beef", "pork", "lamb", "turkey", "rice", "pasta", "noodles", "bread", "toast",
  "cheese", "milk", "oats", "beans", "steak", "sausage", "fish", "nuts", "cereal", "cilantro",
];

/** Lower-cased, accents folded, anything but letters, apostrophes and hyphens read as a space. */
export function normalizeFoodText(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z'\s-]/g, " ").replace(/\s+/g, " ").trim();
}

function words(text: string): string[] {
  return normalizeFoodText(text).match(/[a-z][a-z'-]*/g) ?? [];
}

/** The plural/singular spellings one name is written with in prose. */
function spellings(name: string): string[] {
  const out = [name, `${name}s`, `${name}es`];
  if (name.endsWith("ies")) out.push(`${name.slice(0, -3)}y`);
  if (name.endsWith("es")) out.push(name.slice(0, -2));
  if (name.endsWith("s")) out.push(name.slice(0, -1));
  if (name.endsWith("y")) out.push(`${name.slice(0, -1)}ies`);
  return out;
}

let lexicon: Map<string, string> | null = null;

/** Every spelling → its canonical lexicon name. Built once, on first use. */
function lexiconForms(): Map<string, string> {
  if (lexicon) return lexicon;
  const heads = (raw as { name: string }[]).map((food) => normalizeFoodText(food.name.split(",")[0]));
  const forms = new Map<string, string>();
  for (const name of [...heads, ...GENERIC_FOODS]) {
    const clean = name.split(" ").filter((w) => w.length >= 2).join(" ");
    if (clean.length < MIN_WORD_LENGTH || AMBIGUOUS_HEADS.has(clean)) continue;
    for (const form of spellings(clean)) if (!forms.has(form)) forms.set(form, clean);
  }
  lexicon = forms;
  return forms;
}

/**
 * Every lexicon food the text names, longest match first ("chicken breast" wins over "chicken"),
 * as canonical names, each once. Uncapped on purpose: a lexicon hit is a food name.
 */
export function lexiconMentions(text: string): string[] {
  const forms = lexiconForms();
  const tokens = words(text);
  const used = new Array<boolean>(tokens.length).fill(false);
  const found = new Set<string>();
  for (let n = 3; n >= 1; n--) {
    for (let i = 0; i + n <= tokens.length; i++) {
      if (used.slice(i, i + n).some(Boolean)) continue;
      const canonical = forms.get(tokens.slice(i, i + n).join(" "));
      if (!canonical) continue;
      found.add(canonical);
      used.fill(true, i, i + n);
    }
  }
  return [...found];
}

/** Whether `phrase` (or any spelling of it) is one of `names`. */
export function namesAny(phrase: string, names: ReadonlySet<string>): boolean {
  return spellings(phrase).some((form) => names.has(form));
}

/**
 * 1–3 word phrases for the best-effort sweep, minus anything in `exclude` (a suggestion name, a
 * name the turn already has evidence for, a lexicon mention) and minus phrases made only of
 * stopwords or short words. Capped at MAX_SWEEP_CANDIDATES.
 */
export function candidatePhrases(text: string, exclude: ReadonlySet<string>): string[] {
  const tokens = words(text);
  const seen = new Set<string>();
  const out: string[] = [];
  for (let n = 1; n <= 3 && out.length < MAX_SWEEP_CANDIDATES; n++) {
    for (let i = 0; i + n <= tokens.length && out.length < MAX_SWEEP_CANDIDATES; i++) {
      const gram = tokens.slice(i, i + n);
      if (gram.some((w) => w.length < MIN_WORD_LENGTH)) continue;
      if (gram.every((w) => STOPWORDS.has(w))) continue;
      const phrase = gram.join(" ");
      if (seen.has(phrase) || gram.some((w) => namesAny(w, exclude)) || namesAny(phrase, exclude)) {
        continue;
      }
      seen.add(phrase);
      out.push(phrase);
    }
  }
  return out;
}

/**
 * Whether a catalog hit's name is the food `phrase` names: the whole name, or its head — catalog
 * rows write the food first and qualifiers after the first comma ("Salmon, Atlantic, farmed,
 * cooked" is salmon) — in any plural/singular spelling. "Breakfast burrito" is not "breakfast".
 */
export function hitNamesPhrase(hitName: string, phrase: string): boolean {
  const forms = new Set(spellings(normalizeFoodText(phrase)));
  return forms.has(normalizeFoodText(hitName)) || forms.has(normalizeFoodText(hitName.split(",")[0]));
}
