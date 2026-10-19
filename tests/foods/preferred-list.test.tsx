// @vitest-environment jsdom
/**
 * The Foods first tab's Preferred shopping list (components/foods/PreferredList.tsx, UI makeover §6):
 * Favored foods by aisle, starred first, the pilot title switch, and no "Your usual foods".
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import PreferredList, { FAVORITES_TITLE, PREFERRED_TITLE, sortStarredFirst } from "@/components/foods/PreferredList";
import type { Food } from "@/lib/foods";

afterEach(cleanup);

function food(name: string, role: Food["role"] = "protein"): Food {
  return { id: name.toLowerCase(), name, role, unit: "g", perUnit: { protein: 0.2, carbs: 0, fat: 0.1 },
    status: "eats", updatedAt: "2026-09-20T00:00:00.000Z" } as Food;
}

const row = (f: Food) => <div data-testid="row">{f.name}</div>;

function draw(foods: Food[], over: Partial<Parameters<typeof PreferredList>[0]> = {}) {
  return render(<PreferredList foods={foods} pilot isStarred={() => false} renderRow={row}
    onAdd={() => undefined} {...over} />);
}

describe("PreferredList", () => {
  it("renders grouped by aisle in the fixed aisle order", () => {
    const { container } = draw([food("White rice, cooked", "carb"), food("Chicken breast"), food("Acorn squash, baked")]);
    const groups = [...container.querySelectorAll("[data-aisle]")].map((node) => node.getAttribute("data-aisle"));
    expect(groups).toEqual(["produce", "protein", "grains"]);
    expect(screen.getByRole("heading", { name: "Produce" })).toBeTruthy();
  });

  it("puts starred first inside an aisle", () => {
    const foods = [food("Chicken breast"), food("Beef"), food("Salmon")];
    expect(sortStarredFirst(foods, (f) => f.name === "Salmon").map((f) => f.name))
      .toEqual(["Salmon", "Beef", "Chicken breast"]);
    const { container } = draw(foods, { isStarred: (f) => f.name === "Salmon" });
    const names = within(container.querySelector("[data-aisle='protein']") as HTMLElement)
      .getAllByTestId("row").map((node) => node.textContent);
    expect(names[0]).toBe("Salmon");
  });

  it("uses the pilot title: the Preferred shopping list with the pilot on and Your favorites without it", () => {
    draw([food("Beef")]);
    expect(screen.getByRole("heading", { name: PREFERRED_TITLE })).toBeTruthy();
    cleanup();
    draw([food("Beef")], { pilot: false });
    expect(screen.getByRole("heading", { name: FAVORITES_TITLE })).toBeTruthy();
    expect(screen.queryByText(/Your usual foods/)).toBeNull();
  });

  it("says it is empty and still offers one Add", () => {
    const onAdd = vi.fn();
    draw([], { onAdd });
    expect(screen.getByText("Nothing here yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add a favorite food" }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });
});
