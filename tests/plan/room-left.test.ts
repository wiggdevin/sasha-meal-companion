import { describe, expect, it } from "vitest";
import { roomLeftLine } from "@/components/plan/room-left";

describe("roomLeftLine", () => {
  it("says the slot's budget as room left, never as the meal's own macros", () => {
    expect(roomLeftLine({ kcal: 110.6, protein: 27.6, carbs: 0, fat: 0 }))
      .toBe("New ideas fit the room left for this meal: about 111 kcal and 28 g protein.");
    expect(roomLeftLine({ kcal: 240, protein: 0.2, carbs: 30, fat: 9 }))
      .toBe("New ideas fit the room left for this meal: about 240 kcal.");
  });

  it("is quiet without a target and plain when nothing is left", () => {
    expect(roomLeftLine(undefined)).toBeUndefined();
    expect(roomLeftLine({ kcal: 0, protein: 0, carbs: 0, fat: 0 })).toBe("Today’s calories are already planned or eaten.");
  });
});
