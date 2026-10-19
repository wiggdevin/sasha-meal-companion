/**
 * Card manifest shard `today-overview` (owner: W2; docs/plans/2026-10-19-ui-makeover.md §8).
 * The Overview face (the daily cockpit) and the cup in the Day card's header.
 *
 * Data, not a test: `tests/cards/manifest.ts` concatenates every shard into `CARD_MANIFEST`, and
 * `tests/cards/inventory.test.ts` reads it. No wildcard and no orphan allowlist, here as there.
 */
import type { CardManifestEntry } from "../manifest";

export const TODAY_OVERVIEW_CARDS: CardManifestEntry[] = [
  { path: "components/today/overview/OverviewFace.tsx", card: "OverviewFace",
    states: ["with targets", "partly measured day", "without targets", "meals", "rebalance", "next step", "cockpit budget"],
    renderTest: "components/today/overview/OverviewFace.test.tsx" },
  { path: "components/today/CupSlot.tsx", card: "CupSlot",
    states: ["ounces", "loading", "scrub bar", "keyboard amount", "mid-slide sync"],
    renderTest: "tests/today/cup-slot.test.tsx" },
];
