// @vitest-environment jsdom
/**
 * U7: the one suggestion card shared by the Foods recipe hub and the meal card's Swap carousel. A card
 * without a photo keeps its geometry with the app's own olive art; its description says something its
 * name does not.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SuggestionCard, { ingredientLine, portionLine } from "@/components/recipes-hub/SuggestionCard";
import SuggestionCarousel from "@/components/recipes-hub/SuggestionCarousel";

afterEach(cleanup);

const values = { kcal: 522, protein: 56, carbs: 34, fat: 18 };

describe("SuggestionCard", () => {
  it("shows the olive art in the photo's place when there is no photo, in the same geometry", () => {
    render(<SuggestionCard name="Mystery bowl" image={null} values={values} onOpen={() => {}} />);
    const card = screen.getByRole("button", { name: /Mystery bowl/ }).closest("[data-recipe-card]")!;
    expect(card.querySelector("img")).toBeNull();
    expect(card.querySelector('[data-suggestion-photo="art"]')?.className).toMatch(/\bh-28\b/);
  });

  it("puts calories over the three macros when it shows all four, and drops its shadow inside a card", () => {
    render(<SuggestionCard name="Albacore bowl" image="/meal-art/chicken.webp" values={values} nested onOpen={() => {}} />);
    const button = screen.getByRole("button", { name: /Albacore bowl/ });
    // The closed card is one button, named by its name, line and figures.
    expect(button.getAttribute("aria-expanded")).toBe("false");
    const card = button.closest("[data-recipe-card]")!;
    expect(card.textContent).toContain("522");
    expect(card.textContent).toMatch(/56g\s*P/);
    expect(card.className).not.toMatch(/\bshell\b/);
  });

  it("describes a meal by its portions and a recipe by its foods", () => {
    expect(portionLine([{ name: "Canned albacore, drained", qty: 120, unit: "g" },
      { name: "Banana, medium", qty: 1, unit: "whole" }, { name: "Olive oil", qty: 0.5, unit: "tbsp" }]))
      .toBe("120 g Canned albacore · 1 Banana · 0.5 tbsp Olive oil");
    expect(ingredientLine([{ name: "Carrots" }, { name: "Olive oil" }, { name: "Chicken" }, { name: "Quinoa" }]))
      .toBe("Carrots, Olive oil, Chicken and 1 more");
    expect(ingredientLine([{ name: "Beef" }, { name: "Basil" }])).toBe("Beef and Basil");
  });
});

describe("SuggestionCarousel (U26: a card grows in place and shrinks back)", () => {
  const items = ["Bowl one", "Bowl two", "Bowl three"].map((name, index) => ({ id: `i${index}`, name,
    image: null, values, description: `${name} line`, detail: <button type="button">Use {name}</button> }));

  it("grows the tapped card into the row's width with its detail and a close, pushing the others aside", async () => {
    render(<SuggestionCarousel label="Ideas" items={items} />);
    const list = screen.getByRole("list", { name: "Ideas" });
    expect(list.className).toMatch(/\boverflow-x-auto\b/);
    fireEvent.click(within(list).getAllByRole("button", { expanded: false })[1]);
    const open = within(list).getByRole("group", { name: "Bowl two" });
    expect(open.closest("li")?.className).toMatch(/\bw-full\b/);
    expect(document.activeElement).toBe(open);
    expect(await within(open).findByRole("button", { name: "Use Bowl two" })).toBeTruthy();
    // The others are pushed aside: out of reach, and the row stops scrolling while one is open.
    const others = Array.from(list.children).filter((li) => li !== open.closest("li"));
    for (const li of others) expect(li.getAttribute("aria-hidden")).toBe("true");
    expect(list.className).toMatch(/\boverflow-x-hidden\b/);
    expect(within(open).getByRole("button", { name: "Close Bowl two" })).toBeTruthy();
  });

  it("restores the row when the open card's option leaves the list", async () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(<SuggestionCarousel label="Ideas" items={items} onOpenChange={onOpenChange} />);
    const list = screen.getByRole("list", { name: "Ideas" });
    fireEvent.click(within(list).getAllByRole("button", { expanded: false })[1]);
    await waitFor(() => expect(onOpenChange).toHaveBeenLastCalledWith("i1"));
    // Swap's list is rebuilt once saved meals load, and the open option is no longer in it.
    const rebuilt = [items[0], items[2], { ...items[0], id: "i9", name: "Saved bowl" }];
    rerender(<SuggestionCarousel label="Ideas" items={rebuilt} onOpenChange={onOpenChange} />);
    expect(within(list).queryByRole("group")).toBeNull();
    for (const li of Array.from(list.children)) {
      expect(li.getAttribute("aria-hidden")).toBeNull();
      expect(li.hasAttribute("inert")).toBe(false);
    }
    expect(list.className).toMatch(/\boverflow-x-auto\b/);
    expect(within(list).getAllByRole("button", { expanded: false })).toHaveLength(3);
    await waitFor(() => expect(onOpenChange).toHaveBeenLastCalledWith(null));
  });

  it("closes on × or Escape, content first, and hands focus back to the card", async () => {
    render(<SuggestionCarousel label="Ideas" items={items} />);
    const list = screen.getByRole("list", { name: "Ideas" });
    fireEvent.click(within(list).getAllByRole("button", { expanded: false })[0]);
    fireEvent.click(within(list).getByRole("button", { name: "Close Bowl one" }));
    await waitFor(() => expect(within(list).queryByRole("group", { name: "Bowl one" })).toBeNull());
    const back = within(list).getAllByRole("button", { expanded: false })[0];
    expect(document.activeElement).toBe(back);
    fireEvent.click(back);
    fireEvent.keyDown(within(list).getByRole("group", { name: "Bowl one" }), { key: "Escape" });
    await waitFor(() => expect(within(list).queryByRole("group", { name: "Bowl one" })).toBeNull());
  });
});
