/**
 * The fixed W1c pair list (Phase 18 D9 item 2, slice W1c): every anchor family × side universe food
 * × meal template, each with its stated occasion and its curated Phase 17 score `B`, plus plate
 * patterns (an anchor with two sides) and the cuisine-balanced human holdout candidates.
 * Deterministic: the same universe and curated tables give the same list in the same order.
 * Offline build only.
 *
 *   anchor family  a curated family (lib/meals/data/pairings.ts, cuisine.ts) that at least one
 *                  universe anchor food belongs to; its first such food (universe order) is the
 *                  representative whose catalog name Jev and the human labeller read.
 *   side           a countable universe food with a side part the template allows, not of the
 *                  anchor's own family.
 *   B              lib/meals/affinity.ts `pairScore` for the side's first allowed part.
 */
import { sha256Hex } from "@/lib/foods/sha256";
import { deriveItem, type UniverseItem } from "@/lib/foods/universe/derive";
import { UNIVERSE } from "@/lib/foods/universe/manifest";
import { CUISINES, type CuisineKey } from "@/lib/foods/universe/vocabulary";
import { PAIR_OCCASIONS, type PairItem } from "@/lib/foods/pairing/questions";
import {
  PAIR_FLOOR, PAIR_TEMPLATES, pairKey, TEMPLATE_SIDE_PARTS, type CuratedPair, type SidePart,
} from "@/lib/foods/pairing/table";
import { pairScore } from "@/lib/meals/affinity";
import { mealFamily } from "@/lib/meals/parts";
import type { TemplateKey } from "@/lib/meals/templates";
import { prng } from "@/scripts/priors/metrics";

export type FixedPair = CuratedPair & {
  id: string;
  anchorName: string;
  sideName: string;
  occasion: PairItem["occasion"];
  /** Cuisine packs that name the side or the anchor's representative food. */
  cuisines: CuisineKey[];
};

export type Family = { key: string; representative: UniverseItem; members: string[] };

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
export const pairId = (anchor: string, side: string, template: TemplateKey) => `${slug(anchor)}__${side}__${template}`;

export function universeItems(): UniverseItem[] {
  return UNIVERSE.map(deriveItem).filter((item): item is UniverseItem => item !== null);
}

export function anchorFamilies(items: readonly UniverseItem[]): Family[] {
  const out = new Map<string, Family>();
  for (const item of items) {
    const family = item.parts.includes("anchor") ? mealFamily(item.food.name) : null;
    if (!family) continue;
    const found = out.get(family.key);
    if (found) found.members.push(item.entry.id);
    else out.set(family.key, { key: family.key, representative: item, members: [item.entry.id] });
  }
  return [...out.values()];
}

const cuisinesOf = (...items: UniverseItem[]) =>
  CUISINES.filter((cuisine) => items.some((item) => item.entry.tiers[cuisine] !== undefined));

export function fixedPairs(items: readonly UniverseItem[] = universeItems()): FixedPair[] {
  const families = anchorFamilies(items);
  const out: FixedPair[] = [];
  for (const family of families) {
    const anchor = family.representative;
    for (const template of PAIR_TEMPLATES) {
      for (const side of items) {
        if (!side.entry.countable || mealFamily(side.food.name)?.key === family.key) continue;
        const part = side.parts.find((p): p is SidePart => (TEMPLATE_SIDE_PARTS[template] as readonly string[]).includes(p));
        if (!part) continue;
        const occasion = PAIR_OCCASIONS[template];
        const b = pairScore(anchor.food, side.food, part, template, template === "main" ? "dinner" : template).score;
        out.push({ id: pairId(family.key, side.entry.id, template), anchor: family.key, side: side.entry.id, template, part, b,
          anchorName: anchor.food.name, sideName: side.food.name, occasion, cuisines: cuisinesOf(side, anchor) });
      }
    }
  }
  return out;
}

/** sha256 of the curated scores, so the manifest pins the B values the table was built on. */
export function curatedHash(pairs: readonly FixedPair[]): string {
  return sha256Hex(pairs.map((pair) => `${pairKey(pair.anchor, pair.side, pair.template)}=${pair.b}`).join("\n"));
}

export type PlatePattern = PairItem & { anchorFamily: string; template: TemplateKey; kind: "usual" | "unusual" };

const PLATE_PARTS: Readonly<Record<TemplateKey, readonly SidePart[]>> = {
  breakfast: ["starch", "fruit"], main: ["starch", "veg"], snack: ["fruit"],
};

