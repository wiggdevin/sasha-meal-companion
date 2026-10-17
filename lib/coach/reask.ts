/**
 * The reply a turn gives when the food-rule check replaces the model's answer (§9 R7). It used to
 * be the generic abort line, "I couldn't work that one out", which read as a broken coach: the
 * 2026-10-17 live pass (W087) found most of those fallbacks were this check working, on a profile
 * with gluten, dairy and legume rules, while the user was told nothing about why.
 *
 * The re-ask still carries no food advice: it names the foods it held back and the rule each one
 * breaks, or that it could not check them, and nothing else. Every name is one the reply or its
 * cards already showed the person.
 *
 * Pure. No I/O.
 */

import { abortMessage } from "@/lib/coach/turn";
import { reasonFragment } from "@/lib/policy/reason-words";

/** A food the check held back, with the policy code that held it (null: it could not be checked). */
export type ReaskFailure = { name: string; reason: string | null };

/** The scan's own marker for a check that could not finish; it names no food. */
export const REPLY_CHECK_INCOMPLETE = "reply_check_incomplete";
/** A card whose id came only from the model: no search checked it. */
const UNCHECKED_ID = "unchecked_id";
const MAX_NAMED = 3;
/** Every re-ask that names a food ends with this sentence. */
export const REASK_TAIL = "Ask me for something else and I’ll check it first.";
/** The re-ask when the check could not finish and has no food to name. */
export const REASK_INCOMPLETE =
  "I couldn’t finish checking that answer against your food rules. Ask me again.";
const MAX_NAME_CHARS = 60;

function listOf(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function capitalised(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function sorted(failures: readonly ReaskFailure[]): {
  blocked: ReaskFailure[]; unchecked: string[]; incomplete: boolean;
} {
  const seen = new Set<string>();
  const blocked: ReaskFailure[] = [];
  const unchecked: string[] = [];
  let incomplete = false;
  for (const failure of failures) {
    if (failure.reason === REPLY_CHECK_INCOMPLETE) {
      incomplete = true;
      continue;
    }
    const name = failure.name.trim().replace(/\s+/g, " ").slice(0, MAX_NAME_CHARS);
    const key = name.toLowerCase();
    if (name === "" || seen.has(key)) continue;
    seen.add(key);
    if (failure.reason === null || failure.reason === UNCHECKED_ID) unchecked.push(name);
    else blocked.push({ name, reason: failure.reason });
  }
  return { blocked, unchecked, incomplete };
}

/** The quick reply that sends the coach "Add <food> to Eats"; a chip holds at most 40 characters. */
function addToEatsOption(name: string): string | null {
  const option = `Add ${name} to Eats`;
  return option.length <= 40 ? option : null;
}
/** The second chip beside the Eats offer: a quick-replies block needs two options. */
export const REASK_SOMETHING_ELSE = "Suggest something else";

/**
 * Item 2 of the 2026-10-17 coach rerun: a re-ask that held back foods it could not check left the
 * person at a dead end. When it held back a food only because nothing checked it yet (never one a
 * rule blocks), it offers the step that gets it checked: adding it to Eats, which runs the Eats
 * verification and facet warm (lib/foods/prefs-client.ts). The food stays held in this reply.
 *
 * `listed` is the account's own Eats and Avoid names: a food already on either list is not
 * offered, so a food on Avoid is never proposed for Eats. Returns the foods the offer names and
 * the quick-reply options, or null when there is nothing to offer.
 */
export function reaskNextStep(
  failures: readonly ReaskFailure[], listed: readonly string[],
): { foods: string[]; options: string[] } | null {
  const known = new Set(listed.map((name) => name.trim().replace(/\s+/g, " ").toLowerCase()));
  const foods = sorted(failures).unchecked.slice(0, MAX_NAMED)
    .filter((name) => !known.has(name.toLowerCase()) && addToEatsOption(name) !== null)
    .slice(0, 2);
  if (foods.length === 0) return null;
  return { foods, options: [...foods.map((name) => addToEatsOption(name) as string), REASK_SOMETHING_ELSE] };
}

/**
 * The reply that replaces an answer the food-rule check could not let through. `offerEats` names
 * the unchecked foods `reaskNextStep` offers to add to Eats; the reply then says how to get them
 * checked.
 */
export function reaskMessage(
  failures: readonly ReaskFailure[], offerEats: readonly string[] = [],
): string {
  const { blocked, unchecked, incomplete } = sorted(failures);
  const parts = blocked.slice(0, MAX_NAMED)
    .map((failure) => `${capitalised(failure.name)} ${reasonFragment(failure.reason)}`);
  const shown = unchecked.slice(0, MAX_NAMED);
  if (shown.length > 0) {
    parts.push(`I couldn’t check ${listOf(shown)} against your food rules yet, so I left `
      + `${shown.length === 1 ? "it" : "them"} out.`);
    const offered = shown.filter((name) => offerEats.some((o) => o.toLowerCase() === name.toLowerCase()));
    if (offered.length > 0) {
      const subject = offered.length === 1 && shown.length === 1 ? "it" : listOf(offered);
      parts.push(`Add ${subject} to your Eats and ${offered.length === 1 ? "it gets" : "they get"} `
        + "checked against your food rules.");
    }
  }
  if (parts.length === 0) {
    return incomplete ? REASK_INCOMPLETE : abortMessage("unverified_text_food");
  }
  if (incomplete) parts.push("I couldn’t finish checking the rest of that answer either.");
  parts.push(REASK_TAIL);
  return parts.join(" ");
}

/** True for any reply `reaskMessage` builds: the food-rule check replaced the model's answer. */
export function isReask(text: string): boolean {
  return text.endsWith(REASK_TAIL) || text === REASK_INCOMPLETE
    || text === abortMessage("unverified_text_food");
}

/**
 * The code a fallback log line may carry for one failure: a policy code with any custom rule's own
 * words cut off, and anything that is not a plain code at all reported as `other`.
 */
export function reaskReasonCode(reason: string | null): string {
  if (reason === null) return "unverified";
  if (reason.startsWith("rule:custom_ingredient:")) return "rule:custom_ingredient";
  return /^[a-z_]+(:[a-z_]+)?$/.test(reason) && reason.length <= 48 ? reason : "other";
}
