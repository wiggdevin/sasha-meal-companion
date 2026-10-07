// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Food } from "@/lib/foods";

vi.mock("@/components/Sheet", () => ({
  default: ({ children, footer }: { children: React.ReactNode; footer: React.ReactNode }) =>
    <div>{children}{footer}</div>,
}));
vi.mock("@/components/ui/GlassSelect", () => ({
  default: ({ value, onChange }: { value: string; onChange: (value: string) => void }) =>
    <select aria-label="Food group" value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="protein">Protein</option><option value="carb">Carbs</option><option value="fat">Fats</option>
    </select>,
}));
vi.mock("@/lib/constraints-client", () => ({ loadConstraints: async () => null }));
vi.mock("@/lib/device/account", () => ({ currentAccountOrNull: () => null }));
vi.mock("@/lib/foods/prefs-client", () => ({
  canEditFoodNutrients: () => true,
  verifyFoodNutrientsEditable: async () => true,
  readPrefRefCache: () => ({}),
}));

import FoodSheet from "@/components/FoodSheet";

const food: Food = {
  id: "rice", name: "Rice", role: "carb", unit: "g",
  perUnit: { protein: 0.03, carbs: 0.28, fat: 0.01 },
  status: "eats", note: "Old note", updatedAt: "2026-01-01T00:00:00.000Z",
};

afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("persists edited note, group, and nutrition only when Save changes succeeds", async () => {
  const onSave = vi.fn().mockResolvedValue({
    saved: { note: true, role: true, nutrition: true }, syncing: false, membership: null,
  });
  render(<FoodSheet food={food} onSave={onSave} onSetNote={() => undefined}
    onSetStatus={() => undefined} onClose={() => undefined} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Note to self" }),
    { target: { value: "Good with beans" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Food group" }),
    { target: { value: "protein" } });
  // A food stored per gram is edited per 100 g, the label's own basis: 28 → 40 g of carbs.
  expect(await screen.findByText("Nutrition per 100 g")).toBeTruthy();
  expect(screen.getByRole("spinbutton", { name: "Carbs g" })).toHaveProperty("value", "28");
  fireEvent.change(screen.getByRole("spinbutton", { name: "Carbs g" }),
    { target: { value: "40" } });
  expect(onSave).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(onSave).toHaveBeenCalledWith({
    note: "Good with beans", role: "protein",
    perUnit: { protein: 0.03, carbs: 0.4, fat: 0.01 },
  }));
  expect(await screen.findByRole("status")).toHaveProperty("textContent", "Changes saved.");
});

it("keeps edits visible and offers retry when persistence fails", async () => {
  const onSave = vi.fn().mockRejectedValue(new Error("offline"));
  render(<FoodSheet food={food} onSave={onSave} onSetNote={() => undefined}
    onSetStatus={() => undefined} onClose={() => undefined} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Note to self" }),
    { target: { value: "Try again later" } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "offline");
  expect(screen.getByRole("textbox", { name: "Note to self" })).toHaveProperty("value", "Try again later");
  expect(screen.getByRole("button", { name: "Save changes" })).toHaveProperty("disabled", false);
});

it("confirms a food edit through the shared feedback: haptic on success, shared alert on failure", async () => {
  const vibrate = vi.fn(() => true);
  Object.defineProperty(window.navigator, "vibrate", { configurable: true, value: vibrate });
  const onSave = vi.fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({ saved: { note: true, role: true, nutrition: true }, syncing: true, membership: null });
  render(<FoodSheet food={food} onSave={onSave} onSetNote={() => undefined}
    onSetStatus={() => undefined} onClose={() => undefined} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Note to self" }), { target: { value: "Fine" } });
  const save = screen.getByRole("button", { name: "Save changes" });
  expect(save.className).toContain("btn");
  fireEvent.click(save);
  const alert = await screen.findByRole("alert");
  expect(alert.querySelector('button[aria-label="Dismiss notification"]')).toBeTruthy();
  expect(vibrate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByRole("status")).toHaveProperty("textContent", "Saved — syncing.");
  expect(vibrate).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("status").querySelector('button[aria-label="Dismiss notification"]')).toBeTruthy();
});
