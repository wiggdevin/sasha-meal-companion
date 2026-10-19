/**
 * Card manifest shard `today-shell` (owner: W0; docs/plans/2026-10-19-ui-makeover.md §8).
 * The Today page and its Day card shell (two tabs, header, faces mounted), the nutrients block and the day strip.
 *
 * Data, not a test: `tests/cards/manifest.ts` concatenates every shard into `CARD_MANIFEST`, and
 * `tests/cards/inventory.test.ts` reads it. No wildcard and no orphan allowlist, here as there.
 */
import type { CardManifestEntry } from "../manifest";

export const TODAY_SHELL_CARDS: CardManifestEntry[] = [
  { path: "components/today/DayCard.tsx", card: "DayCard",
    states: ["calendar", "overview", "without targets", "reduced motion"],
    renderTest: "components/today/DayCard.test.tsx" },
  { path: "components/DayNutrients.tsx", card: "DayNutrients",
    states: ["hidden", "under", "in band", "over", "unknown"],
    renderTest: "tests/cards/day-nutrients.test.tsx" },
  { path: "app/page.tsx", card: "Today",
    states: ["saving elsewhere banner", "floor-day banner", "empty slots"],
    renderTest: "tests/cards/today.test.tsx" },
  { path: "components/TodayDayStrip.tsx", card: "TodayDayStrip",
    states: ["complete", "partial", "empty", "expanded"],
    renderTest: "components/TodayDayStrip.test.tsx" },
];
