/**
 * The meal-card type hierarchy (docs/design/KIT.md §14; owner, 2026-10-05: "titles have to be bigger
 * than subtitles, bigger than sections, definitely bigger than bodies … they should have design
 * roles"). Every card that shows a meal, a recipe or a suggested plate reads its text roles from
 * here, so changing one role's relationship changes it on every card at once.
 *
 * One ladder, three densities, the seven steps only (KIT §3):
 *   hero      Today's meal card, an opened recipe        title 28 > section 16 > body 14 > meta 12
 *   standard  a list or discovery card, a plan idea       title 20 > section 16 > body 14 > meta 12
 *   compact   a 184 px carousel tile, a coach card       title 16 >              body 14 > meta 12
 *
 * Fraunces is for the two things a person reads for meaning — the meal's name and its calorie
 * numeral. Everything that organises (sections, eyebrows, meta) or informs (summaries, steps,
 * amounts) is Plus Jakarta Sans. Nothing on a card is smaller than 12 px. Colours are roles
 * (`text-charcoal`, `text-muted`), so the charcoal meal card's `.matte` remap turns them cream.
 */

export type CardDensity = "hero" | "standard" | "compact";

/** The meal's or recipe's name: the anchor of the card. Fraunces 500, never sans, never clipped
 *  below two lines on a tile. */
export const MEAL_TITLE: Record<CardDensity, string> = {
  hero: "font-display text-heading font-medium leading-[1.15] tracking-[-0.02em] text-charcoal",
  standard: "font-display text-heading-sm font-medium leading-[1.2] tracking-[-0.01em] text-charcoal",
  compact: "font-display text-body font-medium leading-[1.25] text-charcoal",
};

/** Ingredients, Method, Nutrition, Preparation: divides a card's detail into parts. Sans 600,
 *  sentence case — never a tiny tracked eyebrow, never serif. */
export const CARD_SECTION = "font-sans text-body font-semibold leading-[1.25] text-charcoal";

/** What the meal is at a glance: the ingredient line under a title. */
export const CARD_SUMMARY = "font-sans text-caption font-normal leading-[1.45] text-muted";

/** Reading text inside a card: an instruction, an ingredient name, an explanation. */
export const CARD_BODY = "font-sans text-caption font-normal leading-normal text-charcoal";

/** An amount beside an ingredient: a number to scan down a column. */
export const CARD_AMOUNT = "font-sans text-caption font-medium tabular-nums text-graphite";

/** Logistics a person checks, never reads: cuisine, time, servings, provenance, a footnote. */
export const CARD_META = "font-sans text-tiny font-normal leading-[1.35] text-muted";

/** Where the meal sits in the day before its name ("Meal 2 · 12:30"). */
export const CARD_EYEBROW = "font-sans text-tiny font-semibold uppercase tracking-[0.08em] text-muted";

/** A step's number in a method: a sequence marker in the primary ink. */
export const CARD_STEP = "font-sans text-tiny font-semibold tabular-nums text-primary";

/** The pixel size of each role, for the hierarchy test (tests/design/meal-type.test.ts). */
export const ROLE_PX = {
  title: { hero: 28, standard: 20, compact: 16 },
  section: 16,
  summary: 14,
  body: 14,
  meta: 12,
  eyebrow: 12,
} as const;
