/**
 * Card manifest shard `shopping-build` (owner: W8; docs/plans/2026-10-19-ui-makeover.md §8).
 * Have AI build my list, the store map, and the processors section W8 owns.
 *
 * Data, not a test: `tests/cards/manifest.ts` concatenates every shard into `CARD_MANIFEST`, and
 * `tests/cards/inventory.test.ts` reads it. No wildcard and no orphan allowlist, here as there.
 */
import type { CardManifestEntry } from "../manifest";

export const SHOPPING_BUILD_CARDS: CardManifestEntry[] = [
  { path: "components/settings/ProcessorsSection.tsx", card: "ProcessorsSection",
    states: ["every model provider", "each processor"],
    renderTest: "components/settings/ProcessorsSection.test.tsx" },
];
