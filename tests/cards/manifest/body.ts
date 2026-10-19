/**
 * Card manifest shard `body` (owner: W1; docs/plans/2026-10-19-ui-makeover.md §8).
 * The Body page.
 *
 * Data, not a test: `tests/cards/manifest.ts` concatenates every shard into `CARD_MANIFEST`, and
 * `tests/cards/inventory.test.ts` reads it. No wildcard and no orphan allowlist, here as there.
 */
import type { CardManifestEntry } from "../manifest";

export const BODY_CARDS: CardManifestEntry[] = [
  { path: "components/BodyTodayCard.tsx", card: "BodyTodayCard",
    states: ["loading", "offline", "empty", "profile error", "loaded"],
    renderTest: "tests/body/today-card.test.tsx" },
  { path: "app/body/page.tsx", card: "BodyEmptyState",
    states: ["skeleton", "empty", "loaded"],
    renderTest: "tests/cards/body.test.tsx" },
  { path: "components/BodyDashboard.tsx", card: "BodyDashboard",
    states: ["loaded", "offline", "profile error", "movement insufficient",
      "movement populated", "sources empty", "sources active", "sources revoked"],
    renderTest: "tests/cards/body.test.tsx" },
  { path: "components/HealthMetricCard.tsx", card: "HealthMetricCard",
    states: ["populated", "no data"],
    renderTest: "tests/cards/body.test.tsx" },
];
