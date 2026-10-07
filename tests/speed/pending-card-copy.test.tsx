/**
 * Panel round 5 ruling on the capture card: an optimistic card whose items have no snapshot yet
 * must not read "0 kcal". A number she can see is a number she will believe, and a plate she has
 * just photographed has not been measured at zero — it has not been measured.
 *
 * Static markup only (no @testing-library/react in this repo — tests/today/day-type-toggle.tsx's
 * header comment is the canonical note on why): what is asserted is the copy, not a DOM event.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LoggedExtraCard, macroLine } from "@/components/LoggedExtras";
import type { LoggedFood } from "@/lib/types";

const ZERO = { kcal: 0, protein: 0, carbs: 0, fat: 0 };

/** What `commitDraft` writes before the reply: real grams, no snapshot anywhere. */
const UNMEASURED: LoggedFood = {
  id: "aaaaaaaa-1111-4111-8111-111111111111", foodId: "catalog:910", name: "Rice",
  portionLabel: "1 g", qty: 1, grams: 180, macros: ZERO,
  at: "2026-11-02T17:00:00.000Z",
  items: [{
    id: "bbbbbbbb-2222-4222-8222-222222222222", seq: 1,
    food_ref_id: "cccccccc-3333-4333-8333-333333333333", grams: 180, qty: 1, unit: "g",
    snapshot: {}, foodId: "catalog:910", name: "Rice", portionLabel: "1 g", macros: ZERO,
  }],
};

/** The same entry after the reply filled its snapshots in. */
const MEASURED: LoggedFood = {
  ...UNMEASURED,
  macros: { kcal: 234, protein: 4.9, carbs: 50, fat: 0.5 },
  items: [{ ...UNMEASURED.items![0],
    snapshot: { energy_kcal: { amount: 234, unit: "kcal" } } as never,
    macros: { kcal: 234, protein: 4.9, carbs: 50, fat: 0.5 } }],
};

describe("macroLine", () => {
  it("says the numbers are still coming rather than printing zeros", () => {
    const line = macroLine(UNMEASURED, ZERO, false, true);
    expect(line).not.toMatch(/\b0 kcal\b/);
    expect(line).toContain("kcal pending");
  });

  it("uses no em dash, so it reads aloud as words", () => {
    expect(macroLine(UNMEASURED, ZERO, false, true)).not.toContain("—");
  });

  it("keeps the real numbers once the snapshot has landed", () => {
    const line = macroLine(MEASURED, MEASURED.macros, true, false);
    expect(line).toContain("234 kcal");
    expect(line).not.toContain("pending");
  });

  it("prints an entry she logged by hand, which never had items, as it always did", () => {
    const byHand = { ...UNMEASURED, items: undefined,
      macros: { kcal: 120, protein: 2, carbs: 25, fat: 1 } };
    const line = macroLine(byHand, byHand.macros, false, false);
    expect(line).toContain("120 kcal");
    expect(line).not.toContain("pending");
  });

  it("keeps saying pending after the mark clears, if the numbers never arrived", () => {
    // MEDIUM 12: a reconcile can be skipped — a diverged answer, an unreadable 2xx, a failed
    // write — and the mark then clears with the snapshots still missing.
    expect(macroLine(UNMEASURED, ZERO, false, false)).toContain("kcal pending");
  });
});

describe("the card itself", () => {
  const html = renderToStaticMarkup(
    <LoggedExtraCard entry={UNMEASURED} pending onOpen={() => {}} />);

  it("never shows a zero calorie figure while it is still pending", () => {
    expect(html).not.toMatch(/\b0 kcal\b/);
    expect(html).toContain("kcal pending");
  });

  it("still carries the not-synced mark, so the two read as one state", () => {
    expect(html).toContain("Not synced yet");
  });

  it("says an entry whose reads ran out is logged, not that it is still saving", () => {
    // A capped record is not a save that never finished: the server HAS the meal, this phone just
    // could not read it back. Drawing the not-synced mark invites a second Log and a doubled day
    // (Grok pass 7, MEDIUM 4).
    const stale = renderToStaticMarkup(
      <LoggedExtraCard entry={MEASURED} pending={false} stale onOpen={() => {}} />);
    expect(stale).toContain("Logged. Details are still catching up.");
    expect(stale).not.toContain("Not synced yet");
  });

  it("does not say Logged for a write the server never confirmed", () => {
    // A capped record that nobody ever confirmed is a meal that may not be in the log at all —
    // the queue failed, or the page died before the POST. Telling her it is logged means she does
    // not retry, and a silent miss is worse for this product than a duplicate (Grok pass 8).
    const unsaved = renderToStaticMarkup(
      <LoggedExtraCard entry={MEASURED} pending={false} stale unsaved onOpen={() => {}} />);
    expect(unsaved).toContain("Not saved yet. Tap to try again.");
    expect(unsaved).not.toContain("Logged. Details are still catching up.");
  });

  it("says to log it again when there is nothing left to retry", () => {
    // The kept request was dropped at the cap. Offering a retry that does nothing is worse than
    // saying plainly that the meal is not saved (Grok pass 10, HIGH 1).
    const lost = renderToStaticMarkup(
      <LoggedExtraCard entry={MEASURED} pending={false} stale lost onOpen={() => {}} />);
    expect(lost).toContain("Not saved. Log it again.");
    expect(lost).not.toContain("Tap to try again");
  });

  it("shows the real figure once the entry is measured", () => {
    const settled = renderToStaticMarkup(
      <LoggedExtraCard entry={MEASURED} pending={false} onOpen={() => {}} />);
    // The number carries the shared calorie colour (DESIGN.md §Colors, 2026-10-03); the unit follows it.
    expect(settled).toContain('<span class="kcal font-semibold tabular-nums">234</span> kcal');
    expect(settled).not.toContain("pending");
  });
});
