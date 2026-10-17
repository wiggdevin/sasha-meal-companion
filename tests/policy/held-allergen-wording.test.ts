import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HELD_ALLERGEN_TEXT } from "@/lib/policy/allergen-holds";
import { heldAllergenLine, unknownAllergenFragment } from "@/lib/policy/held-allergens";

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

  // Today's rule mark, the swap and suggestion cards (lib/coach/suggest-verdict.ts, through
  // /api/foods/eligible) and a shopping line all word an unknown allergen with this one fragment.
  it("words a held allergen with the shared line after a food's name", () => {
    const held = { allergen: "peanut", outcome: "unknown" as const, text: HELD_ALLERGEN_TEXT };
    const open = { allergen: "sesame", outcome: "unknown" as const, text: "Check the label" };
    expect(unknownAllergenFragment([held]))
      .toBe("needs review. Peanut: Not verified. Evidence under review.");
    expect(unknownAllergenFragment([open, held]))
      .toBe("cannot be checked for sesame. Peanut: Not verified. Evidence under review.");
    expect(unknownAllergenFragment([open])).toBe("cannot be checked for sesame.");
    expect(unknownAllergenFragment([{ ...held, outcome: "present" as const }])).toBeNull();
  });

  it("keeps every unknown-allergen sentence on the shared fragment", () => {
    const typed = [...sources("lib"), ...sources("components"), ...sources("app")].filter((file) =>
      file !== join("lib", "policy", "held-allergens.ts")
      && /cannot be checked for \$\{/.test(readFileSync(file, "utf8")));
    expect(typed).toEqual([]);
    const users = sources("lib").filter((file) =>
      /unknownAllergenFragment\(/.test(readFileSync(file, "utf8"))).sort();
    expect(users).toEqual(["lib/coach/suggest-verdict.ts", "lib/policy/held-allergens.ts",
      "lib/shopping/rule-marks.ts"]);
  });

  // The onboarding check (W101): the cuisine, country and rule-editor hand-off screens, and the
  // starter foods, render no allergen finding or rule mark, so no held allergen can show there.
  it("shows no allergen finding anywhere in onboarding", () => {
    const readers = sources("components/Onboarding").filter((file) =>
      /AllergenFinding|allergenFinding|heldAllergen|ruleMark|\.allergens\b/.test(readFileSync(file, "utf8")));
    expect(readers).toEqual([]);
  });
});
