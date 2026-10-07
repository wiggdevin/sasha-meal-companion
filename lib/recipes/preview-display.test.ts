import { describe, expect, it } from "vitest";
import { displayMinutes } from "@/lib/recipes/preview-display";

describe("displayMinutes", () => {
  it("keeps short times in minutes and turns long ones into hours", () => {
    expect(displayMinutes(25)).toBe("25 min");
    expect(displayMinutes(60)).toBe("1 hr");
    expect(displayMinutes(75)).toBe("1 hr 15 min");
    expect(displayMinutes(488)).toBe("8 hr 8 min");
  });
});
