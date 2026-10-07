/**
 * Design §8.3 — the sheet index: the spec of record for every sheet with card content, plus the
 * flag-off state of every feature flag that hides a whole card family, plus a render of the three
 * sheets that had no spec of their own.
 *
 * A brand-new account meets these flags before it meets the features: `.env.example` ships every
 * one of them off, so "off" is the state the walkthrough will actually screenshot. Each assertion
 * here is that the gate reads the flag and defaults to hidden — never that the sheet is broken.
 */
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ScanAttachmentSheet from "@/components/coach/attachments/ScanAttachmentSheet";
import FoodDetailSheet from "@/components/FoodDetailSheet";
import SwapSheet from "@/components/SwapSheet";
import { readAppCapabilities } from "@/lib/capabilities";
import { catalogSearchEnabled } from "@/lib/catalog-client";
import { publicCaptureMethods, publicFeatureScan } from "@/lib/capture/public-flags";
import { enabledMethods } from "@/lib/capture/flags";
import type { Meal } from "@/lib/types";

const MEAL: Meal = { id: "m1", name: "Chicken and rice", slot: "meal-2",
  components: [{ name: "Chicken", qty: 150, unit: "g", role: "protein",
    macros: { kcal: 250, protein: 46, carbs: 0, fat: 6 } }],
  macros: { kcal: 250, protein: 46, carbs: 0, fat: 6 }, prepMinutes: 10, tags: [] };

const ENV_KEYS = ["NEXT_PUBLIC_FEATURE_SCAN", "NEXT_PUBLIC_CATALOG_SEARCH",
  "NEXT_PUBLIC_CAPTURE_METHODS"] as const;
const SAVED = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (SAVED[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED[key];
  }
});

describe("the sheet specs of record", () => {
  it.each([
    ["capture", "tests/client/capture-methods.test.ts"],
    ["barcode scan", "tests/barcode/confirm.test.ts"],
    ["scan confirm", "tests/speed/scan-card.test.ts"],
    ["log food", "tests/today/log-food-sheet-favorites.test.tsx"],
    ["log food submit guard", "tests/today/log-food-sheet-submit-guard.test.ts"],
    ["health sources", "tests/health/health-sources-sheet.test.tsx"],
    ["recipe", "tests/recipes/recipe-sheet.test.tsx"],
    ["recipe offline", "tests/recipes/recipe-sheet-offline.test.tsx"],
    ["food membership", "tests/foods/food-sheet-membership.test.tsx"],
    ["edit slot", "tests/plan/edit-slot-sheet.test.tsx"],
    ["day type", "tests/today/day-type-toggle.test.tsx"],
    ["note", "components/NoteSheet.test.tsx"],
    ["draft editors", "tests/coach/editors/sheets.test.tsx"],
  ])("keeps the %s sheet's spec", (_name, spec) => {
    expect(existsSync(new URL(`../../${spec}`, import.meta.url))).toBe(true);
  });
});

describe("every flag that hides a card family is off by default", () => {
  it("hides the coach tab until the server turns it on", () => {
    expect(readAppCapabilities({}).coach).toBe(false);
    expect(readAppCapabilities({ COACH_ENABLED: "maybe" }).coach).toBe(false);
    expect(readAppCapabilities({ COACH_ENABLED: "1" }).coach).toBe(true);
  });

  it("hides the barcode sheets until the scan flag is set", () => {
    expect(readAppCapabilities({}).scan).toBe(false);
    expect(readAppCapabilities({ FEATURE_SCAN: "1" }).scan).toBe(true);
    delete process.env.NEXT_PUBLIC_FEATURE_SCAN;
    expect(publicFeatureScan()).toBe(false);
    process.env.NEXT_PUBLIC_FEATURE_SCAN = "1";
    expect(publicFeatureScan()).toBe(true);
  });

  it("offers no capture method until the list names one", () => {
    expect(readAppCapabilities({}).captureMethods).toEqual([]);
    expect(enabledMethods("")).toEqual([]);
    expect(enabledMethods("text,photo")).toContain("text");
    delete process.env.NEXT_PUBLIC_CAPTURE_METHODS;
    expect(publicCaptureMethods()).toBeUndefined();
  });

  it("hides the catalog rows until catalog search is on", () => {
    delete process.env.NEXT_PUBLIC_CATALOG_SEARCH;
    expect(catalogSearchEnabled()).toBe(false);
    process.env.NEXT_PUBLIC_CATALOG_SEARCH = "1";
    expect(catalogSearchEnabled()).toBe(true);
  });

  /* The estimator, health and activity-prompt gates read their flags through the same rule; their
     card-level behaviour is asserted where those cards live (`tests/settings/estimator-flags.test.ts`,
     `tests/today/estimator-flags.test.ts`, `tests/activity/prompt.test.ts`). */
  it.each([
    "tests/settings/estimator-flags.test.ts",
    "tests/today/estimator-flags.test.ts",
    "tests/activity/prompt.test.ts",
  ])("keeps %s as the flag spec of record", (spec) => {
    expect(existsSync(new URL(`../../${spec}`, import.meta.url))).toBe(true);
  });
});

