import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import SlotCard, { SlotCardEnter } from "./SlotCard";
import type { ResolvedSlot } from "@/lib/types";

const baseSlot: ResolvedSlot = {
  slot: "meal-1",
  time: "12:00",
  label: "Lunch",
  meal: {
    id: "test-meal",
    name: "Chicken and rice",
    slot: "meal-1",
    components: [],
    macros: { kcal: 500, protein: 40, carbs: 50, fat: 10 },
    prepMinutes: 10,
    tags: [],
  },
  components: [],
  macros: { kcal: 500, protein: 40, carbs: 50, fat: 10 },
  eaten: false,
};

function renderSlot(variant: "focus" | "standard") {
  return renderToStaticMarkup(
    <SlotCard
      slot={baseSlot}
      variant={variant}
      canSwap={true}
      onToggleEaten={() => {}}
      onOpenSwap={() => {}}
      onOpenNote={() => {}}
    />,
  );
}

describe("SlotCard completion colors", () => {
  it("renders one Plan action for an empty slot that is not the focus", () => {
    const markup = renderToStaticMarkup(<SlotCard slot={{ ...baseSlot, meal: null, components: [],
      macros: { kcal: 0, protein: 0, carbs: 0, fat: 0 } }} variant="standard"
      canSwap onToggleEaten={() => {}} onOpenSwap={() => {}}
      onPlanWithCoach={() => {}} onLogWhatYouAte={() => {}} />);
    expect(markup).toContain(">Plan<");
    expect(markup).not.toContain("Nothing planned yet.");
    expect(markup).not.toContain("Log what you ate");
  });

  it("renders only planning and logging actions for an empty focus slot", () => {
    const markup = renderToStaticMarkup(<SlotCard slot={{ ...baseSlot, meal: null, components: [],
      macros: { kcal: 0, protein: 0, carbs: 0, fat: 0 } }} variant="focus"
      canSwap onToggleEaten={() => {}} onOpenSwap={() => {}}
      onPlanWithCoach={() => {}} onLogWhatYouAte={() => {}} />);
    expect(markup).toContain("Nothing planned yet.");
    expect(markup).toContain("Plan with Sasha");
    expect(markup).toContain("Log what you ate");
    expect(markup).not.toContain("Mark eaten, Lunch");
    expect(markup).not.toContain("Swap Lunch");
  });

  it("uses the dish name as the title and keeps the collapsed time concise", () => {
    const markup = renderSlot("standard");
    expect(markup).toContain("Chicken and rice");
    expect(markup).toContain("12:00");
    expect(markup).toContain("PM");
    expect(markup).toContain('aria-label="Lunch, scheduled for 12:00 pm"');
    expect(markup).toContain('data-meal-time="true"');
    expect(markup).toContain('data-meal-calories="true"');
    expect(markup).toContain('data-consume-control="tick"');
    expect(markup).not.toContain("border-l border-hairline");
    expect(markup.indexOf("Chicken and rice")).toBeLessThan(markup.indexOf("12:00"));
    expect(markup.indexOf("Chicken and rice")).toBeLessThan(markup.indexOf('data-meal-calories="true"'));
  });

  it("leads the hero pill with the slot's name, then its time (meal cards v2: never a bare number)", () => {
    const markup = renderSlot("standard");
    expect(markup).toContain('data-meal-status="later"');
    expect(markup.indexOf('aria-hidden="true">Lunch</span>')).toBeGreaterThan(-1);
    expect(markup.indexOf('aria-hidden="true">Lunch</span>')).toBeLessThan(markup.indexOf(">12:00</span>"));
    expect(markup).not.toContain("data-meal-position");
  });

  it("presents a planned meal in the After Dark hero and nutrition band", () => {
    const markup = renderSlot("standard");
    expect(markup).toContain('data-after-dark-meal="true"');
    expect(markup).toContain('data-after-dark-hero="true"');
    expect(markup).toContain('data-after-dark-nutrition="true"');
    expect(markup.indexOf('data-after-dark-hero="true"')).toBeLessThan(markup.indexOf('data-after-dark-nutrition="true"'));
    expect(markup).toContain('data-consume-control="tick"');
    // Meal cards v3: no proportional macro bar on any card.
    expect(markup).not.toContain("data-macro-composition");
  });

  it.each(["focus", "standard"] as const)("sets the %s card's calorie number in the shared calorie colour", (variant) => {
    // Owner, 2026-10-03: persimmon and a step bolder, inside the matte card (DESIGN.md §Colors).
    const markup = renderSlot(variant);
    expect(markup).toMatch(/<strong class="kcal [^"]*font-medium[^"]*">500<\/strong>/);
    expect(markup).toMatch(/class="matte [^"]*"|class="[^"]* matte /);
    expect(markup).not.toContain("macro-kcal");
  });

  it("keeps gram counts off a collapsed card and shows them on a featured one", () => {
    expect(renderSlot("standard")).not.toContain('data-macro-legend="true"');
    expect(renderSlot("focus")).toContain('data-macro-legend="true"');
  });

  it("sets a featured meal's calories on the hero and its grams in the divider's spec panel", () => {
    const markup = renderSlot("focus");
    const hero = markup.indexOf('data-after-dark-hero="true"');
    const calories = markup.indexOf('data-meal-calories="true"');
    const nutrition = markup.indexOf('data-after-dark-nutrition="true"');
    const legend = markup.indexOf('data-macro-legend="true"');
    const expander = markup.indexOf('aria-label="Expand Lunch"');
    expect(hero).toBeGreaterThan(-1);
    expect(calories).toBeGreaterThan(hero);
    expect(nutrition).toBeGreaterThan(calories);
    expect(legend).toBeGreaterThan(nutrition);
    expect(expander).toBeGreaterThan(legend);
  });

  it("speaks a compact meal's numbers from the hero's figures (v3: no bar)", () => {
    const markup = renderSlot("standard");
    const figures = markup.indexOf("data-meal-figures");
    expect(figures).toBeGreaterThan(markup.indexOf('data-after-dark-hero="true"'));
    expect(markup.slice(figures, figures + 400)).toContain('aria-label="500 calories: 40 grams protein, 50 grams carbs, 10 grams fat"');
    expect(markup).not.toContain("data-compact-bar");
  });

  it("shows an unlabeled illustrative food photo for a recognized meal, not the generic wallpaper", () => {
    const markup = renderSlot("focus");
    expect(markup).toContain('url=%2Fmeal-art%2Fchicken.webp');
    expect(markup).not.toContain("Illustrative photo");
    expect(markup).not.toContain('src="/ground-v1.jpg"');
  });

  it("does not keep a chicken photo after the ingredients no longer include chicken", () => {
    const markup = renderToStaticMarkup(<SlotCard slot={{ ...baseSlot, components: [{
      name: "Jasmine rice", qty: 100, unit: "g", role: "carb",
      macros: { kcal: 130, protein: 2, carbs: 28, fat: 0 },
    }] }} variant="focus" canSwap={false}
      onToggleEaten={() => {}} onOpenSwap={() => {}} />);
    expect(markup).not.toContain('/meal-art/chicken.webp');
  });

  it.each(["focus", "standard"] as const)("keeps uneaten %s meals light", (variant) => {
    const markup = renderSlot(variant);
    expect(markup).toContain("surface flex");
    expect(markup).not.toContain("meal-card-in");
  });
  it("keeps eaten meals at full strength on the eaten surface", () => {
    const markup = renderToStaticMarkup(<SlotCard slot={{ ...baseSlot, eaten: true }}
      variant="standard" canSwap onToggleEaten={() => {}} onOpenSwap={() => {}} />);
    expect(markup).toContain("meal-card-in");
    expect(markup).toContain("meal-card-complete");
    expect(markup).not.toMatch(/class="[^"]*\bts\b/);
    // Eaten keeps full strength; the chip and the button carry the state, and an eaten meal is not swapped.
    expect(markup).not.toContain("opacity-70");
    expect(markup).not.toContain('aria-label="Swap Lunch"');
  });

  it("does not leave a filter on the entrance wrapper", () => {
    const markup = renderToStaticMarkup(<SlotCardEnter index={0}><div>Meal</div></SlotCardEnter>);
    expect(markup).not.toMatch(/style="[^"]*filter:/);
  });
});

