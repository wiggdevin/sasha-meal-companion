/**
 * The food families a taste chip may name (Phase 18 D9 item 3, slice W5b): every universe item's
 * name family (`baseFoodName` of its bundled name), deduplicated and sorted. The server matches the
 * taste text against this list (lib/profile/taste-chips.ts `matchFamilies`) so Jev is only ever
 * asked about a family the user actually wrote, and a chip can only carry a family the universe
 * knows.
 *
 * It reads the universe for names only. It proposes chips; it never generates, suggests or admits a
 * food (tests/foods/universe-data.test.ts lists it as a W5b family reader). Server-side only: the
 * phone never needs the list.
 *
 * Pure. No I/O.
 */
import { dbFood } from "@/lib/food-db";
import { baseFoodName } from "@/lib/foods/base-name";
import { UNIVERSE } from "@/lib/foods/universe/manifest";
import { chipFamily } from "@/lib/profile/taste-chips";

let cache: readonly string[] | null = null;

export function tasteFamilies(): readonly string[] {
  cache ??= Object.freeze([...new Set(UNIVERSE.flatMap((entry) => {
    const family = chipFamily(baseFoodName(dbFood(entry.id)?.name ?? ""));
    return family ? [family] : [];
  }))].sort());
  return cache;
}
