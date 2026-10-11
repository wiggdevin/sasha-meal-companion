/**
 * W030 / audit A066: ticking a generated meal freezes its plate into the slot override; "marked
 * not eaten" (an untick or the toast's Undo) must undo that freeze, so the slot follows the plan
 * again. A later edit is the user's own and stays.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { __resetStoreCache, getDay } from "@/lib/store";
import { saveEatenSlot, saveMealEdit } from "@/lib/plan-day-client";
import { tickMutationId, unfreezeOnUntick } from "@/lib/plan/tick-freeze";
import { itemOverridesSchema } from "@/lib/sync/plan-days-schema";
import type { FoodComponent } from "@/lib/types";
import { resetTestAccount } from "@/tests/helpers/account";

const DATE = "2026-10-06";
const TICK = "2026-10-06T12:40:00.000Z";
const UNTICK = "2026-10-06T12:41:00.000Z";
const part = (name: string, kcal: number): FoodComponent => ({ name, qty: 1, unit: "whole", role: "free",
  macros: { kcal, protein: kcal / 20, carbs: kcal / 10, fat: kcal / 45 } });
const generated = { baseMealId: `suggested:${DATE}:meal-2`, title: "Chicken with rice",
  components: [part("Chicken", 300), part("Rice", 250)] };

beforeEach(async () => {
  await resetTestAccount();
  globalThis.indexedDB = new IDBFactory();
  globalThis.localStorage?.clear?.();
  __resetStoreCache();
});

describe("untick undoes the tick's freeze", () => {
  it("returns an untouched generated slot to the plan", async () => {
    await saveEatenSlot(DATE, "meal-2", TICK, TICK, generated);
    expect(getDay(DATE)?.itemOverrides?.["meal-2"]).toMatchObject({ baseMealId: generated.baseMealId,
      components: generated.components });
    expect(getDay(DATE)?.itemOverrides?.["meal-2"]?.followPlan).toBeUndefined();
    await saveEatenSlot(DATE, "meal-2", null, UNTICK);
    expect(getDay(DATE)?.eaten?.["meal-2"]).toBeUndefined();
    expect(getDay(DATE)?.itemOverrides?.["meal-2"]).toBeUndefined();
  });

  it("keeps a moved time as a food-less followPlan shell", async () => {
    await saveMealEdit(DATE, "meal-2", null, { time: "13:15", planned: [] });
    await saveEatenSlot(DATE, "meal-2", TICK, TICK, generated);
    await saveEatenSlot(DATE, "meal-2", null, UNTICK);
    expect(getDay(DATE)?.itemOverrides?.["meal-2"]).toEqual({ baseMealId: null, components: [],
      followPlan: true, time: "13:15" });
  });

  it("leaves an edit made after the tick alone", async () => {
    await saveEatenSlot(DATE, "meal-2", TICK, TICK, generated);
    const edited = [part("Chicken", 300)];
    await saveMealEdit(DATE, "meal-2", generated.baseMealId, { components: edited, planned: [] });
    await saveEatenSlot(DATE, "meal-2", null, UNTICK);
    expect(getDay(DATE)?.itemOverrides?.["meal-2"]?.components).toEqual(edited);
  });
});

describe("the tick's freeze id", () => {
  it("is a stable UUID the plan_days schema accepts", () => {
    const id = tickMutationId(DATE, "meal-2", TICK);
    expect(id).toBe(tickMutationId(DATE, "meal-2", TICK));
    expect(id).not.toBe(tickMutationId(DATE, "meal-3", TICK));
    expect(z.uuid().safeParse(id).success).toBe(true);
    expect(itemOverridesSchema.safeParse({ "meal-2": { ...generated, mutationId: id } }).success).toBe(true);
  });

  it("never touches a recipe, a cleared slot or a plain edit", () => {
    const mutationId = tickMutationId(DATE, "meal-2", TICK);
    for (const override of [
      { baseMealId: "recipe:abc", components: [], mutationId },
      { baseMealId: generated.baseMealId, components: [], cleared: true, mutationId },
      { baseMealId: generated.baseMealId, components: generated.components, mutationId: crypto.randomUUID() },
    ]) expect(unfreezeOnUntick(override, DATE, "meal-2", [TICK])).toBe(override);
  });
});
