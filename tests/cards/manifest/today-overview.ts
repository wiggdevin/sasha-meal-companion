/**
 * Card manifest shard `today-overview` (owner: W2; docs/plans/2026-10-19-ui-makeover.md §8).
 * The Overview face and the cup. Empty until W2 adds its cards.
 *
 * Data, not a test: `tests/cards/manifest.ts` concatenates every shard into `CARD_MANIFEST`, and
 * `tests/cards/inventory.test.ts` reads it. No wildcard and no orphan allowlist, here as there.
 */
import type { CardManifestEntry } from "../manifest";

export const TODAY_OVERVIEW_CARDS: CardManifestEntry[] = [];
