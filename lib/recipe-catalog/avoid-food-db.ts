import { FOOD_DB } from "@/lib/food-db";

const terms = (value: string): string[] => [...new Set(value.normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].sort();
const key = (value: string): string => terms(value).join(" ");

/** Resolve an account's Avoid display name to existing bundled food identities.
 * Comma and word order differ between the catalog and FoodDB. A broad name such as
 * "Bread" resolves to every bread variant; it is never silently narrowed to one.
 */
export function avoidFoodDbIds(names: readonly string[]): string[] {
  const ids = new Set<string>();
  for (const name of names) {
    const wanted = terms(name);
    if (!wanted.length) continue;
    const exact = FOOD_DB.filter((food) => key(food.name) === wanted.join(" ")
      || key(food.id) === wanted.join(" "));
    const possible = exact.length ? exact : FOOD_DB.filter((food) => {
      const found = new Set([...terms(food.name), ...terms(food.id)]);
      return wanted.every((word) => found.has(word));
    });
    for (const food of possible) ids.add(food.id);
  }
  return [...ids].sort();
}
