/**
 * The grounding steps several action kinds share: one named food, one item with grams, a list of
 * items, and the clarifications each can turn into. Moved verbatim out of lib/coach/ground.ts,
 * which now only runs the batch.
 *
 * A missing food ref drops its whole action. A BLOCKED food stays and is marked — logging marks,
 * it never refuses (ruling 2026-09-14).
 *
 * Pure. No I/O, no Supabase import: the reads arrive as injected ports.
 */

import type { FoodHit } from "@/lib/coach/executors";
import { sanitizeText } from "@/lib/coach/envelope";
import { checkItemWithMarks, allergenFacts } from "@/lib/coach/policy";
import type { ConstraintProfile } from "@/lib/policy/constraints";
import type { GroundedActionItem, GroundedNamedFood } from "@/lib/coach/actions/fields";
import type { GroundActionPorts, GroundKit, GroundOutcome } from "@/lib/coach/actions/spec";
import { portionBand, sidePartOf } from "@/lib/coach/portion-bands";

export const clarify = <A>(...text: string[]): GroundOutcome<A> => ({ clarifications: text });
export const act = <A>(build: (actionId: string) => A): GroundOutcome<A> =>
  ({ clarifications: [], action: build });

export async function groundNamedFood(
  userId: string,
  name: string,
  itemGrams: number | null,
  profile: ConstraintProfile,
  ports: GroundActionPorts,
  known?: FoodHit,
): Promise<GroundedNamedFood | null> {
  const hit = known ?? (await ports.searchFoods(userId, name, 1))[0];
  if (!hit || hit.foodRefId === null) return null;
  const verdict = checkItemWithMarks({
    foodRefId: hit.foodRefId, name, grams: itemGrams,
    allergenTags: hit.allergenTags ?? null, ...allergenFacts(hit), category: hit.category ?? null,
    onEatsList: hit.prefStatus === "eats", onAvoidList: hit.prefStatus === "avoid",
  }, profile);
  return {
    name, foodRefId: hit.foodRefId,
    catalogFoodRevisionId: hit.catalogFoodRevisionId ?? null,
    kcalPer100g: hit.kcalPer100g,
    proteinPer100g: hit.proteinPer100g ?? null,
    carbsPer100g: hit.carbsPer100g ?? null,
    fatPer100g: hit.fatPer100g ?? null,
    verdict: verdict.verdict,
    // What left it unverified, so the card can tell an allergen gap from any other (sol FIX, t2b).
    ...("marks" in verdict ? { marks: verdict.marks } : {}),
  };
}

/** Grounding an item found no usable food: the caller asks what it is. */
const NOT_FOUND = { notFound: true } as const;

/**
 * One item of an action. `grams` may be absent for a `set_slot_meal` item: the catalog's default
 * household portion is the quantity then, and a food whose row has no portion takes the usual
 * serving for its kind (`usualServing`). A plan change never stops on "How much?" (live pass
 * 2026-10-17: "Change next Tuesday's lunch to grilled chicken and rice" came back as "How much
 * chicken breast, roasted? How much rice, white, cooked?"); the card shows the grams to correct.
 */
async function groundItem(
  userId: string,
  item: { name: string; grams?: number },
  profile: ConstraintProfile,
  ports: GroundActionPorts,
): Promise<GroundedActionItem | { question: string } | typeof NOT_FOUND> {
  // With no quantity given, look past the top hit for one that HAS a household portion: half the
  // catalog's yogurt rows carry none, and taking the first of those turned "change my 4th meal to
  // beef jerky and a Chobani yogurt" into a question about grams (measured 2026-09-18).
  const hits = await ports.searchFoods(userId, item.name, item.grams === undefined ? 3 : 1);
  const usable = hits.filter((row) => row.foodRefId !== null);
  const hit = item.grams === undefined
    ? usable.find((row) => (row.portionGrams ?? 0) > 0) ?? usable[0]
    : usable[0];
  if (!hit || hit.foodRefId === null) return NOT_FOUND;
  const portion = hit.portionGrams ?? null;
  const itemGrams = item.grams ?? (portion !== null && portion > 0 ? portion : usualServing(hit));
  const implausible = concentrateQuestion(hit, itemGrams);
  if (implausible) return { question: implausible };
  const grounded = await groundNamedFood(userId, item.name, itemGrams, profile, ports, hit);
  return grounded ? { ...grounded, grams: itemGrams } : NOT_FOUND;
}

/** The most energy a usual-serving guess may carry: a 150 g guess of oil or candy is not usual. */
const USUAL_SERVING_MAX_KCAL = 400;

