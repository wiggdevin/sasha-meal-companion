/**
 * The morning-weight input's own guard (T8, Grok pass 2 finding 3).
 *
 * `parseWeightInput` used to accept any number above zero, so a mistyped 10 lb was saved locally,
 * parked while offline, and only refused much later by the RPC — by which time the pill had been
 * showing an incorrect weight for however long the phone was out of signal. The input now holds
 * the same range as the RPC, so the refusal happens while the typed value is still visible.
 */
import { describe, expect, it } from "vitest";
import {
  createSaveGuard, parseWeightInput, WEIGHT_INVALID_MESSAGE, WEIGHT_RANGE_MESSAGE,
} from "@/lib/today/weight-input";
import { lbToKg } from "@/lib/health/units";

describe("parseWeightInput", () => {
  it("takes a weight a person can be", () => {
    expect(parseWeightInput("170")).toEqual({ valid: true, lb: 170 });
    expect(parseWeightInput("169.5")).toEqual({ valid: true, lb: 169.5 });
  });

  it("refuses anything that is not a number above zero", () => {
    for (const raw of ["", "  ", "abc", "0", "-5"]) {
      expect(parseWeightInput(raw)).toEqual({ valid: false, message: WEIGHT_INVALID_MESSAGE });
    }
  });

  /** The RPC's range is 20-400 kg; this is that range in pounds. */
  it("refuses a weight outside the range the server will hold, in the server's words", () => {
    expect(parseWeightInput("10")).toEqual({ valid: false, message: WEIGHT_RANGE_MESSAGE });
    expect(parseWeightInput("1000")).toEqual({ valid: false, message: WEIGHT_RANGE_MESSAGE });
  });

  /**
   * The edges themselves, to the gram the column stores. `lbToKg` rounds to three decimals, so
   * these four pounds are the last value in and the first value out on each side — and the RPC's
   * own `p_kg < 20 or p_kg > 400` is checked against exactly the same numbers in
   * tests/health/manual-weigh-in-migration.test.ts.
   */
  it("accepts exactly 20.000 kg and 400.000 kg", () => {
    expect(lbToKg(44.0925)).toBe(20);
    expect(lbToKg(881.849)).toBe(400);
    expect(parseWeightInput("44.0925")).toEqual({ valid: true, lb: 44.0925 });
    expect(parseWeightInput("881.849")).toEqual({ valid: true, lb: 881.849 });
  });

  it("refuses one gram either side", () => {
    expect(lbToKg(44.0902)).toBe(19.999);
    expect(lbToKg(881.8513)).toBe(400.001);
    expect(parseWeightInput("44.0902")).toEqual({ valid: false, message: WEIGHT_RANGE_MESSAGE });
    expect(parseWeightInput("881.8513")).toEqual({ valid: false, message: WEIGHT_RANGE_MESSAGE });
  });
});

/**
 * One weigh-in in flight at a time (finding 4): two Saves for the same day can otherwise each
 * capture their own "previous" value, and the loser's revert wipes the winner's number.
 *
 * The guard cannot be React state. State is read from the render that is on screen, so two taps
 * landing before the next paint both see `false` and both start a save. It is claimed
 * synchronously, in the handler, exactly like `createFabActivation`'s double-tap window.
 */
describe("the save guard", () => {
  it("lets the first tap through and turns away every tap until it settles", () => {
    const guard = createSaveGuard();
    expect(guard.claim()).toBe(true);
    // Two more taps in the same frame, before any state could have been re-read.
    expect(guard.claim()).toBe(false);
    expect(guard.claim()).toBe(false);
    guard.release();
    expect(guard.claim()).toBe(true);
  });

  it("is not released by closing the menu while a save is on the wire", () => {
    const guard = createSaveGuard();
    expect(guard.claim()).toBe(true);
    // `close()` resets the field and the error line; it must not hand out the claim again, or the
    // save that is still in flight has a second one racing it.
    expect(guard.claim()).toBe(false);
  });
});
