import { describe, expect, it } from "vitest";
import { buildCommitRequest, buildMealCommitRequest } from "@/lib/log-client";
import { logCommitRequestSchema } from "@/lib/log/contract";
import { cardFromRequest, entryPatchFromRow } from "@/lib/log/reconcile";
import type { LoggedFood } from "@/lib/types";

const ITEM = {
  id: "22222222-2222-4222-8222-222222222222",
  foodRefId: "33333333-3333-4333-8333-333333333333",
  revision: { revision_id: 77 }, grams: 140, qty: 140, unit: "g",
};

describe("log entry titles", () => {
  it("puts a trimmed dish title on the commit request", () => {
    const request = buildCommitRequest({
      entryId: "11111111-1111-4111-8111-111111111111",
      eatenAt: new Date("2026-09-20T12:00:00.000Z"), tz: "UTC", slot: "snack",
      title: "  Spaghetti bolognese  ", items: [ITEM],
    });
    expect(request).toMatchObject({ title: "Spaghetti bolognese", slot: "snack" });
    expect(logCommitRequestSchema.parse(request)).toHaveProperty("title", "Spaghetti bolognese");
  });

  it("keeps omitted and explicit-null titles distinct in the canonical request", () => {
    const base = {
      entryId: "11111111-1111-4111-8111-111111111111",
      eatenAt: new Date("2026-09-20T12:00:00.000Z"), tz: "UTC", slot: "snack" as const,
      items: [ITEM],
    };
    expect(buildCommitRequest(base)).not.toHaveProperty("title");
    const cleared = buildCommitRequest({ ...base, title: null });
    expect(cleared).toHaveProperty("title", null);
    expect(logCommitRequestSchema.parse(cleared)).toHaveProperty("title", null);
  });

  it("threads a title through the meal request builder too", () => {
    const request = buildMealCommitRequest({
      entryId: "11111111-1111-4111-8111-111111111111",
      eatenAt: new Date("2026-09-20T12:00:00.000Z"), tz: "UTC", slot: "meal-1",
      title: "Eggs on toast",
      items: [{ itemId: ITEM.id, foodRefId: ITEM.foodRefId,
        revision: { revision_id: 77 } as never, grams: 140, qty: 140, unit: "g",
        portionId: null }],
    });
    expect(request).toHaveProperty("title", "Eggs on toast");
  });

  it("rebuilds a retry card from the persisted title instead of an item-count fallback", () => {
    const request = buildCommitRequest({
      entryId: "11111111-1111-4111-8111-111111111111",
      eatenAt: new Date("2026-09-20T12:00:00.000Z"), tz: "UTC", slot: "snack",
      title: "Spaghetti bolognese", items: [ITEM],
    });
    expect(cardFromRequest(request)).toMatchObject({
      name: "Spaghetti bolognese", slot: "snack",
    });
  });

  it("reconciles a server row's title and slot onto the existing card", () => {
    const existing = cardFromRequest(buildCommitRequest({
      entryId: "11111111-1111-4111-8111-111111111111",
      eatenAt: new Date("2026-09-20T12:00:00.000Z"), tz: "UTC", slot: "snack",
      items: [ITEM],
    }));
    expect(entryPatchFromRow(existing, {
      title: "Spaghetti bolognese", slot: "snack", rev: 2, items: [],
    })).toMatchObject({ name: "Spaghetti bolognese", slot: "snack", rev: 2 });
  });

  it("derives the card title from its items when the server explicitly clears title", () => {
    const existing = {
      id: "11111111-1111-4111-8111-111111111111", foodId: "meal", name: "Old title",
      portionLabel: "2 items", qty: 1, grams: 240,
      macros: { kcal: 300, protein: 30, carbs: 25, fat: 8 }, at: "2026-09-20T12:00:00.000Z",
      items: [
        { id: "a", seq: 1, food_ref_id: "ref-a", grams: 140, qty: 140, unit: "g",
          snapshot: {}, foodId: "chicken", name: "chicken", portionLabel: "140 g",
          macros: { kcal: 200, protein: 30, carbs: 0, fat: 7 } },
        { id: "b", seq: 2, food_ref_id: "ref-b", grams: 100, qty: 100, unit: "g",
          snapshot: {}, foodId: "rice", name: "rice", portionLabel: "100 g",
          macros: { kcal: 100, protein: 0, carbs: 25, fat: 1 } },
      ],
    } satisfies LoggedFood;

    expect(entryPatchFromRow(existing, { title: null, rev: 2, items: [] }))
      .toMatchObject({ name: "Chicken & rice", rev: 2 });
  });

  it("prefers an existing card's dish name when a title-less request must be rebuilt", () => {
    const request = buildCommitRequest({
      entryId: "11111111-1111-4111-8111-111111111111",
      eatenAt: new Date("2026-09-20T12:00:00.000Z"), tz: "UTC", slot: "snack",
      items: [ITEM],
    });
    const prior = { name: "Chicken soup", items: [{ name: "Chicken" }],
      macros: { kcal: 220, protein: 28, carbs: 12, fat: 7 } } as LoggedFood;
    expect(cardFromRequest(request, prior)).toMatchObject({
      name: "Chicken soup", items: [{ name: "Chicken" }], macros: prior.macros,
    });
  });

  it("derives a retry title from the previous item names before the generic fallback", () => {
    const request = buildCommitRequest({
      entryId: "11111111-1111-4111-8111-111111111111",
      eatenAt: new Date("2026-09-20T12:00:00.000Z"), tz: "UTC", slot: "snack",
      items: [ITEM],
    });
    const previous = {
      name: "Logged meal",
      items: [{ name: "chicken" }, { name: "rice" }],
      macros: { kcal: 300, protein: 30, carbs: 25, fat: 8 },
    } as LoggedFood;

    expect(cardFromRequest(request, previous).name).toBe("Chicken & rice");
  });
});
