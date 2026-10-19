/**
 * The card inventory (design §8.4): every card-like file in the tree, the states it supports, and
 * the one spec that renders them.
 *
 * This is DATA, not a test. `tests/cards/inventory.test.ts` reads it, walks the static import
 * graph from `app/**`, and fails when a card is unreachable, when a card the regex finds has no
 * entry here, or when an entry names a spec that does not mention it. There is deliberately no
 * wildcard and no orphan allowlist: a card that is not on a route is deleted, not excused.
 *
 * The walkthrough lane screenshots this table, one row per card × state, so a state named here
 * must be a state someone can actually put the card into.
 *
 * The entries live in shards under `tests/cards/manifest/`, one per UI makeover workstream
 * (docs/plans/2026-10-19-ui-makeover.md §8), so parallel threads never edit the same list. This
 * file only concatenates them: every shard file must be imported here (the inventory test checks),
 * and a new card goes into the shard of the workstream that owns it.
 */
import { BODY_CARDS } from "./manifest/body";
import { CARDS_SWEEP_CARDS } from "./manifest/cards-sweep";
import { COACH_CARDS } from "./manifest/coach";
import { CORE_CARDS } from "./manifest/core";
import { FOODS_CARDS } from "./manifest/foods";
import { ONBOARDING_CARDS } from "./manifest/onboarding";
import { SETTINGS_CARDS } from "./manifest/settings";
import { SHEET_CARDS } from "./manifest/sheets";
import { SHOPPING_CARDS } from "./manifest/shopping";
import { SHOPPING_BUILD_CARDS } from "./manifest/shopping-build";
import { TODAY_COMPANION_CARDS } from "./manifest/today-companion";
import { TODAY_OVERVIEW_CARDS } from "./manifest/today-overview";
import { TODAY_SHELL_CARDS } from "./manifest/today-shell";
import { TODAY_TRENDS_CARDS } from "./manifest/today-trends";
import { WEEK_CARDS } from "./manifest/week";

export type CardManifestEntry = {
  /** Repo-relative path of the file the card lives in. */
  path: string;
  /** The exported card, or the block inside `path` when the card has no export of its own. */
  card: string;
  /** Every state this card supports, in the words its spec asserts. */
  states: string[];
  /** The spec that renders those states. It must exist and must name `card`. */
  renderTest: string;
};

/** Every shard, by its file name under `tests/cards/manifest/`. */
export const CARD_MANIFEST_SHARDS: Record<string, CardManifestEntry[]> = {
  "core": CORE_CARDS,
  "today-shell": TODAY_SHELL_CARDS,
  "coach": COACH_CARDS,
  "onboarding": ONBOARDING_CARDS,
  "sheets": SHEET_CARDS,
  "today-overview": TODAY_OVERVIEW_CARDS,
  "today-companion": TODAY_COMPANION_CARDS,
  "today-trends": TODAY_TRENDS_CARDS,
  "foods": FOODS_CARDS,
  "shopping": SHOPPING_CARDS,
  "shopping-build": SHOPPING_BUILD_CARDS,
  "body": BODY_CARDS,
  "settings": SETTINGS_CARDS,
  "week": WEEK_CARDS,
  "cards-sweep": CARDS_SWEEP_CARDS,
};

export const CARD_MANIFEST: CardManifestEntry[] = Object.values(CARD_MANIFEST_SHARDS).flat();
