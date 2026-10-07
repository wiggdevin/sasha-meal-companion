/**
 * Phase A's sheet. @testing-library/react is not installed and no dependency may be added
 * (Sol audit, 2026-09-12), so the decisions live in lib/plan/slot-override.ts where they are
 * tested directly, and this spec asserts what the markup offers.
 *
 * The three things that must be true: every line in the slot is its own control (the whole point
 * — today the card renders them as one joined sentence with nothing to tap), the sheet says how
 * the slot now compares to its target, and there is always a way back to the plan.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import EditSlotSheet from "@/components/EditSlotSheet";
import type { Food } from "@/lib/foods";
import type { FoodComponent } from "@/lib/types";

const espresso: FoodComponent = {
  name: "Espresso", qty: 1, unit: "oz", role: "free",
  macros: { kcal: 3, protein: 0, carbs: 1, fat: 0 },
};
const oatMilk: FoodComponent = {
  name: "Oat milk", qty: 1, unit: "cup", role: "free",
  macros: { kcal: 125, protein: 3, carbs: 17, fat: 5 },
};
const foods: Record<string, Food> = { oat: { id: "oat", name: "Oat milk", role: "carb",
  unit: "cup", perUnit: { protein: 3, carbs: 17, fat: 5 }, status: "eats",
  updatedAt: "2026-09-20T00:00:00.000Z" } };

const render = (over: Partial<Parameters<typeof EditSlotSheet>[0]> = {}) =>
  renderToStaticMarkup(
    <EditSlotSheet
      open
      label="Coffee"
      planned={[espresso, oatMilk]}
      override={undefined}
      target={{ kcal: 128, protein: 3, carbs: 18, fat: 5 }}
      foods={foods}
      onSave={() => {}}
      onClose={() => {}}
      {...over}
    />
  );

describe("EditSlotSheet", () => {
  it("gives every line in the slot its own control", () => {
    const html = render();
    expect(html).toContain("Espresso");
    expect(html).toContain("Oat milk");
    // Each line is a button, not part of one joined sentence.
    expect(html).toMatch(/aria-label="Change Espresso"/);
    expect(html).toMatch(/aria-label="Change Oat milk"/);
  });

  it("shows what the slot now comes to", () => {
    expect(render()).toContain("128 calories");
  });

  it("shows what was actually eaten once the slot has been edited", () => {
    const html = render({
      override: { baseMealId: "coffee-latte", components: [espresso] },
    });
    expect(html).toContain("Espresso");
    expect(html).not.toMatch(/aria-label="Change Oat milk"/);
  });

  it("says how far the edited slot sits from its target", () => {
    const html = render({
      override: {
        baseMealId: "coffee-latte",
        components: [espresso, { ...oatMilk, name: "Whole milk", macros: { kcal: 168, protein: 8, carbs: 12, fat: 9 } }],
      },
    });
    expect(html).toMatch(/\+43/);
  });

  it("always offers the way back to the plan that gets the edit cleared", () => {
    expect(render()).toMatch(/Back to the plan/i);
  });

  it("offers a way to add a line that was eaten but not planned", () => {
    expect(render()).toMatch(/Add something/i);
  });

  it("previews the account day total before saving this meal", () => {
    const projection = { consumed: { kcal: 1500, protein: 90, carbs: 140, fat: 60 },
      targets: { kcal: 1800, protein: 120, carbs: 190, fat: 60 } };
    expect(render({ projection })).toContain("Fat 60 → 65 / 60 g");
    expect(render({ projection, replaced: {
      kcal: 128, protein: 3, carbs: 18, fat: 5,
    } })).toContain("Fat 60 → 60 / 60 g");
  });
});


describe("combined meal editor", () => {
  it("includes the current note and keyboard-accessible time input", () => {
    const html = render({ note: "Felt good", time: "12:30" });
    expect(html).toContain("Felt good</textarea>");
    // FluidVoice U05: typed entry, 15-minute steps and the quarter-hour wheel replace the native picker.
    expect(html).not.toContain('type="time"');
    expect(html).toContain('value="12:30"');
    expect(html).toContain('aria-label="Choose meal time"');
    expect(html).toContain("Save changes");
  });
});
