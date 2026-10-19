/**
 * Card manifest shard `foods` (owner: W5; docs/plans/2026-10-19-ui-makeover.md §8).
 * The Foods first tab and Avoids.
 *
 * Data, not a test: `tests/cards/manifest.ts` concatenates every shard into `CARD_MANIFEST`, and
 * `tests/cards/inventory.test.ts` reads it. No wildcard and no orphan allowlist, here as there.
 */
import type { CardManifestEntry } from "../manifest";

export const FOODS_CARDS: CardManifestEntry[] = [
  { path: "components/FavoritesStrip.tsx", card: "FavoritesStrip",
    states: ["read failed", "empty", "pinned", "expanded"],
    renderTest: "tests/cards/foods.test.tsx" },
  { path: "components/foods/PreferredList.tsx", card: "PreferredList",
    states: ["empty", "grouped by aisle", "starred first", "pilot title"],
    renderTest: "tests/foods/preferred-list.test.tsx" },
  { path: "components/EatenOften.tsx", card: "EatenOften",
    states: ["rule review", "grouped by aisle", "estimated"],
    renderTest: "tests/cards/eaten-often.test.tsx" },
  { path: "components/MyFoods.tsx", card: "MyFoods",
    states: ["empty", "eats", "avoid", "save error", "truncated"],
    renderTest: "tests/cards/foods.test.tsx" },
  { path: "components/AvoidRules.tsx", card: "AvoidRules",
    states: ["unread", "no rules", "populated", "offline", "load failed"],
    renderTest: "tests/cards/foods.test.tsx" },
  { path: "components/RecipesSection.tsx", card: "RecipesSection",
    states: ["empty", "populated", "no calories"],
    renderTest: "tests/cards/foods.test.tsx" },
];
