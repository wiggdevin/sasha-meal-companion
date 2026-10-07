import { describe, expect, it } from "vitest";
import { starterProteinAvailability } from "@/lib/foods/starter-availability";
import { STARTERS } from "@/lib/foods/starter";

describe("starter protein availability", () => {
  it("counts distinct selected proteins only among currently eligible choices", () => {
    const choices = STARTERS.filter((item) => ["tofu-firm", "tempeh", "lentils-cooked"].includes(item.id));
    const marks = { "tofu-firm": "eats", tempeh: "eats", "chicken-breast-roasted": "eats" } as const;
    expect(starterProteinAvailability(marks, choices, 3)).toMatchObject({
      selected: 2, eligible: 3, required: 3, ready: false,
    });
    expect(starterProteinAvailability(marks, choices, 2).ready).toBe(true);
  });
});
