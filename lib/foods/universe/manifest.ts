/**
 * The Phase 18 food universe, v1 (docs/specs/phase-18-open-world-foods.md D1, slice W1): the
 * curated, versioned list of generic whole and minimally processed foods an open food world may
 * draw from. The base layer (./data/base.ts) plus the cuisine-pack staples (./data/staples.ts),
 * each entry with its cuisine tiers from the 12 packs (./data/packs.ts).
 *
 * INERT for every account today. Only the W2b gate reads it (lib/foods/world/admission.ts and
 * lib/server/candidate-foods.ts), and only for an account whose `food_world` is `open`. No account
 * opens until the owner's review of this version is recorded in its receipt
 * (docs/catalog/universe/<version>.md) and `OPEN_WORLD_ENABLED` is set.
 *
 * `UNIVERSE_VERSION` and `UNIVERSE_HASH` both enter the meal snapshot's `inputsHash` (D1, W8). The
 * hash covers every curated field and the bundled food row each entry reads, so a regenerated
 * lib/food-db.json that moves an item's nutrition or SR row changes it; a change of either needs a
 * new version and receipt (tests/foods/universe-data.test.ts holds the pin).
 *
 * Pure. No I/O.
 */

import { dbFood } from "@/lib/food-db";
import { sha256Hex } from "@/lib/foods/sha256";
import { BASE_SEEDS } from "@/lib/foods/universe/data/base";
import { PACKS } from "@/lib/foods/universe/data/packs";
import { STAPLE_SEEDS } from "@/lib/foods/universe/data/staples";
import type { UniverseSeed } from "@/lib/foods/universe/seed";
import { CUISINES, TIERS, type CuisineKey, type Tier } from "@/lib/foods/universe/vocabulary";

export const UNIVERSE_VERSION = "1.0.0";
/** sha256 of `universeContent()`; pinned so a content change cannot ship without a new version. */
export const UNIVERSE_HASH = "15505315ca8a18e75f37ab751f8475b0ee4f2aed0f7b5e6cfcd7a158e2b95be3";

/** `base`: offered to every cuisine. `pack`: a cuisine staple, offered through its packs only. */
export type UniverseLayer = "base" | "pack";

export type UniverseEntry = UniverseSeed & {
  layer: UniverseLayer;
  /** The entry's tier in each cuisine pack that names it. */
  tiers: Readonly<Partial<Record<CuisineKey, Tier>>>;
};

function tiersOf(id: string): Partial<Record<CuisineKey, Tier>> {
  const tiers: Partial<Record<CuisineKey, Tier>> = {};
  for (const cuisine of CUISINES) {
    const tier = TIERS.find((name) => PACKS[cuisine][name].includes(id));
    if (tier) tiers[cuisine] = tier;
  }
  return tiers;
}

export const UNIVERSE: readonly UniverseEntry[] = [
  ...BASE_SEEDS.map((item) => ({ ...item, layer: "base" as const, tiers: tiersOf(item.id) })),
  ...STAPLE_SEEDS.map((item) => ({ ...item, layer: "pack" as const, tiers: tiersOf(item.id) })),
];

const BY_ID = new Map(UNIVERSE.map((entry) => [entry.id, entry]));

export function universeEntry(id: string): UniverseEntry | undefined {
  return BY_ID.get(id);
}

/** A cuisine's candidate foods: the base layer plus that cuisine's pack staples. */
export function cuisineEntries(cuisine: CuisineKey): UniverseEntry[] {
  return UNIVERSE.filter((entry) => entry.layer === "base" || entry.tiers[cuisine] !== undefined);
}

/** Keys sorted at every level, so the text (and the hash) never depends on insertion order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The hashed content: each entry with the bundled row it reads (name, SR row, group, nutrition). */
export function universeContent(): string {
  return canonical(UNIVERSE.map((entry) => {
    const food = dbFood(entry.id);
    return { ...entry, food: food ? { name: food.name, sr: food.sr, fdcId: food.fdcId,
      srCategory: food.srCategory, per100g: food.per100g } : null };
  }));
}

export function universeContentHash(): string {
  return sha256Hex(universeContent());
}
