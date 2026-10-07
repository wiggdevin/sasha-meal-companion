import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CARD_AMOUNT, CARD_BODY, CARD_EYEBROW, CARD_META, CARD_SECTION, CARD_STEP, CARD_SUMMARY, MEAL_TITLE, ROLE_PX,
} from "@/lib/design/meal-type";

/** KIT §14: one type hierarchy for every meal card (owner, 2026-10-05). */

const STEPS = new Set([12, 14, 16, 20, 28, 40, 64]);
/** The size utilities' pixel values (app/globals.css). */
const PX: Record<string, number> = { "text-tiny": 12, "text-caption": 14, "text-body": 16,
  "text-heading-sm": 20, "text-heading": 28 };
const sizeOf = (classes: string) => {
  const hit = classes.split(/\s+/).find((name) => name in PX);
  if (!hit) throw new Error(`no size utility in "${classes}"`);
  return PX[hit];
};

describe("the meal-card roles", () => {
  it("keep title > section > summary and body > meta at every density", () => {
    for (const density of ["hero", "standard", "compact"] as const) {
      const title = sizeOf(MEAL_TITLE[density]);
      expect(title).toBe(ROLE_PX.title[density]);
      if (density !== "compact") expect(title).toBeGreaterThan(sizeOf(CARD_SECTION));
      expect(title).toBeGreaterThan(sizeOf(CARD_BODY));
    }
    expect(sizeOf(CARD_SECTION)).toBeGreaterThan(sizeOf(CARD_BODY));
    expect(sizeOf(CARD_SECTION)).toBeGreaterThan(sizeOf(CARD_SUMMARY));
    expect(sizeOf(CARD_BODY)).toBeGreaterThan(sizeOf(CARD_META));
  });

  it("use only the seven steps and nothing under 12 px", () => {
    for (const role of [...Object.values(MEAL_TITLE), CARD_SECTION, CARD_SUMMARY, CARD_BODY, CARD_AMOUNT,
      CARD_META, CARD_EYEBROW, CARD_STEP]) {
      const px = sizeOf(role);
      expect(STEPS.has(px)).toBe(true);
      expect(px).toBeGreaterThanOrEqual(12);
    }
  });

  it("set titles in Fraunces 500, and everything else in sans", () => {
    for (const title of Object.values(MEAL_TITLE)) {
      expect(title).toMatch(/\bfont-display\b/);
      expect(title).toMatch(/\bfont-medium\b/);
    }
    for (const role of [CARD_SECTION, CARD_SUMMARY, CARD_BODY, CARD_AMOUNT, CARD_META, CARD_EYEBROW, CARD_STEP]) {
      expect(role).not.toMatch(/\bfont-display\b/);
    }
    // A section is a sentence-case heading, never a tracked eyebrow.
    expect(CARD_SECTION).toMatch(/\bfont-semibold\b/);
    expect(CARD_SECTION).not.toMatch(/\buppercase\b/);
  });
});

/** The cards that show a meal, a recipe or a suggested plate. */
const CARDS = [
  "components/recipes-hub/SuggestionCard.tsx", "components/RecipeResultCard.tsx", "components/RecipeDetails.tsx",
  "components/SlotCardDetail.tsx", "components/plan/IdeaCard.tsx", "components/plan/PhotoResult.tsx",
  "components/plan/DocumentPlan.tsx", "components/LoggedExtras.tsx", "components/CoachComposedCard.tsx",
];

describe("every meal card", () => {
  it.each(CARDS)("%s reads its type from the roles and sets nothing under 12 px", (path) => {
    const source = readFileSync(path, "utf8");
    expect(source).toMatch(/from "@\/lib\/design\/meal-type"/);
    expect(source).not.toMatch(/text-\[(?:[0-9]|1[01])px\]/);
  });

  it.each(["components/AfterDarkCards.module.css", "components/ui/MealNutritionDivider.module.css"])(
    "%s sets no type under 12 px", (path) => {
      const sizes = [...readFileSync(path, "utf8").matchAll(/font-size:\s*(\d+)px/g)].map((m) => Number(m[1]));
      expect(sizes.every((px) => px >= 12)).toBe(true);
    });

  it("puts a suggestion card's close over its photo", () => {
    const source = readFileSync("components/recipes-hub/SuggestionCard.tsx", "utf8");
    expect(source).toMatch(/<CloseButton onPhoto\b/);
  });
});
