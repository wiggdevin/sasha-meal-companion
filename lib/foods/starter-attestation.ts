import { dbFood } from "@/lib/food-db";
import { STARTERS, starterFood, type Starter } from "@/lib/foods/starter";
import { accountUnitGrams, legacyWriterUnitGrams } from "@/lib/foods/unit-grams";
import { uuidV5 } from "@/lib/foods/uuid5";
import { perUnitTo100g } from "@/lib/units";

// The namespace and name format are the existing food-membership writer's stable row identity.
const LEGACY_FOOD_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

export type StarterUserFoodRow = {
  id: string;
  kind: string;
  name: string;
  brand: string | null;
  ingredients_text: string | null;
  allergen_tags: string[] | null;
  catalog_food_id: number | null;
  deleted_at: string | null;
  per_100g: Record<string, unknown> | null;
};

async function verifiedStarterIdentity(
  userId: string, row: StarterUserFoodRow,
): Promise<{ starter: Starter; expected: Record<string, number>; accepted: Record<string, number>[] } | null> {
  if (row.kind !== "custom" || row.deleted_at !== null || row.brand !== null || row.ingredients_text !== null
    || row.catalog_food_id !== null || row.allergen_tags?.length !== 0) {
    return null;
  }
  const starter = STARTERS.find((item) => dbFood(item.id)?.name === row.name);
  if (!starter) return null;
  const food = starterFood(starter.id, "eats");
  // What the writer stores now (the one resolver, starter first), and what it stored before that
  // resolver (food list first), so a row written earlier is still recognised; nothing writes it.
  const grams = accountUnitGrams(food);
  if (grams === null) return null;
  const expected = perUnitTo100g(food.perUnit, grams);
  const legacyGrams = legacyWriterUnitGrams(food);
  const accepted = legacyGrams === null || legacyGrams <= 0 || legacyGrams === grams
    ? [expected] : [expected, perUnitTo100g(food.perUnit, legacyGrams)];
  const expectedId = await uuidV5(LEGACY_FOOD_NAMESPACE,
    `legacy-food:${userId}:${food.id}`);
  return row.id === expectedId ? { starter, expected, accepted } : null;
}

/** Attest a bundled starter's own row; a name match alone never grants food evidence. */
export async function verifiedStarterForUserFood(
  userId: string, row: StarterUserFoodRow,
): Promise<Starter | null> {
  if (!row.per_100g) return null;
  const identity = await verifiedStarterIdentity(userId, row);
  if (!identity) return null;
  const stored = row.per_100g;
  const matches = (expected: Record<string, number>) => Object.keys(stored).length === Object.keys(expected).length
    && Object.entries(expected).every(([key, value]) => stored[key] === value);
  return identity.accepted.some(matches) ? identity.starter : null;
}

/** The old whey writer lacked a cup conversion and stored {}; no other starter is repaired. */
export async function repairableLegacyStarterNutrition(
  userId: string, row: StarterUserFoodRow,
): Promise<Record<string, number> | null> {
  if (!row.per_100g || Object.keys(row.per_100g).length !== 0) return null;
  const identity = await verifiedStarterIdentity(userId, row);
  return identity?.starter.id === "whey-protein-powder" ? identity.expected : null;
}
