/**
 * Grok pass 3, HIGH 2. A mirror row can carry a real revision and items that are only part of a
 * row — `ok()` returned `{id, grams, snapshot}` and the verbatim mirror stored exactly that. The
 * edit-base guard checked the revision and nothing else, so a note edit POSTed those thin items,
 * got a named 4xx, and `settleRefused` rolled back a meal the server still held.
 */
import { describe, expect, it } from "vitest";
import { isCompleteEntryRow } from "@/lib/log/entry-row";

const COMPLETE = {
  id: "aaaaaaaa-1111-4111-8111-111111111111", rev: 3,
  items: [{ id: "bbbbbbbb-2222-4222-8222-222222222222", seq: 1,
    food_ref_id: "cccccccc-3333-4333-8333-333333333333", grams: 100, unit: "g", snapshot: {} }],
};

describe("isCompleteEntryRow", () => {
  it("accepts a row whose every item names the food it is", () => {
    expect(isCompleteEntryRow(COMPLETE)).toBe(true);
  });

  it("refuses a row whose items are only id, grams and snapshot", () => {
    const thin = { ...COMPLETE, items: [{ id: "bbbbbbbb-2222-4222-8222-222222222222",
      grams: 100, snapshot: {} }] };
    expect(isCompleteEntryRow(thin)).toBe(false);
  });

  it("refuses a row where only ONE item is thin", () => {
    const mixed = { ...COMPLETE, items: [...COMPLETE.items,
      { id: "dddddddd-4444-4444-8444-444444444444", grams: 50, snapshot: {} }] };
    expect(isCompleteEntryRow(mixed)).toBe(false);
  });

  it("refuses a row with no revision, no items, or no row at all", () => {
    expect(isCompleteEntryRow({ ...COMPLETE, rev: null })).toBe(false);
    expect(isCompleteEntryRow({ ...COMPLETE, items: [] })).toBe(false);
    expect(isCompleteEntryRow(undefined)).toBe(false);
  });

  it("refuses a deleted row, whatever else it carries", () => {
    expect(isCompleteEntryRow({ ...COMPLETE, deleted_at: "2026-11-02T18:00:00.000Z" })).toBe(false);
  });
});
