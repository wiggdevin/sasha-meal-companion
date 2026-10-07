import { describe, expect, it } from "vitest";
import { mentionedFoodChoices, STARTERS } from "@/lib/foods/starter";

describe("starter preference language", () => {
  it("treats 'don't like tofu' as Avoid without mistaking neutral phrases for Avoid", () => {
    const tofu = STARTERS.filter((item) => item.id === "tofu-firm");
    expect(mentionedFoodChoices("I don't like tofu", tofu).get("tofu-firm")).toBe("avoid");
    expect(mentionedFoodChoices("I do not like tofu", tofu).get("tofu-firm")).toBe("avoid");
    expect(mentionedFoodChoices("No problem with tofu", tofu).get("tofu-firm")).toBeUndefined();
    expect(mentionedFoodChoices("No complaints about tofu", tofu).get("tofu-firm")).toBeUndefined();
  });
});
