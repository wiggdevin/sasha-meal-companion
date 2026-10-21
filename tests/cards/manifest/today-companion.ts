/**
 * Card manifest shard `today-companion` (owner: W3; docs/plans/2026-10-19-ui-makeover.md §8).
 * The companion: its row in Overview, the rings it sits in and its Settings section.
 *
 * Data, not a test: `tests/cards/manifest.ts` concatenates every shard into `CARD_MANIFEST`, and
 * `tests/cards/inventory.test.ts` reads it. No wildcard and no orphan allowlist, here as there.
 */
import type { CardManifestEntry } from "../manifest";

export const TODAY_COMPANION_CARDS: CardManifestEntry[] = [
  { path: "components/today/overview/CompanionCard.tsx", card: "CompanionCard",
    states: ["collapsed", "collapsed with Seeds", "open", "the pond", "without targets", "hidden"],
    renderTest: "components/today/overview/CompanionCard.test.tsx" },
  { path: "components/today/island/LiquidRings.tsx", card: "LiquidRings",
    states: ["draws all four rings with Sprout in the middle", "draws the three macro rings without calories"],
    renderTest: "components/today/LiquidRingsPanel.test.tsx" },
  { path: "components/settings/CompanionSection.tsx", card: "CompanionSection",
    states: ["a companion chosen", "a save that fails goes back", "a pull moves the picker",
      "the switch hides the companion", "a hidden companion carries a Hidden tag"],
    renderTest: "components/today/island/companion-today.test.tsx" },
];
