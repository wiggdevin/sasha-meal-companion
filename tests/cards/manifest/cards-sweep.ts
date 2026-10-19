/**
 * Card manifest shard `cards-sweep` (owner: W6; docs/plans/2026-10-19-ui-makeover.md §8).
 * The meal card, plan and recipe idea cards, and the Today extras W6 moves onto CardFrame.
 *
 * Data, not a test: `tests/cards/manifest.ts` concatenates every shard into `CARD_MANIFEST`, and
 * `tests/cards/inventory.test.ts` reads it. No wildcard and no orphan allowlist, here as there.
 */
import type { CardManifestEntry } from "../manifest";

export const CARDS_SWEEP_CARDS: CardManifestEntry[] = [
  { path: "components/SlotCard.tsx", card: "SlotCard",
    states: ["empty", "planned", "eaten", "rescheduling", "actions"],
    renderTest: "tests/cards/today.test.tsx" },
  { path: "components/plan/IdeaCard.tsx", card: "IdeaCard",
    states: ["idle", "placing"],
    renderTest: "components/plan/IdeaCard.test.tsx" },
  { path: "components/recipes-hub/SuggestionCard.tsx", card: "SuggestionCard",
    states: ["no photo", "inside a card", "closes"],
    renderTest: "tests/recipes-hub/suggestion-card.test.tsx" },
  { path: "components/today/DuplicateEntryCard.tsx", card: "DuplicateEntryCard",
    states: ["hidden", "open", "kept with undo", "merging with undo", "failed"],
    renderTest: "components/today/DuplicateEntryCard.test.tsx" },
  { path: "components/ProposalCard.tsx", card: "ProposalCard",
    states: ["delta sentence", "pending", "busy", "stale", "error"],
    renderTest: "tests/expenditure/proposal-card-copy.test.tsx" },
];
