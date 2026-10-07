/**
 * Audit finding: double-submit / duplicate-entry risk. Neither confirmCatalogPortion() nor
 * saveMeal() in components/LogFoodSheet.tsx disabled its confirm button while the commit
 * request was in flight, so a second tap during a slow request minted a second entry_id and
 * committed the same food or meal twice. `@testing-library/react` is not installed and no
 * dependency may be added, so — same as tests/barcode/confirm.test.ts — the decision is the
 * pure `canConfirmPortion`/`canSaveMeal` pair the two buttons' `disabled` props read from; the
 * tap itself is a manual phone gate.
 */
import { describe, expect, it } from "vitest";
import { canConfirmPortion, canSaveMeal } from "@/components/LogFoodSheet";

describe("canConfirmPortion", () => {
  it("allows the commit once grams and the food_ref are both ready", () => {
    expect(canConfirmPortion(140, "f1", false)).toBe(true);
  });

  it("blocks a second tap while the first commit is still in flight", () => {
    expect(canConfirmPortion(140, "f1", true)).toBe(false);
  });

  it("still blocks when grams or the food_ref are not ready, in-flight or not", () => {
    expect(canConfirmPortion(0, "f1", false)).toBe(false);
    expect(canConfirmPortion(140, null, false)).toBe(false);
  });
});

describe("canSaveMeal", () => {
  it("allows saving once at least one item is in the meal", () => {
    expect(canSaveMeal(2, false)).toBe(true);
  });

  it("blocks a second tap of \"Log this meal\" while the first commit is still in flight", () => {
    expect(canSaveMeal(2, true)).toBe(false);
  });

  it("still blocks an empty meal, in-flight or not", () => {
    expect(canSaveMeal(0, false)).toBe(false);
  });
});
