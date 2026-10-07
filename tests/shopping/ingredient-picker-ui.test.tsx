// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { bindAccount, markAccountReady, unbindAccount } from "@/lib/device/account";
import ShoppingIngredientPicker from "@/components/ShoppingIngredientPicker";

vi.mock("@/lib/favorites-client", () => ({ listFavorites: vi.fn().mockResolvedValue([]) }));

afterEach(() => { cleanup(); unbindAccount(); });

it("uses the shared selector and keeps the chosen purchase state in basket identity", () => {
  unbindAccount();
  const change = vi.fn();
  render(<ShoppingIngredientPicker lines={[]} pantry={[]} selected={[]} onChange={change} />);
  fireEvent.change(screen.getByLabelText("Search foods"), { target: { value: "Chicken breast, roasted" } });
  const select = screen.getByRole("combobox", { name: "Purchase state" });
  expect(select.textContent).toContain("Raw");
  fireEvent.click(select);
  fireEvent.click(screen.getByRole("option", { name: "Cooked" }));
  expect(select.textContent).toContain("Cooked");
  fireEvent.click(screen.getAllByRole("checkbox")[0]);
  expect(change).toHaveBeenCalledWith([expect.objectContaining({
    foodDbId: "chicken-breast-roasted", purchaseState: "cooked", variantKey: "cooked",
  })]);
});

it("clears purchase-state and search preferences when the account changes", () => {
  unbindAccount();
  markAccountReady(bindAccount("11111111-1111-4111-8111-111111111111"));
  render(<ShoppingIngredientPicker lines={[]} pantry={[]} selected={[]} onChange={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Search foods"), { target: { value: "chicken" } });
  fireEvent.click(screen.getByRole("combobox", { name: "Purchase state" }));
  fireEvent.click(screen.getByRole("option", { name: "Cooked" }));
  expect(screen.getByRole("combobox", { name: "Purchase state" }).textContent).toContain("Cooked");
  act(() => {
    unbindAccount();
    markAccountReady(bindAccount("22222222-2222-4222-8222-222222222222"));
  });
  expect((screen.getByLabelText("Search foods") as HTMLInputElement).value).toBe("");
  fireEvent.change(screen.getByLabelText("Search foods"), { target: { value: "chicken" } });
  expect(screen.getByRole("combobox", { name: "Purchase state" }).textContent).toContain("Raw");
});
