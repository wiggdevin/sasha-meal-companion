/**
 * Phase 18 W4 acceptance 4: the substitute graph's `ctx` term from FNDDS dish ingredient lists
 * (scripts/priors/context.ts). Foods that go into dishes beside the same co-ingredients score high,
 * a food never scores against itself, thin evidence scores 0, and the result does not depend on
 * input order.
 */
import { describe, expect, it } from "vitest";
import { buildContext, MIN_DISHES } from "@/scripts/priors/context";
import type { Expansion } from "@/scripts/priors/crosswalk";

const dish = (shares: Record<string, number>): Expansion => ({ shares: new Map(Object.entries(shares)), unmapped: 0, drink: 0 });
const DISHES: Record<string, Expansion> = {
  "1": dish({ beef: 0.4, tortilla: 0.4, onion: 0.2 }),
  "2": dish({ pork: 0.4, tortilla: 0.4, onion: 0.2 }),
  "3": dish({ beef: 0.5, tortilla: 0.3, tomato: 0.2 }),
  "4": dish({ pork: 0.5, tortilla: 0.3, tomato: 0.2 }),
  "5": dish({ beef: 0.6, onion: 0.4 }),
  "6": dish({ pork: 0.6, onion: 0.4 }),
  "7": dish({ apple: 0.6, oat: 0.399, sugar: 0.001 }),
  "8": dish({ apple: 0.5, oat: 0.5 }),
  "9": dish({ apple: 0.5, cinnamon: 0.5 }),
  "10": dish({ banana: 1 }),
  "11": dish({ rice: 0.5, beans: 0.5 }),
};
const codes = Object.keys(DISHES);
const expand = (code: string) => DISHES[code];

describe("the ctx term", () => {
  const context = buildContext(codes, expand);

  it("counts multi-ingredient dishes only, and foods with at least MIN_DISHES dishes", () => {
    expect(context.dishes).toBe(10);
    expect(MIN_DISHES).toBe(3);
    expect(context.ctx("rice", "beans")).toBe(0);
  });

  it("scores foods that share co-ingredients, and never a food against itself", () => {
    expect(context.ctx("beef", "pork")).toBeGreaterThan(0.9);
    expect(context.ctx("beef", "pork")).toBe(context.ctx("pork", "beef"));
    expect(context.ctx("beef", "beef")).toBe(0);
    expect(context.ctx("beef", "apple")).toBe(0);
  });

  it("ignores a trace ingredient under MIN_SHARE", () => {
    expect(context.ctx("sugar", "apple")).toBe(0);
  });

  it("does not depend on the order of the dishes", () => {
    const reversed = buildContext([...codes].reverse(), expand);
    expect(reversed.ctx("beef", "pork")).toBe(context.ctx("beef", "pork"));
    expect(reversed.dishes).toBe(context.dishes);
  });
});
