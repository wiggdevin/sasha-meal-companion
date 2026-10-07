/**
 * The coach's "still to eat" comes from the same pool as the slot shares (lib/plan/slot-share.ts
 * remainingPool): an overspent macro must not leave the others asking for more energy than the day
 * has left. The numbers are the owner's 2026-10-04 rest day with Meals 2 and 3 eaten.
 */
import { describe, expect, it } from "vitest";
import { toDayContext } from "@/lib/server/day-context";
import type { ResolvedDay } from "@/lib/types";

function day(consumed: ResolvedDay["consumed"]): ResolvedDay {
  return { date: "2026-10-04", dayType: "rest", isFloorDay: false,
    targets: { kcal: 1891, protein: 195, carbs: 154, fat: 55 },
    slots: [], extras: [], consumed, waterCups: 0 } as ResolvedDay;
}

describe("the coach's remainder", () => {
  it("fits protein, fat and carbs inside the kcal that are left", () => {
    // Eggs & rice plus scallops: 1669 kcal, 122 P, 136 C, 71 F (16 g over the day's fat).
    const context = toDayContext(day({ kcal: 1669, protein: 122, carbs: 136, fat: 71 }),
      "America/Denver", []);
    // Before: 222 kcal left, 73 g protein, 18 g carbs, 0 g fat (364 kcal of macros).
    expect(context.remaining).toEqual({ kcal: 222, protein: 56, carbs: 0, fat: 0 });
    expect(context.stillToEat).toBe("222 kcal left, 56 g protein, 0 g carbs, 0 g fat");
  });

  it("is unchanged when every macro fits", () => {
    const context = toDayContext(day({ kcal: 495, protein: 40, carbs: 50, fat: 15 }),
      "America/Denver", []);
    expect(context.remaining).toEqual({ kcal: 1396, protein: 155, carbs: 104, fat: 40 });
  });
});