/**
 * Per family and template: the usual plate (the highest-B side per part) and the unusual plate (the
 * lowest-B side per part). Labels only; they never enter the table (they feed the W10 short-list
 * checks and the implausible-plate rate of the §5 gate).
 */
export function platePatterns(pairs: readonly FixedPair[]): PlatePattern[] {
  const out: PlatePattern[] = [];
  const keys = [...new Set(pairs.map((pair) => `${pair.anchor}|${pair.template}`))];
  for (const key of keys) {
    const [anchor, template] = key.split("|") as [string, TemplateKey];
    const own = pairs.filter((pair) => pair.anchor === anchor && pair.template === template);
    for (const kind of ["usual", "unusual"] as const) {
      const sides = PLATE_PARTS[template].map((part) => {
        const candidates = own.filter((pair) => pair.part === part);
        return [...candidates].sort((a, b) => (kind === "usual" ? b.b - a.b : a.b - b.b))[0];
      }).filter((pair): pair is FixedPair => pair !== undefined);
      if (sides.length !== PLATE_PARTS[template].length) continue;
      const names = sides.map((pair) => pair.sideName);
      if (kind === "unusual" && out.some((plate) => plate.anchorFamily === anchor && plate.template === template
        && plate.sides.join("|") === names.join("|"))) continue;
      out.push({ id: `plate__${slug(anchor)}__${template}__${kind}`, anchor: own[0].anchorName, anchorFamily: anchor,
        sides: names, occasion: PAIR_OCCASIONS[template], template, kind });
    }
  }
  return out;
}

export const HOLDOUT_PER_CUISINE = 36;
/** Per cuisine: curated-listed (B ≥ 0.7), not listed (floor ≤ B < 0.7) and curated exclusions (B < floor). */
const BANDS = [{ name: "listed", take: 14, test: (b: number) => b >= 0.7 },
  { name: "unlisted", take: 14, test: (b: number) => b >= PAIR_FLOOR && b < 0.7 },
  { name: "excluded", take: 8, test: (b: number) => b < PAIR_FLOOR }] as const;

export type HoldoutPair = FixedPair & { cuisine: CuisineKey };

/**
 * The human holdout candidates: HOLDOUT_PER_CUISINE pairs for each of the 12 cuisines (432), drawn
 * with a fixed seed from the pairs whose side or anchor that cuisine's pack names, stratified by
 * the curated band so both plausible and implausible pairs appear. No pair is drawn twice. A band
 * with too few pairs is filled from the others.
 */
export function holdoutCandidates(pairs: readonly FixedPair[], seed = 18_03): HoldoutPair[] {
  const random = prng(seed);
  const used = new Set<string>();
  const out: HoldoutPair[] = [];
  const shuffle = <T>(list: T[]) => {
    for (let i = list.length - 1; i > 0; i -= 1) { const j = Math.floor(random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
    return list;
  };
  for (const cuisine of CUISINES) {
    const pool = shuffle(pairs.filter((pair) => pair.cuisines.includes(cuisine)));
    const chosen: FixedPair[] = [];
    for (const band of BANDS) {
      chosen.push(...pool.filter((pair) => band.test(pair.b) && !used.has(pair.id) && !chosen.includes(pair)).slice(0, band.take));
    }
    for (const pair of pool) if (chosen.length < HOLDOUT_PER_CUISINE && !used.has(pair.id) && !chosen.includes(pair)) chosen.push(pair);
    for (const pair of chosen.slice(0, HOLDOUT_PER_CUISINE)) { used.add(pair.id); out.push({ ...pair, cuisine }); }
  }
  return out;
}

/** The live reproducibility sample (≤ 60 items): 4 holdout pairs per cuisine and 12 plate patterns. */
export function reproducibilitySample(pairs: readonly FixedPair[]): PairItem[] {
  const holdout = holdoutCandidates(pairs);
  const fromPairs = CUISINES.flatMap((cuisine) => holdout.filter((pair) => pair.cuisine === cuisine).slice(0, 4));
  const plates = platePatterns(pairs).slice(0, 12);
  return [...fromPairs.map(toItem), ...plates.map(({ id, anchor, sides, occasion }) => ({ id, anchor, sides, occasion }))];
}

export function toItem(pair: FixedPair): PairItem {
  return { id: pair.id, anchor: pair.anchorName, sides: [pair.sideName], occasion: pair.occasion };
}
