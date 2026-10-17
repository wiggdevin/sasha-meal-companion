import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HELD_ALLERGEN_TEXT } from "@/lib/policy/allergen-holds";
import { heldAllergenLine } from "@/lib/policy/held-allergens";

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

describe("held allergen wording (W101)", () => {
  it("says Not verified with Evidence under review, and names the allergen", () => {
    expect(HELD_ALLERGEN_TEXT).toBe("Not verified. Evidence under review");
    expect(heldAllergenLine("Peanut")).toBe("Peanut: Not verified. Evidence under review");
  });

  // Every surface that shows a held allergen builds its line from the shared words; none types them.
  it("keeps the held words in lib/policy and out of every component", () => {
    const typed = [...sources("components"), ...sources("app")].filter((file) =>
      /Evidence under review/i.test(readFileSync(file, "utf8")));
    expect(typed).toEqual([]);
    const users = [...sources("components"), ...sources("app")].filter((file) =>
      /heldAllergenLine|HELD_ALLERGEN_TEXT/.test(readFileSync(file, "utf8"))).sort();
    expect(users).toEqual(["components/FoodSheet.tsx", "components/coach/editors/AllergenFindingLines.tsx"]);
  });
});
