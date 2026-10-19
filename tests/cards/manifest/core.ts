/**
 * Card manifest shard `core` (owner: W0; docs/plans/2026-10-19-ui-makeover.md §8).
 * Cards no makeover workstream owns: they keep their own specs and stay as they are.
 *
 * Data, not a test: `tests/cards/manifest.ts` concatenates every shard into `CARD_MANIFEST`, and
 * `tests/cards/inventory.test.ts` reads it. No wildcard and no orphan allowlist, here as there.
 */
import type { CardManifestEntry } from "../manifest";

export const CORE_CARDS: CardManifestEntry[] = [
  { path: "components/today/RebalancePanel.tsx", card: "RebalancePanel",
    states: ["hidden", "missed", "remaining", "empty"],
    renderTest: "tests/rebalance/panel.test.tsx" },
  { path: "components/LoggedExtras.tsx", card: "LoggedExtraCard",
    states: ["pending", "stale", "unsaved", "lost", "kcal pending", "off-plan",
      "unknown slot"],
    renderTest: "components/LoggedExtras.test.tsx" },
  { path: "components/MacroRings.tsx", card: "MacroRings",
    states: ["drawing", "done", "needs profile"],
    renderTest: "components/MacroRings.test.tsx" },
  { path: "components/WaterDial.tsx", card: "WaterDial",
    states: ["idle", "added", "held", "add did not land"],
    renderTest: "tests/cards/water-dial.test.tsx" },
  { path: "components/ActivityMismatchPrompt.tsx", card: "ActivityMismatchPrompt",
    states: ["ready", "saving", "saved", "failed", "flag off"],
    renderTest: "tests/activity/prompt.test.ts" },
  { path: "components/TdeeLines.tsx", card: "TdeeLines",
    states: ["burn-in", "held", "blocked", "estimating", "missing device energy", "starting",
      "provisional", "adaptive", "held reason", "needs a check", "no profile", "no phase"],
    renderTest: "tests/body/tdee-lines.test.tsx" },
  { path: "components/WeightTrend.tsx", card: "WeightTrend",
    states: ["hidden under 20 weigh-ins", "hidden in burn-in", "mounted", "no series",
      "provisional phase", "starting phase"],
    renderTest: "tests/cards/body.test.tsx" },
  { path: "components/RuleReviewCard.tsx", card: "RuleReviewCard",
    states: ["requires an explicit choice", "refreshes the rule list"],
    renderTest: "components/RuleReviewCard.test.tsx" },
  { path: "components/RecipeResultCard.tsx", card: "RecipeResultCard",
    states: ["full details", "rule issue"],
    renderTest: "tests/cards/recipe-results.test.tsx" },
  { path: "components/InstallPrompt.tsx", card: "InstallPrompt",
    states: ["hidden", "standalone", "android", "unavailable", "declined", "safari", "browsers",
      "open safari", "dismissed"],
    renderTest: "components/InstallPrompt.test.tsx" },
];