/**
 * The usual serving of a food whose catalog row has no household portion: the typical amount of
 * its portion band (`lib/coach/portion-bands.ts`), read by its side role and otherwise as a main
 * protein, capped at USUAL_SERVING_MAX_KCAL and rounded to the band's step.
 */
export function usualServing(hit: Pick<FoodHit, "name" | "kcalPer100g">): number {
  const band = portionBand(hit.name, sidePartOf(hit.name) ?? "anchor");
  const kcal = hit.kcalPer100g ?? 0;
  const cap = kcal > 0 ? (USUAL_SERVING_MAX_KCAL * 100) / kcal : Infinity;
  const grams = Math.min(band.typical, cap);
  return Math.max(band.step, Math.round(grams / band.step) * band.step);
}

/** A catalog row that is a dry concentrate: a drink-sized amount of it is not a drink. */
const CONCENTRATE = /\b(powder|mix|dried|dry|concentrate|instant)\b/i;
const CONCENTRATE_PORTIONS = 5;

/**
 * A trailing number with nothing after it — never a real unit word before it — is catalog junk,
 * not part of the label: production (2026-09-24) carried a row whose portionLabel was
 * "1 tablespoon 21000", and that id-looking tail went straight into the clarifying question
 * ("...is 6 portions of 1 tablespoon 21000 (10 g)"). sanitizeText alone does not touch digits.
 */
const TRAILING_JUNK_NUMBER = /\s+\d{3,}\s*$/;

/** The portion label a clarifying question may show, or null when nothing usable survives —
 *  a label that is nothing but digits (no unit word at all) is the same catalog junk, just
 *  without anything in front of it to leave behind. */
function sanitizePortionLabel(label: string | null | undefined): string | null {
  if (!label) return null;
  const cleaned = sanitizeText(label).replace(TRAILING_JUNK_NUMBER, "").trim();
  return cleaned.length > 0 && !/^\d+$/.test(cleaned) ? cleaned : null;
}

/**
 * "Protein shake" 300 g matched a shake POWDER and became a 1176 kcal meal (2026-09-22): the model
 * named a dish, the catalog answered with its concentrate, and the grams belonged to the dish. When a
 * concentrate is given more than CONCENTRATE_PORTIONS of its own household portion, the amount is a
 * question, never a plan.
 */
function concentrateQuestion(hit: FoodHit, grams: number): string | null {
  const portion = hit.portionGrams ?? 0;
  if (portion <= 0 || !CONCENTRATE.test(hit.name)) return null;
  if (grams <= portion * CONCENTRATE_PORTIONS) return null;
  const portions = Math.round(grams / portion);
  const cleanLabel = sanitizePortionLabel(hit.portionLabel);
  const label = cleanLabel ? `${cleanLabel} (${portion} g)` : `${portion} g`;
  return `${grams} g of ${sanitizeText(hit.name)} is ${portions} portions of ${label} — how much of it, `
    + "or which ingredients make the shake?";
}

export function clarification(name: string): string {
  return `I could not find "${sanitizeText(name)}" — what should I log it as?`;
}

export function flagged(items: GroundedNamedFood[]): string[] {
  return items.filter((item) => item.verdict === "blocked").map((item) => item.name);
}

/**
 * Every item of an action, grounded together. Settled, like the actions themselves: a failing item
 * is reported in item order, and only once every item's search has finished (review r2).
 */
export async function groundItems(
  kit: GroundKit,
  sourceItems: { name: string; grams?: number }[],
): Promise<{ items: GroundedActionItem[] } | { missing: string[] }> {
  const grounded = (await Promise.allSettled(sourceItems.map(
    (item) => groundItem(kit.userId, item, kit.profile, kit.ports)))).map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
  const missing = grounded.flatMap((item, index) => {
    if ("notFound" in item) return [clarification(sourceItems[index].name)];
    return "question" in item ? [item.question] : [];
  });
  if (missing.length > 0) return { missing };
  return { items: grounded as GroundedActionItem[] };
}

/** An action that takes no grounding: it passes through with its id and no marks. */
export function passThrough<I extends object>(input: I) {
  return act((actionId) => ({ ...input, actionId, flagged: [] as string[] }));
}

/** The entry an action names, which must be one the user actually has (T6 §3). */
export async function knownEntry(kit: GroundKit, entryId: string):
  Promise<{ what: string } | { clarification: string }> {
  const entries = kit.knownEntries();
  if (entries === null) {
    // No list to check against is NOT "the user has no entries": say so rather than deny one the user
    // really has (Grok pass 1, HIGH 6).
    return { clarification: "I could not check your entries just now — try that again in a moment." };
  }
  const what = (await entries).get(entryId);
  if (what === undefined) return { clarification: "I could not find that entry — which one do you mean?" };
  return { what };
}
