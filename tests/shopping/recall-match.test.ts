import { describe, expect, it } from "vitest";
import { extractGtins, indexRecall, matchRecalls, type RecallRecord } from "@/lib/shopping/recall-match";
import sample from "../fixtures/recalls/synthetic-sample.json";

const recalls = (sample.results as RecallRecord[]).map(indexRecall);

describe("extractGtins", () => {
  it("reads a spaced UPC after a label and pads it to GTIN-14", () => {
    expect(extractGtins("jar, UPC 0 12345 67890 5")).toEqual(["00012345678905"]);
  });
  it("reads a UPC followed by run-on digits", () => {
    expect(extractGtins("UPC 036000291452; lots 1103")).toEqual(["00036000291452"]);
    expect(extractGtins("UPC 036000291452 1103")).toEqual(["00036000291452"]);
  });
  it("never reads a bare digit run, even one with a valid check digit", () => {
    expect(extractGtins("Lot 036000291452 exp 06/2027")).toEqual([]);
  });
  it("does not read a lot number that follows filler after the label", () => {
    expect(extractGtins("UPC see lot 12345678")).toEqual([]);
  });
  it("drops long digit runs that fail the check digit (lot numbers, dates)", () => {
    expect(extractGtins("Lot 20261101 exp 20270301 id 123456789013")).toEqual([]);
  });
  it("returns nothing for empty text", () => {
    expect(extractGtins(null)).toEqual([]);
  });
});

describe("matchRecalls", () => {
  it("alerts on an exact GTIN, whichever length the item stores", () => {
    const r = matchRecalls(
      [{ id: "a", gtin14: "012345678905" }, { id: "b", gtin14: "0036000291452" }],
      recalls
    );
    expect(r.alerts).toEqual([
      { itemId: "a", recallNumber: "F-0001-2026", gtin14: "00012345678905" },
      { itemId: "b", recallNumber: "F-0002-2026", gtin14: "00036000291452" },
    ]);
  });

  it("does not alert on a different GTIN from the same brand", () => {
    const r = matchRecalls(
      [{ id: "c", gtin14: "00012345678912", brand: "Acme Foods", name: "Crunchy Peanut Butter" }],
      recalls
    );
    expect(r.alerts).toEqual([]);
  });

  it("records a brand + name match as a note and never as an alert", () => {
    const r = matchRecalls(
      [{ id: "d", brand: "Acme Foods", name: "Crunchy Peanut Butter" }],
      recalls
    );
    expect(r.alerts).toEqual([]);
    expect(r.notes).toEqual([{ itemId: "d", recallNumber: "F-0001-2026", reason: "brand_and_name" }]);
  });

  it("does not match a near-miss brand", () => {
    const r = matchRecalls(
      [
        { id: "e", brand: "Kind", name: "Whole Milk Yogurt" },
        { id: "f", brand: "Acme", name: "Crunchy Peanut Butter" },
        { id: "g", brand: "Harbour Seafood", name: "Smoked Salmon" },
      ],
      recalls
    );
    expect(r.alerts).toEqual([]);
    expect(r.notes.map((n) => n.itemId)).toEqual(["f"]);
  });

  it("does not alert for an item with an invalid or missing code", () => {
    const r = matchRecalls([{ id: "h", gtin14: "12345" }, { id: "i" }], recalls);
    expect(r).toEqual({ alerts: [], notes: [] });
  });
});
