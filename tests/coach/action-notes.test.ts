/**
 * components/coach/action-notes.ts — CoachActionCard's body notes, split out of the card itself
 * (file-size budget). Phase 18 W5b-2 round 3: a server-held "undone" entry can carry a distinct
 * honest `reason` (a taste record whose first real Undo removed nothing because the keys left the
 * row some other way — components/coach/use-coach-undo.ts) instead of the shared
 * ALREADY_UNDONE_COPY every other action kind uses for "this tap did not freshly undo anything".
 */
import { describe, expect, it } from "vitest";
import { ALREADY_UNDONE_COPY, actionCardNotes } from "@/components/coach/action-notes";

const base = { notices: [], nutritionUnchecked: false };

describe("actionCardNotes", () => {
  it("shows an applied save's notices, and nutrition-unchecked only while applied", () => {
    expect(actionCardNotes({ ...base, status: "applied", already: false,
      notices: ["Left out Peanuts: on your Avoid list."], nutritionUnchecked: true }))
      .toEqual(["Left out Peanuts: on your Avoid list.", "Saved. Nutrition not fully checked."]);
    expect(actionCardNotes({ ...base, status: "undone", already: false, nutritionUnchecked: true })).toEqual([]);
  });

  it("every other action kind's undone note is unchanged: ALREADY_UNDONE_COPY when already, nothing otherwise", () => {
    expect(actionCardNotes({ ...base, status: "undone", already: true })).toEqual([ALREADY_UNDONE_COPY]);
    expect(actionCardNotes({ ...base, status: "undone", already: false })).toEqual([]);
    expect(actionCardNotes({ ...base, status: "pending", already: false })).toEqual([]);
    expect(actionCardNotes({ ...base, status: "failed", already: false })).toEqual([]);
    expect(actionCardNotes({ ...base, status: "undoing", already: false })).toEqual([]);
  });

  it("shows a distinct `reason` on an undone entry in place of the shared already-undone line", () => {
    const REASON = "Those had already changed in your settings, so Undo made no change.";
    expect(actionCardNotes({ ...base, status: "undone", already: false, reason: REASON })).toEqual([REASON]);
    // A specific reason sent alongside `already` (no real caller does both today) wins over the
    // shared copy, same as `reason` already wins for "failed"/"undoing" elsewhere in this card.
    expect(actionCardNotes({ ...base, status: "undone", already: true, reason: REASON })).toEqual([REASON]);
  });
});
