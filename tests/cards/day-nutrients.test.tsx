import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import DayNutrients from "@/components/DayNutrients";
import type { LoggedFood, Macros, ResolvedDay } from "@/lib/types";
import type { NutrientValue } from "@/lib/nutrients/snapshot";

const ZERO: Macros = { kcal: 0, protein: 0, carbs: 0, fat: 0 };

describe("DayNutrients", () => {
  const value = (amount: number | null): NutrientValue => ({ amount, unit: "g",
    basis: "per_100g", source: "catalog", source_version: "1", revision_id: 1 });

  const dayWith = (fiber: number | null, items = 1): ResolvedDay => ({
    date: "2026-09-20", dayType: "rest", isFloorDay: false, targets: null, slots: [],
    consumed: ZERO, waterCups: 0,
    extras: [{ id: "e1", foodId: "f1", name: "Bowl", portionLabel: "bowl", qty: 1, grams: 200,
      macros: ZERO, at: "2026-09-20T12:00:00.000Z",
      items: Array.from({ length: items }, (_, i) => ({
        id: `i${i}`, seq: i + 1, food_ref_id: `r${i}`, grams: 100, qty: 1, unit: "portion",
        snapshot: { fiber_total: value(fiber) } as unknown as Record<string, NutrientValue>,
        foodId: `f${i}`, name: "Bowl", portionLabel: "bowl", macros: ZERO,
      })),
    }] as unknown as LoggedFood[],
  });

  const empty: ResolvedDay = { ...dayWith(null), extras: [] };

  it("stays hidden on a day with nothing measured", () => {
    expect(renderToStaticMarkup(<DayNutrients day={empty} />)).toBe("");
  });

  it.each([
    ["under", 10, "Under your 20–25 g band"],
    ["in band", 22, "In your 20–25 g band"],
    ["over", 40, "Over your 20–25 g band"],
  ])("reads a %s day off %s g of fibre", (_state, fiber, copy) => {
    expect(renderToStaticMarkup(<DayNutrients day={dayWith(fiber as number)} />))
      .toContain(copy as string);
  });

  it("says the fibre is unknown rather than printing a zero", () => {
    const markup = renderToStaticMarkup(<DayNutrients day={dayWith(null)} />);
    expect(markup).toContain("No fibre logged yet");
    expect(markup).not.toContain("0 g");
  });

  it("counts coverage over the tracked micros, not over what was logged", () => {
    expect(renderToStaticMarkup(<DayNutrients day={dayWith(22)} />))
      .toMatch(/\d+ of \d+ nutrients have data today/);
  });
});
