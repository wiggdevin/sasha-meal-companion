/**
 * The morning-weight field's own rules: what it accepts, and one save at a time.
 *
 * Kept out of `components/QuickActions.tsx` because neither is rendering — one is the client half
 * of `health_weigh_in`'s own range, which the two have to agree on, and the other is a guard that
 * React state cannot express. They are also the only parts of that component testable without a
 * DOM, which this repo has no way to supply.
 */
import { lbToKg } from "@/lib/health/units";

/** Shown when Save is tapped with nothing usable in the field (audit finding 41: the tap used to
 *  no-op with no visible result at all). */
export const WEIGHT_INVALID_MESSAGE = "Enter a weight greater than 0.";

/** The RPC's own refusal, word for word, so the two never disagree about the same number. */
export const WEIGHT_RANGE_MESSAGE = "That weight looks wrong. Check it and try again.";

/** What `health_weigh_in` will hold: a human body, in the kilograms the column stores. */
const MIN_KG = 20;
const MAX_KG = 400;

/**
 * The range is the RPC's, converted (T8): accepting anything above zero meant a mistyped 10 lb was
 * written to the day, parked while offline, and refused only when signal came back — so the pill
 * showed a weight the user never had for as long as the phone was out of signal.
 */
export function parseWeightInput(
  raw: string,
): { valid: true; lb: number } | { valid: false; message: string } {
  const lb = parseFloat(raw);
  if (!Number.isFinite(lb) || lb <= 0) return { valid: false, message: WEIGHT_INVALID_MESSAGE };
  const kg = lbToKg(lb);
  if (kg < MIN_KG || kg > MAX_KG) return { valid: false, message: WEIGHT_RANGE_MESSAGE };
  return { valid: true, lb };
}

/**
 * One morning weigh-in in flight at a time, claimed synchronously.
 *
 * React state cannot do this: it is read from the render on screen, so two taps landing before the
 * next paint both see "not saving" and both start a save — and two saves for one day each capture
 * their own "previous" weight, so the loser's revert wipes the winner's number. The claim is taken
 * in the handler, and given back only when that save's own promise settles; closing the menu resets
 * the field but must not hand it out again while a request is still on the wire.
 */
export function createSaveGuard() {
  let held = false;
  return {
    claim(): boolean {
      if (held) return false;
      held = true;
      return true;
    },
    release(): void {
      held = false;
    },
  };
}