import { draggedMealTime } from "./useMealReschedule";
import { timelineWave } from "./MealTimeline";

describe("meal card editing and scheduling", () => {
  it.each(["focus", "standard", "compact"] as const)("exposes keyboard editing for %s cards", (variant) => {
    const markup = renderToStaticMarkup(<SlotCard slot={baseSlot} variant={variant}
      canSwap onToggleEaten={() => {}} onOpenSwap={() => {}}
      onOpenEdit={() => {}} onTimeChange={() => {}} />);
    // Editing is inline: the footer expander is the keyboard path; a card tap is pointer-only.
    expect(markup).toContain('aria-label="Expand Lunch"');
    expect(markup).not.toContain('aria-label="Edit Lunch"');
    expect(markup).toContain('aria-label="Swap Lunch"');
    expect(markup).toContain('aria-label="Lunch, scheduled for 12:00 pm"');
    expect(markup).not.toContain("Add note");
    expect(markup).not.toContain(">Change<");
  });

  it("keeps an eaten card editable and its scheduled time visible", () => {
    const markup = renderToStaticMarkup(<SlotCard slot={{ ...baseSlot, eaten: true,
      eatenAt: "2026-09-15T22:34:00.000Z" }} variant="standard"
      canSwap={false} onToggleEaten={() => {}} onOpenSwap={() => {}}
      onOpenEdit={() => {}} />);
    expect(markup).toContain('aria-label="Expand Lunch"');
    expect(markup).toContain('aria-label="Eaten, Lunch. Undo"');
    expect(markup).toContain('aria-label="Lunch, eaten, scheduled for 12:00 pm"');
  });

  it("snaps vertical movement to quarter hours in both directions", () => {
    expect(draggedMealTime("12:00", 88)).toBe("12:30");
    expect(draggedMealTime("12:00", -88)).toBe("11:30");
    expect(draggedMealTime("12:00", 5)).toBe("12:00");
  });

  it("clamps rescheduling within the selected day", () => {
    expect(draggedMealTime("00:15", -1000)).toBe("00:00");
    expect(draggedMealTime("23:30", 1000)).toBe("23:45");
  });

  it("shapes nearby times into a wave around the dragged meal", () => {
    expect(timelineWave(0)).toEqual({ indent: 28, opacity: 1, scale: 1 });
    expect(timelineWave(2).indent).toBeGreaterThan(timelineWave(5).indent);
    expect(timelineWave(8).opacity).toBeLessThan(1);
  });
});