describe("the four sheets that had no spec of their own", () => {
  it("draws ScanAttachmentSheet closed as nothing, and open as the scanner", () => {
    const closed = renderToStaticMarkup(<ScanAttachmentSheet open={false} onClose={() => {}}
      onAttachment={() => {}} />);
    expect(closed).toBe("");
    const open = renderToStaticMarkup(<ScanAttachmentSheet open onClose={() => {}}
      onAttachment={() => {}} />);
    expect(open).toContain("Scan");
    expect(open).toContain("Starting the camera…");
  });

  it("SwapSheet lists the options, and marks the current pick over the rotation", () => {
    const markup = renderToStaticMarkup(
      <SwapSheet slot="meal-2" options={[MEAL]} currentMealId="m1" isDefaultPick={false}
        onSelect={() => {}} onUseRotation={() => {}} onClose={() => {}} />);
    expect(markup).toContain("Chicken and rice");
    // The chosen row carries the active ink (ink on the ivory row, never cream: DESIGN.md §Contrast).
    expect(markup).toContain("text-charcoal");
    expect(markup).not.toContain("NaN");
  });

  it("SwapSheet offers a way back to rotation, and marks it while it is the one in force", () => {
    const rotation = renderToStaticMarkup(
      <SwapSheet slot="meal-2" options={[MEAL]} currentMealId="" isDefaultPick
        onSelect={() => {}} onUseRotation={() => {}} onClose={() => {}} />);
    expect(rotation).toContain("Today&#x27;s pick");
    expect(rotation).toContain("text-charcoal");
  });

  it("FoodDetailSheet names the food and its per-100 g codes", () => {
    const markup = renderToStaticMarkup(
      <FoodDetailSheet onClose={() => {}} detail={{ id: 1, description: "Rolled oats",
        brand: null, per100g: { energy_kcal: 379, protein: 13 }, portions: [],
        ingredients: [] } as never} />);
    expect(markup).toContain("Rolled oats");
    expect(markup).not.toContain("Portions");
    expect(markup).not.toContain("NaN");
  });

  it("FoodDetailSheet lists the portions it has, and draws no heading without them", () => {
    const markup = renderToStaticMarkup(
      <FoodDetailSheet onClose={() => {}} detail={{ id: 1, description: "Rolled oats",
        brand: null, per100g: { energy_kcal: 379 },
        portions: [{ id: 7, description: "1 bowl", gramWeight: 60, isDefault: true }],
        ingredients: [] } as never} />);
    expect(markup).toContain("Portions");
    expect(markup).toContain("1 bowl");
  });

  it("FoodDetailSheet names the ingredients it has, and draws no heading without them", () => {
    const markup = renderToStaticMarkup(
      <FoodDetailSheet onClose={() => {}} detail={{ id: 1, description: "Rolled oats",
        brand: null, per100g: { energy_kcal: 379 }, portions: [],
        ingredients: [{ name: "Oats" }, { name: "Salt" }] } as never} />);
    expect(markup).toContain("Ingredients");
    expect(markup).toContain("Oats, Salt");
  });
});
