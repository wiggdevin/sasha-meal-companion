/**
 * The draft, assembled (spec §7). A blocked or ungrounded item stays in the list: the sheet shows
 * them everything the model said and marks what we could not stand behind. Nothing here writes.
 *
 * Pure. No I/O.
 */

import type { DraftItem, ProposeResponse } from "@/lib/capture/types";
import type { PolicyVerdict } from "@/lib/policy/constraints";
import type { DeterministicSanity } from "@/lib/log/sanity-types";
import { attachDeterministicSanity } from "@/lib/server/coach-sanity";

export type ModelItems = {
  items: {
    label: string; grams: number; qty: number; unit: string; confidence: number; brand?: string;
  }[];
  notes: string[];
};

export type GroundedItem = {
  foodRefId: string | null; catalogFoodRevisionId: number | null;
  grams: number; portionId: number | null;
  alternatives: DraftItem["alternatives"]; autoResolved: boolean;
};

export type DraftContext = {
  draftId: string; method: ProposeResponse["method"];
  spend: { usedToday: number; softCap: number };
  notes?: string[]; labelFood?: ProposeResponse["labelFood"];
  timings?: ProposeResponse["timings"];
};

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/**
 * A scanned label's printed ingredients, matched against their three allergens (spec AC9). `null`
 * means no evidence either way (no ingredients text); an empty list means text was read but named
 * none of them. Conservative on purpose: a keyword must appear as a whole word, so "pineapple" does
 * not trip "apple" and "buttermilk" only trips "milk" via its own word split, not a partial string.
 */
const ALLERGEN_KEYWORDS: [string, string[]][] = [
  ["gluten", ["wheat", "barley", "rye", "spelt", "gluten", "malt", "semolina", "farro", "couscous", "seitan"]],
  ["dairy", ["milk", "cheese", "butter", "cream", "whey", "casein", "caseinate", "butterfat", "yogurt", "yoghurt", "lactose", "ghee", "kefir"]],
  ["apple", ["apple", "apples"]],
];

export function allergenTagsFromIngredients(text: string | undefined | null): string[] | null {
  if (!text || text.trim().length === 0) return null;
  const lower = text.toLowerCase();
  const tags: string[] = [];
  for (const [tag, keywords] of ALLERGEN_KEYWORDS) {
    if (keywords.some((word) => new RegExp(`\\b${word}\\b`).test(lower))) tags.push(tag);
  }
  return tags;
}

export function buildDraft(
  parsed: ModelItems, grounded: GroundedItem[], policy: PolicyVerdict[], ctx: DraftContext,
  runDeterministic: DeterministicSanity,
): ProposeResponse {
  const items: DraftItem[] = parsed.items.map((item, seq) => ({
    seq,
    label: item.label,
    foodRefId: grounded[seq]?.foodRefId ?? null,
    catalogFoodRevisionId: grounded[seq]?.catalogFoodRevisionId ?? null,
    grams: grounded[seq]?.grams ?? item.grams,
    qty: item.qty,
    unit: item.unit,
    portionId: grounded[seq]?.portionId ?? null,
    confidence: clamp01(item.confidence),
    policy: policy[seq] ?? { verdict: "unverified" },
    alternatives: grounded[seq]?.alternatives ?? [],
    autoResolved: grounded[seq]?.autoResolved ?? false,
  }));
  return attachDeterministicSanity({
    draftId: ctx.draftId,
    method: ctx.method,
    items,
    ...(ctx.labelFood ? { labelFood: ctx.labelFood } : {}),
    notes: [...parsed.notes, ...(ctx.notes ?? [])],
    spend: ctx.spend,
    ...(ctx.timings ? { timings: ctx.timings } : {}),
  }, { deterministic: runDeterministic });
}