describe("compact meal card", () => {
  const withMacros: ResolvedSlot = { ...baseSlot,
    macros: { kcal: 512.4, protein: 40.4, carbs: 49.6, fat: 10.2 } };

  it.each([
    ["focus", false], ["standard", false], ["compact", false], ["standard", true],
  ] as const)("shows name, time, the four macros in their gauge roles and an expander (%s, eaten %s)",
    (variant, eaten) => {
      const markup = renderToStaticMarkup(<SlotCard slot={{ ...withMacros, eaten }} variant={variant}
        canSwap onToggleEaten={() => {}} onOpenSwap={() => {}} onOpenEdit={() => {}} />);
      expect(markup).toContain("Chicken and rice");
      expect(markup).toContain(eaten ? 'aria-label="Lunch, eaten, scheduled for 12:00 pm"'
        : 'aria-label="Lunch, scheduled for 12:00 pm"');
      expect(markup).toContain('aria-label="512 calories: 40 grams protein, 50 grams carbs, 10 grams fat"');
      expect(markup).not.toContain("data-macro-composition");
      expect(markup).toMatch(/aria-label="Expand Lunch"[^>]*aria-expanded="false"|aria-expanded="false"[^>]*aria-label="Expand Lunch"/);
      expect(markup).not.toContain("<table");
    });

  it("offers no expander on an empty slot: there is no meal to detail", () => {
    const markup = renderToStaticMarkup(<SlotCard slot={{ ...baseSlot, meal: null, components: [],
      macros: { kcal: 0, protein: 0, carbs: 0, fat: 0 } }} variant="standard"
      canSwap onToggleEaten={() => {}} onOpenSwap={() => {}} onPlanWithCoach={() => {}} />);
    expect(markup).not.toContain("Expand Lunch");
  });
});
