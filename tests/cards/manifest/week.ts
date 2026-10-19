/**
 * Card manifest shard `week` (owner: W1; docs/plans/2026-10-19-ui-makeover.md §8).
 * The Week page.
 *
 * Data, not a test: `tests/cards/manifest.ts` concatenates every shard into `CARD_MANIFEST`, and
 * `tests/cards/inventory.test.ts` reads it. No wildcard and no orphan allowlist, here as there.
 */
import type { CardManifestEntry } from "../manifest";

export const WEEK_CARDS: CardManifestEntry[] = [
  { path: "components/week/WeekGrid.tsx", card: "WeekGrid",
    states: ["all done", "partially done", "missed", "not due yet"],
    renderTest: "tests/cards/week.test.tsx" },
  { path: "app/week/page.tsx", card: "Week stat cards",
    states: ["nothing logged", "partly logged", "populated"],
    renderTest: "tests/cards/week.test.tsx" },
];
