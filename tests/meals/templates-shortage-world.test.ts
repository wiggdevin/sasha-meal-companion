import { describe, expect, it } from "vitest";
import { shortageReason } from "@/lib/meals/templates";

describe("shortage copy by food world (W102)", () => {
  it("never says Favor to a closed account", () => {
    expect(shortageReason("dinner", ["starch"])).toBe("No dinner starch fits yet — try another food");
    expect(shortageReason("dinner", ["starch"], "closed")).not.toMatch(/favor/i);
  });
  it("points an open account at Favoring", () => {
    expect(shortageReason("dinner", ["starch"], "open")).toBe("No dinner starch fits yet — try another food or Favor one you like");
  });
});
