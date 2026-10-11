import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as floors from "@/lib/coach/floors";
import { FAT_G_FLOOR, violatesFloors } from "@/lib/coach/floors";

/** An account whose own revision records a 1,430 kcal minimum (its macro minimum: 4·145 + 9·50 + 4·100). */
const ACTIVE = {
  kcal_train: 2000, kcal_rest: 1700, protein_g: 145, fat_g: 70, carb_g: 200,
  kcal_min: 1430, protein_g_min: 145, fat_g_min: 50, carb_g_min: 100,
};

describe("the floor constants", () => {
  it("keep only the product-wide fat floor; no first-client calorie or protein number (W008)", () => {
    expect(FAT_G_FLOOR).toBe(50);
    expect(floors).not.toHaveProperty("KCAL_MIN_FLOOR");
    expect(floors).not.toHaveProperty("PROTEIN_G_FLOOR_BY_STAGE");
  });

  it("lib/coach holds no 1650 kcal floor", () => {
    const src = readFileSync(path.join(process.cwd(), "lib/coach/floors.ts"), "utf8");
    expect(src).not.toMatch(/1650|1,650/);
  });
});

describe("violatesFloors", () => {
  it("accepts a proposal that moves calories only", () => {
    expect(violatesFloors({ kcal_train: 2100, kcal_rest: 1800 }, ACTIVE)).toBeNull();
  });

  it("uses the account minimum from the revision, not a first-client 1,650 kcal floor", () => {
    expect(violatesFloors({ kcal_rest: 1500, kcal_train: 1600 }, ACTIVE)).toBeNull();
    expect(violatesFloors({ kcal_rest: 1400 }, ACTIVE)).toBe("kcal_rest 1400 is below the floor of 1430 kcal");
    expect(violatesFloors({ kcal_train: 1400 }, ACTIVE)).toBe("kcal_train 1400 is below the floor of 1430 kcal");
  });

  it("follows a different account's own minimum", () => {
    const other = { ...ACTIVE, kcal_min: 1900, protein_g_min: 180 };
    expect(violatesFloors({ kcal_rest: 1850 }, other)).toBe("kcal_rest 1850 is below the floor of 1900 kcal");
  });

  it("never lets the calorie floor fall under the revision's own macro minimum", () => {
    // A row whose kcal_min is below 4·protein + 9·fat + 4·carbs minimums (1,430 here).
    const low = { ...ACTIVE, kcal_min: 900 };
    expect(violatesFloors({ kcal_rest: 1000 }, low)).toBe("kcal_rest 1000 is below the floor of 1430 kcal");
  });

  it("treats a malformed kcal_min as no recorded minimum, never as a pass", () => {
    const broken = { ...ACTIVE, kcal_min: Number.NaN };
    expect(violatesFloors({ kcal_rest: 1000 }, broken)).toBe("kcal_rest 1000 is below the floor of 1430 kcal");
  });

  it("names the fat floor when fat is cut below 50 g", () => {
    expect(violatesFloors({ fat_g: 45 }, ACTIVE)).toBe("fat_g 45 is below the floor of 50 g");
  });

  it("names the account's own protein floor", () => {
    expect(violatesFloors({ protein_g: 140 }, ACTIVE)).toBe("protein_g 140 is below the floor of 145 g");
  });

  it("names the carb floor and reports the first violation only", () => {
    expect(violatesFloors({ carb_g: 90, kcal_rest: 100 }, ACTIVE))
      .toBe("carb_g 90 is below the floor of 100 g");
  });
});
