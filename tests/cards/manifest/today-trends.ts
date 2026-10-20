/**
 * Card manifest shard `today-trends` (owner: W4; docs/plans/2026-10-19-ui-makeover.md §8).
 * Weekly trends. Empty by design: W4's files (`overview/TrendsSlot.tsx`, `components/charts/*`) match
 * no card pattern; their states are held by `tests/trends/trends-slot.test.tsx`.
 *
 * Data, not a test: `tests/cards/manifest.ts` concatenates every shard into `CARD_MANIFEST`, and
 * `tests/cards/inventory.test.ts` reads it. No wildcard and no orphan allowlist, here as there.
 */
import type { CardManifestEntry } from "../manifest";

export const TODAY_TRENDS_CARDS: CardManifestEntry[] = [];
