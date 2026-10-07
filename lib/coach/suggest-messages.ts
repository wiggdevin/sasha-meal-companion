/** Shared deterministic copy for suggestion results; safe to import in server-loop tests. */
export const NOTHING_LEFT_MESSAGE = "There are no calories left in today's target for a snack.";
export const NO_MEAL_FIT_MESSAGE =
  "I couldn't find a meal option that fits this slot and your food rules yet. Try another idea or add foods to your Eats list.";
export const NO_SNACK_FIT_MESSAGE =
  "I couldn't find a snack option that fits your food rules yet. Try another idea or add foods to your Eats list.";
export const SUGGEST_RETRY_MESSAGE = "I couldn't build those suggestions right now. Please try again.";
export const SUGGEST_TIMEOUT_MESSAGE = "I ran out of time building options — ask again in a moment.";
export const REQUIRES_PREPARATION_MESSAGE =
  "Every verified option I found needs preparation, so I don't have an honest no-cook option yet.";
/**
 * A brand-new account has nothing to anchor options on (R1: zero `user_food_prefs` rows). Options
 * are built from the Eats list, so this is a fact to state — never the retry line, and never a
 * number: only the account's own mark can put a food on the list.
 */
export const NO_SAVED_FOODS_MESSAGE =
  "You have no saved foods yet. Add foods on the Foods tab, or ask me to plan a meal.";
/**
 * The day has no target the server can size against: no revision yet, or one not effective on this
 * day. "Targets are not set" is the rule (D1 §5.3) — target-fit composition is suppressed, not
 * invented, and the account is told what to do about it.
 */
export const NO_TARGET_SUGGEST_MESSAGE =
  "Your targets aren't set yet. Finish your profile and I'll size options to your target.";

/**
 * Phase 13 §5: suggestions exclude foods whose allergen evidence is missing or unchecked. When
 * that hides some or all of them, the card says so in one line — never that the rest are "safe".
 */
export const LABELS_HIDDEN_MESSAGE = "Some foods are hidden until their labels are checked";

/**
 * Spec phase 15 R14: an older account's inherited food rules need a Keep or Remove before any
 * generated suggestion, so a rule the person never chose cannot quietly shape their meals.
 */
export const RULE_REVIEW_SUGGEST_MESSAGE =
  "Review your existing food rules in Settings, then I can suggest meals.";
