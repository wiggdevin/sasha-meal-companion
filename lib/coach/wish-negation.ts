/**
 * What a wish says NO to. "Salmon, no banana" and "dinner without chicken" named banana and chicken,
 * and the wish loop added them to the plate (2026-10-03 audit, MAJOR 3): negation was not a stop
 * word, so a refused food read exactly like a requested one.
 *
 * A negator ("no", "without", "not", "minus", "except", "hold the", "skip the") negates the words
 * after it up to the next comma, full stop or positive turn ("with", "but", "and" before a new
 * negator is fine). "dairy-free" negates "dairy". What is left is the wish's positive text.
 *
 * Pure. No I/O.
 */

/** "don't", "do not", "not", with the verb after it ("don't want", "do not add") taken as filler. */
const NEGATED_RUN = /\b(?:(?:don['’]?t|do not|not)(?:\s+(?:want|eat|like|need|add|use|include|put|give me))?|no|without|minus|except|nothing with|hold the|skip the|leave out(?: the)?|avoid)\s+([a-z][a-z\s-]*?)(?=$|[.,;!?)]|\s+(?:with|but|please|thanks|thank you|instead)\b)/gi;
const FREE_OF = /\b([a-z]+)-free\b/gi;
const FILLER = new Set(["a", "an", "the", "any", "some", "more", "or", "and", "nor", "too", "much", "of"]);

export type SplitWish = { positive: string; negated: string[] };

/** The wish with its negated phrases removed, and the food words those phrases refused. */
export function splitWish(wish: string | null | undefined): SplitWish {
  const lower = (wish ?? "").toLowerCase();
  const negated = new Set<string>();
  const keep = (run: string) => {
    for (const word of run.split(/[\s-]+/)) {
      if (word.length > 2 && !FILLER.has(word)) negated.add(word);
    }
  };
  const positive = lower
    .replace(NEGATED_RUN, (_match, run: string) => { keep(run); return " "; })
    .replace(FREE_OF, (_match, word: string) => { keep(word); return " "; })
    .replace(/\s+/g, " ").trim();
  return { positive, negated: [...negated] };
}

/**
 * Singular, so "bananas" refuses "Banana, raw", "eggs" refuses "Eggs, whole", "berries" is "berry"
 * and "tomatoes" is "tomato" (re-audit r2 #2). "apples" is "apple", not "appl"; "bass" and "hummus"
 * keep their s.
 */
export function stem(word: string): string {
  if (word.length <= 3) return word;
  if (word.length > 4 && /[^aeiou]ies$/.test(word)) return word.slice(0, -3) + "y";
  if (/(?:ch|sh|x|z|ss|[^aeiou]o)es$/.test(word)) return word.slice(0, -2);
  return word.replace(/(?<![su])s$/, "");
}

/** Heads that compound into other food words: "no berries" refuses blueberries and strawberries. */
const COMPOUND_HEADS = new Set(["berry"]);

/** Whether a food name is one the wish refused, as a whole word ("rice" never hits "licorice"). */
export function refusedBy(name: string, negated: readonly string[]): boolean {
  if (negated.length === 0) return false;
  const words = name.toLowerCase().split(/[^a-z]+/).filter(Boolean).map(stem);
  return negated.map(stem).some((word) => words.some((own) => own === word
    || (COMPOUND_HEADS.has(word) && own.endsWith(word))));
}
