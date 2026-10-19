/**
 * Card manifest shard `shopping` (owner: W7; docs/plans/2026-10-19-ui-makeover.md §8).
 * Shopping lists, their line cards and the Today shopping card.
 *
 * Data, not a test: `tests/cards/manifest.ts` concatenates every shard into `CARD_MANIFEST`, and
 * `tests/cards/inventory.test.ts` reads it. No wildcard and no orphan allowlist, here as there.
 */
import type { CardManifestEntry } from "../manifest";

export const SHOPPING_CARDS: CardManifestEntry[] = [
  { path: "components/today/ShoppingTodayCard.tsx", card: "ShoppingTodayCard",
    states: ["to buy", "off", "no list"],
    renderTest: "tests/today/shopping-today-card.test.tsx" },
  { path: "components/ShoppingLineCard.tsx", card: "ShoppingLineCard",
    states: ["rounded shopping amounts", "readable meal source references"],
    renderTest: "tests/shopping/ui.test.tsx" },
  { path: "components/ShoppingPurchaseWindowCard.tsx", card: "ShoppingPurchaseWindowCard",
    states: ["persisted weekly Buy", "saves a check"],
    renderTest: "tests/shopping/ui.test.tsx" },
];
