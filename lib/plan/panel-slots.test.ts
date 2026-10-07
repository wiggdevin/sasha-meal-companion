/**
 * Phase 19 §4 / §7: `projectPanelSlots` tells an explicit Clear from an empty slot and says what an
 * eaten slot's energy rests on, from stored state only, never from a meal's display name.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  EATEN_ESTIMATE_NAME, EATEN_LOGGED_NAME,
} from "@/lib/plan/eaten-estimate";
import { eatenEnergyBasisOf, projectPanelSlots } from "@/lib/plan/panel-slots";
import { getMealOptions } from "@/lib/meals";
import { resolveDay } from "@/lib/resolve";
import { clearMeal } from "@/lib/today/meal-actions";
import {
  account, build, DATE, eatenAt, entry, item, line, saved, slotOf,
} from "@/lib/rebalance/__fixtures__/days";

describe("Basis ignores names (round-8 BLOCK)", () => {
  it("never reads a saved title as an estimate or a log", () => {
    for (const title of [EATEN_ESTIMATE_NAME, EATEN_LOGGED_NAME]) {
      const store = account();
      store.days[DATE] = { date: DATE, eaten: eatenAt("meal-2"),
        itemOverrides: { "meal-2": saved(0, title) } };
      const slot = slotOf(build(store).slots, "meal-2");
      expect(slot.meal?.name).toBe(title);
      expect(slot.eatenEnergyBasis).toBe("unknown");

      store.days[DATE].itemOverrides = { "meal-2": saved(450, title) };
      expect(slotOf(build(store).slots, "meal-2").eatenEnergyBasis).toBe("components");
    }
  });

  it("projects a real frozen estimate as estimate, with a log as log, without a target as unknown", () => {
    const store = account();
    store.days[DATE] = { date: DATE, eaten: eatenAt("meal-3") };
    const estimate = slotOf(build(store).slots, "meal-3");
    expect(estimate.macros.kcal).toBeGreaterThan(0);
    expect(estimate.eatenEnergyBasis).toBe("estimate");

    store.days[DATE].extras = [entry("dinner", [item({ reported: 640 })], "meal-3")];
    expect(slotOf(build(store).slots, "meal-3").eatenEnergyBasis).toBe("log");

    const noTarget = account(null);
    noTarget.days[DATE] = { date: DATE, eaten: eatenAt("meal-3") };
    expect(slotOf(build(noTarget).slots, "meal-3").eatenEnergyBasis).toBe("unknown");
  });

  it("follows the Plan panel's logged shell only while its log is filed", () => {
    const store = account();
    store.days[DATE] = { date: DATE, eaten: eatenAt("meal-2"),
      itemOverrides: { "meal-2": { baseMealId: null, title: EATEN_LOGGED_NAME, components: [] } },
      extras: [entry("lunch", [item({ reported: 700 })], "meal-2")] };
    expect(slotOf(build(store).slots, "meal-2").eatenEnergyBasis).toBe("log");
    store.days[DATE].extras = [];
    expect(slotOf(build(store).slots, "meal-2").eatenEnergyBasis).toBe("unknown");
  });

  it("counts a time-edit snapshot as components until a log under the slot replaces it", () => {
    const store = account();
    store.days[DATE] = { date: DATE, eaten: eatenAt("meal-1"),
      itemOverrides: { "meal-1": { baseMealId: null, followPlan: true, time: "08:30",
        components: [line("Oats", 380)] } } };
    expect(slotOf(build(store).slots, "meal-1").eatenEnergyBasis).toBe("components");
    store.days[DATE].extras = [entry("breakfast", [item({ reported: 300 })], "meal-1")];
    const logged = slotOf(build(store).slots, "meal-1");
    // resolveDay suppresses the snapshot (eaten: false, meal: null): the log is the record.
    expect(logged.eaten).toBe(false);
    expect(logged.eatenEnergyBasis).toBe("log");
  });

  it("reads an eaten recipe snapshot as components and an uneaten slot as none", () => {
    const store = account();
    store.days[DATE] = { date: DATE, eaten: eatenAt("meal-3"),
      consumedSlots: { "meal-3": { baseMealId: "recipe:r", title: "Stew", components: [line("Stew", 520)] } },
      itemOverrides: { "meal-2": saved(500, "Lunch") } };
    const { slots } = build(store);
    expect(slotOf(slots, "meal-3").eatenEnergyBasis).toBe("components");
    expect(slotOf(slots, "meal-2").eatenEnergyBasis).toBe("none");
    expect(slotOf(slots, "meal-1").eatenEnergyBasis).toBe("none");
  });

  it("never counts a timestamp-only ritual's date-rotated library meal (round-1 BLOCK)", () => {
    const store = account();
    store.days[DATE] = { date: DATE, eaten: { coffee: `${DATE}T07:00:00Z` } };
    const latte = slotOf(build(store).slots, "coffee");
    // resolveDay shows a library meal chosen by date; nothing stored says what was eaten.
    expect(latte.eaten).toBe(true);
    expect(latte.components.length).toBeGreaterThan(0);
    expect(latte.eatenEnergyBasis).toBe("unknown");
    store.days[DATE].extras = [entry("latte", [item({ reported: 125 })], "coffee")];
    expect(slotOf(build(store).slots, "coffee").eatenEnergyBasis).toBe("log");
  });

  it("counts a ritual's stored meal as components", () => {
    const store = account();
    store.days[DATE] = { date: DATE, eaten: { coffee: `${DATE}T07:00:00Z` },
      itemOverrides: { coffee: saved(90, "Espresso") } };
    expect(slotOf(build(store).slots, "coffee").eatenEnergyBasis).toBe("components");
  });

  it("a saved swap id is a planned choice: with its own log the ritual is the logged shell (round-2 BLOCK)", () => {
    const latte = getMealOptions("rest", "coffee")[0];
    expect(latte.id).toBe("coffee--latte");
    const store = account();
    store.days[DATE] = { date: DATE, eaten: { coffee: `${DATE}T07:00:00Z` }, swaps: { coffee: latte.id } };
    const shown = slotOf(build(store).slots, "coffee");
    expect(shown.meal?.id).toBe(latte.id);
    expect(shown.macros.kcal).toBeGreaterThan(0);
    expect(shown.eatenEnergyBasis).toBe("unknown");

    store.days[DATE].extras = [entry("latte", [item({ reported: 100 })], "coffee")];
    const { day, slots } = build(store);
    const logged = slotOf(slots, "coffee");
    expect(logged.meal?.name).toBe(EATEN_LOGGED_NAME);
    expect(logged.components).toEqual([]);
    expect(logged.macros.kcal).toBe(0);
    expect(logged.eaten).toBe(true);
    expect(logged.eatenEnergyBasis).toBe("log");
    expect(day.consumed.kcal).toBe(100);
  });

  it("keeps the Latte when the log is filed under another slot", () => {
    const store = account();
    store.days[DATE] = { date: DATE, eaten: { coffee: `${DATE}T07:00:00Z` },
      swaps: { coffee: "coffee--latte" }, extras: [entry("oats", [item({ reported: 100 })], "meal-1")] };
    const { day, slots } = build(store);
    const coffee = slotOf(slots, "coffee");
    expect(coffee.meal?.id).toBe("coffee--latte");
    expect(coffee.macros.kcal).toBeGreaterThan(0);
    expect(coffee.eatenEnergyBasis).toBe("unknown");
    expect(day.consumed.kcal).toBe(Math.round(coffee.macros.kcal + 100));
  });

  it("keeps a ritual's saved food override with a log under it as before", () => {
    const store = account();
    store.days[DATE] = { date: DATE, eaten: { coffee: `${DATE}T07:00:00Z` },
      itemOverrides: { coffee: saved(90, "Espresso") },
      extras: [entry("extra", [item({ reported: 100 })], "coffee")] };
    const { day, slots } = build(store);
    const coffee = slotOf(slots, "coffee");
    expect(coffee.meal?.name).toBe("Espresso");
    expect(coffee.macros.kcal).toBe(90);
    expect(coffee.eatenEnergyBasis).toBe("components");
    expect(day.consumed.kcal).toBe(190);
  });

  it("never reads a cleared or followPlan-shell override as a stored meal", () => {
    const store = account();
    store.days[DATE] = { date: DATE, eaten: eatenAt("meal-2"),
      itemOverrides: { "meal-2": { ...saved(400, "Lunch"), cleared: true } } };
    expect(slotOf(build(store).slots, "meal-2").eatenEnergyBasis).toBe("unknown");
    store.days[DATE].itemOverrides = { "meal-2": { baseMealId: null, followPlan: true, components: [] } };
    expect(slotOf(build(store).slots, "meal-2").eatenEnergyBasis).toBe("estimate");
  });

  it("has no code path that reads a meal's name (source check)", () => {
    const source = readFileSync(path.join(__dirname, "panel-slots.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(source).not.toMatch(/\.name\b|\btitle\b/);
    expect(source).not.toMatch(/EATEN_(ESTIMATE|LOGGED|UNKNOWN)_NAME/);
  });
});

describe("Clear is not empty (round-6 BLOCK 3)", () => {
  it("marks only the explicit Clear and leaves ResolvedSlot unchanged", () => {
    const store = account();
    store.days[DATE] = { date: DATE, itemOverrides: { "meal-1": clearMeal(undefined, null) } };
    const day = resolveDay(store, DATE);
    const [first, second] = [day.slots[0], day.slots[1]];
    expect(first.meal).toBeNull();
    expect(second.meal).toBeNull();
    expect("cleared" in first).toBe(false);
    expect("cleared" in second).toBe(false);
    const slots = projectPanelSlots(day, store.days[DATE]);
    expect(slots.map((slot) => slot.slot)).toEqual(day.slots.map((slot) => slot.slot));
    expect(slots[0].cleared).toBe(true);
    expect(slots[1].cleared).toBe(false);
    expect(slots[0]).toMatchObject(first);
  });

  it("leaves an uneaten removed slot out of the day, and projects an untouched date", () => {
    const store = account();
    store.days[DATE] = { date: DATE, itemOverrides: { "meal-2": { ...saved(400), removed: true } } };
    expect(build(store).slots.map((slot) => slot.slot)).toEqual(["meal-1", "meal-3"]);
    const untouched = account();
    const { slots } = build(untouched);
    expect(slots.every((slot) => !slot.cleared && slot.eatenEnergyBasis === "none")).toBe(true);
    expect(eatenEnergyBasisOf(slots[0], undefined)).toBe("none");
  });
});
