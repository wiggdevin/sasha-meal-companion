/**
 * Card manifest shard `onboarding` (owner: W0; docs/plans/2026-10-19-ui-makeover.md §8).
 * Onboarding steps, the invitation and the reward plate.
 *
 * Data, not a test: `tests/cards/manifest.ts` concatenates every shard into `CARD_MANIFEST`, and
 * `tests/cards/inventory.test.ts` reads it. No wildcard and no orphan allowlist, here as there.
 */
import type { CardManifestEntry } from "../manifest";

export const ONBOARDING_CARDS: CardManifestEntry[] = [
  { path: "components/Onboarding/OnboardingSteps.tsx", card: "OnboardingSteps",
    states: ["body", "activity", "goal", "preferences", "classifying",
      "plan incomplete", "plan complete"],
    renderTest: "tests/cards/onboarding.test.tsx" },
  { path: "components/Onboarding/OnboardingInvite.tsx", card: "OnboardingInvite",
    states: ["hidden", "offered", "dismissed"],
    renderTest: "tests/onboarding/invite.test.ts" },
  { path: "components/Onboarding/TileGrid.tsx", card: "TileGrid",
    states: ["unselected", "selected"],
    renderTest: "components/Onboarding/FallingFoodPile.test.tsx" },
  { path: "components/Onboarding/reward/RewardPlateCard.tsx", card: "RewardPlateCard",
    states: ["preparing", "ready", "numbers shown"],
    renderTest: "components/Onboarding/reward/RewardPlateCard.test.tsx" },
];
