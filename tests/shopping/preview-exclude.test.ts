// @vitest-environment jsdom
/**
 * UI makeover W7: recipes the "Have AI build my list" meal walk said No to.
 *
 * - The preview contract takes at most 50 recipe uuids in `excludeRecipeIds`.
 * - The planner drops those recipes before any score: an excluded recipe is never chosen, and a
 *   run without the field (or with an empty list) equals the plain run.
 * - The phone's `previewShopping` sends `excludeRecipeIds` only when non-empty and never sends the
 *   list's `title` (the preview draft is strict; a name is saved on the period).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { TEST_USER } from "@/tests/helpers/account";
import { shoppingPreviewBody } from "@/lib/shopping/preview-contract";
import { planShoppingPeriod, type PlannerInput } from "@/lib/shopping/planner";
import { previewShopping } from "@/lib/shopping-client";
import { defaultShoppingDraft } from "@/components/ShoppingControls";
import { ingredient, recipe } from "../recipes/fixture";
import { identityFor, period } from "./fixture";

const draft = { startDate: "2026-10-01", endDate: "2026-10-07", timezone: "America/Denver",
  people: 1, mealCoverage: ["dinner"], mode: "balanced", effort: "standard",
  maxActiveMinutes: null, variety: "balanced", budgetAmount: null, currency: null,
  locale: null, lockMode: "none" };
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

describe("shoppingPreviewBody excludeRecipeIds", () => {
  it("accepts none, an empty list and up to 50 recipe uuids", () => {
    expect(shoppingPreviewBody.safeParse({ draft, basket: [] }).success).toBe(true);
    expect(shoppingPreviewBody.safeParse({ draft, basket: [], excludeRecipeIds: [] }).success).toBe(true);
    const fifty = Array.from({ length: 50 }, (_, i) => uuid(i + 1));
    const parsed = shoppingPreviewBody.safeParse({ draft, basket: [], excludeRecipeIds: fifty });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.excludeRecipeIds).toEqual(fifty);
  });

  it("refuses 51 ids and anything that is not a uuid", () => {
    const fiftyOne = Array.from({ length: 51 }, (_, i) => uuid(i + 1));
    expect(shoppingPreviewBody.safeParse({ draft, basket: [], excludeRecipeIds: fiftyOne }).success)
      .toBe(false);
    for (const bad of [["stew"], [""], [42], "00000000-0000-4000-8000-000000000001", null]) {
      expect(shoppingPreviewBody.safeParse({ draft, basket: [], excludeRecipeIds: bad }).success)
        .toBe(false);
    }
  });

  it("keeps the preview draft strict: a title is refused", () => {
    expect(shoppingPreviewBody.safeParse({ draft: { ...draft, title: "Weekly" }, basket: [] }).success)
      .toBe(false);
  });
});

const candidate = (partial: Parameters<typeof recipe>[0] = {}) => ({
  ...recipe(partial), eligibility: { status: "eligible" as const, reasons: [] },
});
const known = (value: number) => ({ value, status: "estimated" as const, sourceRevisionId: null });
const stew = candidate({ recipeId: "stew", revisionId: "stew-v1", name: "Bean stew",
  nutritionPerServing: { kcal: known(500), protein: known(39) } });
const chili = candidate({ recipeId: "chili", revisionId: "chili-v1", name: "Lentil chili",
  ingredients: [ingredient({ seq: 1, name: "lentils" }), ingredient({ seq: 2, name: "salt" })],
  nutritionPerServing: { kcal: known(500), protein: known(20) } });
const slots = ["2026-10-01", "2026-10-02", "2026-10-03"].map((localDate) =>
  ({ localDate, slotId: "meal-3", targetKcal: 500, targetProtein: 40 }));
const input = (over: Partial<PlannerInput> = {}): PlannerInput => ({ period: period(), slots,
  candidates: [stew, chili], basket: [], pins: [], aggregate: { identityFor }, ...over });
const chosen = (result: ReturnType<typeof planShoppingPeriod>) =>
  result.choices.map((choice) => choice.recipe.recipeId);

describe("planShoppingPeriod excludeRecipeIds", () => {
  it("never chooses an excluded recipe", () => {
    const plain = planShoppingPeriod(input());
    // The protein-rich stew wins on its own.
    expect(chosen(plain)).toContain("stew");
    const without = planShoppingPeriod(input({ excludeRecipeIds: ["stew"] }));
    expect(chosen(without)).not.toContain("stew");
    expect(chosen(without).length).toBeGreaterThan(0);
    expect(chosen(without).every((id) => id === "chili")).toBe(true);
    expect(without.shopping.lines.some((line) => line.name === "beans")).toBe(false);
  });

  it("leaves a slot unfilled rather than use a recipe that was said No to", () => {
    const none = planShoppingPeriod(input({ excludeRecipeIds: ["stew", "chili"] }));
    expect(none.choices).toHaveLength(0);
    expect(none.unfilledSlots).toHaveLength(slots.length);
  });

  it("is the plain run when the list is absent, empty or names no candidate", () => {
    const plain = planShoppingPeriod(input());
    expect(planShoppingPeriod(input({ excludeRecipeIds: undefined }))).toEqual(plain);
    expect(planShoppingPeriod(input({ excludeRecipeIds: [] }))).toEqual(plain);
    expect(planShoppingPeriod(input({ excludeRecipeIds: ["not-a-candidate"] }))).toEqual(plain);
  });

  it("never admits: an excluded id that is not a candidate adds nothing", () => {
    const only = planShoppingPeriod(input({ candidates: [chili], excludeRecipeIds: ["stew"] }));
    expect(chosen(only).every((id) => id === "chili")).toBe(true);
  });
});

describe("previewShopping (phone)", () => {
  beforeEach(() => { unbindAccount(); bindAccount(TEST_USER); });
  afterEach(() => { vi.unstubAllGlobals(); unbindAccount(); });

  function stubPreview() {
    const send = vi.fn().mockResolvedValue(new Response(JSON.stringify({ previewId: "p", lines: [] }),
      { status: 200 }));
    vi.stubGlobal("fetch", send);
    return () => JSON.parse(String((send.mock.calls[0][1] as RequestInit).body)) as Record<string, unknown>;
  }

  it("sends excludeRecipeIds when the list is non-empty", async () => {
    const payload = stubPreview();
    const ids = [uuid(1), uuid(2)];
    await previewShopping({ draft: defaultShoppingDraft("2026-10-01", "UTC"), basket: [],
      excludeRecipeIds: ids }, null);
    expect(payload().excludeRecipeIds).toEqual(ids);
  });

  it("leaves excludeRecipeIds out when it is empty or absent", async () => {
    let payload = stubPreview();
    await previewShopping({ draft: defaultShoppingDraft("2026-10-01", "UTC"), basket: [],
      excludeRecipeIds: [] }, null);
    expect(payload()).not.toHaveProperty("excludeRecipeIds");
    vi.unstubAllGlobals();
    payload = stubPreview();
    await previewShopping({ draft: defaultShoppingDraft("2026-10-01", "UTC"), basket: [] }, null);
    expect(payload()).not.toHaveProperty("excludeRecipeIds");
  });

  it("never sends the list's title in the preview draft, and the sent body passes the contract", async () => {
    const payload = stubPreview();
    const base = defaultShoppingDraft("2026-10-01", "UTC");
    await previewShopping({ draft: { ...base, title: "Weekly shop" }, basket: [],
      excludeRecipeIds: [uuid(3)] }, null);
    const sent = payload();
    expect(sent.draft).not.toHaveProperty("title");
    expect(sent.draft).toEqual(base);
    expect(shoppingPreviewBody.safeParse(sent).success).toBe(true);
  });
});
