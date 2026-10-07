import { describe, expect, it } from "vitest";
import { FAT_G_FLOOR, KCAL_MIN_FLOOR, PROTEIN_G_FLOOR_BY_STAGE, violatesFloors }
  from "@/lib/coach/floors";

const ACTIVE = {
  kcal_train: 2200, kcal_rest: 1750, protein_g: 135, fat_g: 95, carb_g: 200,
  kcal_min: 1650, protein_g_min: 135, fat_g_min: 50, carb_g_min: 0,
};

describe("the floor constants", () => {
  it("match targets.md: fat 50 g, kcal_min 1650, protein per stage", () => {
    expect(FAT_G_FLOOR).toBe(50);
    expect(KCAL_MIN_FLOOR).toBe(1650);
    // Explicit numbers now that the ramp table is deleted (design §5.1).
    expect(PROTEIN_G_FLOOR_BY_STAGE[3]).toBe(135);
    expect(PROTEIN_G_FLOOR_BY_STAGE[1]).toBe(115);
  });
});

describe("violatesFloors", () => {
  it("accepts a proposal that moves calories only", () => {
    expect(violatesFloors({ kcal_train: 2300, kcal_rest: 1800 }, ACTIVE)).toBeNull();
  });

  it("names the fat floor when fat is cut below 50 g", () => {
    expect(violatesFloors({ fat_g: 45 }, ACTIVE)).toBe("fat_g 45 is below the floor of 50 g");
  });

  it("names the protein floor when protein moves at all", () => {
    expect(violatesFloors({ protein_g: 130 }, ACTIVE)).toBe("protein_g 130 is below the floor of 135 g");
  });

  it("names the calorie floor on either day type", () => {
    expect(violatesFloors({ kcal_rest: 1600 }, ACTIVE)).toBe("kcal_rest 1600 is below the floor of 1650 kcal");
    expect(violatesFloors({ kcal_train: 1600 }, ACTIVE)).toBe("kcal_train 1600 is below the floor of 1650 kcal");
  });

  it("names the carb floor and reports the first violation only", () => {
    expect(violatesFloors({ carb_g: -1 }, { ...ACTIVE, carb_g_min: 0 }))
      .toBe("carb_g -1 is below the floor of 0 g");
  });
});
