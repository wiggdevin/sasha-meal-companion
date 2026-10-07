// @vitest-environment jsdom
/**
 * #20 / #383 in the slot editor: a catalog row that cannot state all four card numbers is refused,
 * never placed on the slot as a measured zero. A complete row places as before.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { FoodComponent } from "@/lib/types";

const detail = vi.hoisted(() => ({ per100g: {} as Record<string, number | null> }));

vi.mock("@/components/Sheet", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/CatalogSearch", () => ({
  default: ({ onPick }: { onPick: (row: unknown) => void }) => (
    <button type="button" onClick={() => onPick({ catalogFoodId: 5, revisionId: 50 })}>Catalog milk</button>
  ),
}));
vi.mock("@/lib/catalog-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/catalog-client")>();
  return {
    ...actual,
    catalogSearchEnabled: () => true,
    getFoodDetail: vi.fn(async () => ({ kind: "cached", revision: {
      description: "Milk", per_100g: detail.per100g, portions: [{ gramWeight: 244, isDefault: true }],
    } })),
  };
});

import EditSlotSheet from "@/components/EditSlotSheet";

const ESPRESSO: FoodComponent = {
  name: "Espresso", qty: 1, unit: "oz", role: "free", macros: { kcal: 3, protein: 0, carbs: 1, fat: 0 },
};

beforeEach(() => { detail.per100g = {}; });
afterEach(() => cleanup());

async function chooseMilk(per100g: Record<string, number | null>) {
  detail.per100g = per100g;
  const onSave = vi.fn();
  render(<EditSlotSheet open label="Coffee" planned={[ESPRESSO]} override={undefined}
    target={undefined} foods={{}} onSave={onSave} onClose={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: /Add something/i }));
  fireEvent.click(screen.getByRole("button", { name: "Catalog milk" }));
  await screen.findByText("How much milk did you have?");
}

it("refuses a row with an unknown macro instead of placing a zero", async () => {
  await chooseMilk({ energy_kcal: 61, protein: 3.2, carbohydrate: null, fat_total: 3.3 });
  expect(screen.queryByRole("button", { name: "That is what I had" })).toBeNull();
  expect(screen.getByText("This food is missing some nutrition numbers. Pick another.")).toBeTruthy();
});

it("places a complete row", async () => {
  await chooseMilk({ energy_kcal: 61, protein: 3.2, carbohydrate: 4.8, fat_total: 3.3 });
  expect(screen.getByText("· 149 kcal")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "That is what I had" }));
  expect(screen.getByRole("button", { name: /Change Milk/ })).toBeTruthy();
});
