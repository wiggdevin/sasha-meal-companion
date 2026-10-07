import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ProjectedDayTotals from "./ProjectedDayTotals";
import type { Macros } from "@/lib/types";
import { resolveDay } from "@/lib/resolve";
import { defaultStore } from "@/lib/store";

/** The words a reader sees, with the calorie figures' colour spans taken out. */
const text = (markup: string) => markup.replace(/<span class="kcal font-semibold">([^<]*)<\/span>/g, "$1");

const consumed: Macros = { kcal: 1200, protein: 80, carbs: 130, fat: 69 };
const targets: Macros = { kcal: 2000, protein: 150, carbs: 200, fat: 70 };

describe("ProjectedDayTotals", () => {
  it("adds the selected portion to actual consumption and marks only exceeded goals", () => {
    const added: Macros = { kcal: 500, protein: 20, carbs: 40, fat: 51 };
    const markup = renderToStaticMarkup(
      <ProjectedDayTotals projection={{ consumed, targets }} added={added} />,
    );
    expect(markup).toContain("Fat 69 → 120 / 70 g");
    expect(text(markup)).toContain("Calories 1,200 → 1,700 / 2,000 kcal");
    expect(markup).toContain('<span class="kcal font-semibold">1,700</span>');
    expect(markup).toContain('aria-label="Fat 69 to 120 of 70 g, 50 g over"');
    expect(markup).toContain('data-over-goal="fat"');
    expect(markup).not.toContain('data-over-goal="calories"');
  });

  it("replaces a consumed meal when planning an already eaten slot", () => {
    const added: Macros = { kcal: 600, protein: 50, carbs: 40, fat: 20 };
    const replaced: Macros = { kcal: 400, protein: 30, carbs: 20, fat: 10 };
    const markup = renderToStaticMarkup(
      <ProjectedDayTotals projection={{ consumed, targets }} added={added} replaced={replaced} />,
    );
    expect(text(markup)).toContain("Calories 1,200 → 1,400 / 2,000 kcal");
    expect(markup).toContain("Fat 69 → 79 / 70 g");
  });

  it("uses the resolved eaten slot inside consumed before replacing it", () => {
    const store = defaultStore();
    store.days["2026-09-07"] = { date: "2026-09-07", eaten: { "meal-1": "2026-09-07T12:00:00Z" },
      itemOverrides: { "meal-1": { baseMealId: null, title: "Lunch", components: [{
        name: "Lunch", role: "protein", qty: 1, unit: "whole",
        macros: { kcal: 400, protein: 30, carbs: 20, fat: 10 },
      }] } } };
    const day = resolveDay(store, "2026-09-07");
    const eaten = day.slots.find((slot) => slot.slot === "meal-1")!;
    expect(day.consumed.kcal).toBe(400);
    const markup = renderToStaticMarkup(<ProjectedDayTotals
      projection={{ consumed: day.consumed, targets }}
      replaced={eaten.macros} added={{ kcal: 600, protein: 50, carbs: 40, fat: 20 }} />);
    expect(text(markup)).toContain("Calories 400 → 600 / 2,000 kcal");
  });

  it("keeps an over-target calorie row in the alert colour, not the calorie colour", () => {
    const markup = renderToStaticMarkup(<ProjectedDayTotals projection={{ consumed, targets }}
      added={{ kcal: 1000, protein: 0, carbs: 0, fat: 0 }} />);
    expect(markup).toContain('data-over-goal="calories"');
    expect(markup).not.toContain("kcal font-semibold");
  });

  it("does not invent projected numbers without targets or measured nutrition", () => {
    expect(renderToStaticMarkup(<ProjectedDayTotals projection={{ consumed, targets: null }}
      added={consumed} />)).toContain("Daily targets unavailable");
    expect(renderToStaticMarkup(<ProjectedDayTotals projection={{ consumed, targets }}
      added={null} />)).toContain("Nutrition data unavailable");
  });
});
