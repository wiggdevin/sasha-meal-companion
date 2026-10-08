/**
 * The owner's plate-plausibility sheet (Phase 18 W8 acceptance 7): the generator gives each
 * distinct (meal, plate) one row, every row is a real open-world plate, and the scorer applies the
 * Phase 17 Acceptance 9 numbers per cuisine.
 */
import { describe, expect, it } from "vitest";
import { labelRows, scoreSheet } from "@/scripts/eval/universe-plates-sheet";
import { CUISINES } from "@/lib/foods/universe/vocabulary";

describe("universe plate sheet", () => {
  it("lists each distinct plate once, for all four meals", () => {
    const rows = labelRows(2);
    const keys = rows.map((row) => `${row.occasion}|${row.plate}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(rows.map((row) => row.occasion))).toEqual(new Set(["breakfast", "lunch", "snack", "dinner"]));
    for (const row of rows) expect(row.plate.split(" + ").length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("scores a plate for every cuisine that produced it, and fails a cuisine under 85 %", () => {
    const header = "id,occasion,plate,cuisines,plausible,note";
    const good = Array.from({ length: 10 }, (_, i) => `b-${i},breakfast,"Oatmeal + Banana",all,y,`);
    const pass = scoreSheet([header, ...good].join("\n"));
    expect(pass.passes).toBe(true);
    expect(pass.lines).toHaveLength(CUISINES.length);
    const bad = Array.from({ length: 3 }, (_, i) => `x-${i},dinner,"Tofu + Pineapple",japanese,n,odd`);
    const fail = scoreSheet([header, ...good, ...bad].join("\n"));
    expect(fail.passes).toBe(false);
    expect(fail.lines.find((line) => line.startsWith("japanese"))).toMatch(/FAIL/);
  });
});
