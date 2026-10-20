// @vitest-environment jsdom
/**
 * Shopping's "Pick from your foods" (UI makeover W7 §7.1 item 4): Favorites and Often eaten in the
 * Favorites row layout, grouped by aisle, each row with its rule mark and a 44 px toggle.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import PickRow from "@/components/shopping/PickRow";
import { byAisle, pickSources, type PickItem } from "@/lib/shopping/pick-sources";
import type { Food } from "@/lib/foods";
import type { ShoppingLine } from "@/lib/shopping/types";

afterEach(cleanup);

function food(id: string, name: string, over: Partial<Food> = {}): Food {
  return { id, name, role: "protein", unit: "g", perUnit: { protein: 0.2, carbs: 0, fat: 0.05 },
    status: "eats", updatedAt: "2026-10-01T00:00:00Z", ...over } as Food;
}
function line(name: string, over: Partial<ShoppingLine> = {}): ShoppingLine {
  return { id: `l-${name}`, periodId: "p1", origin: "manual", name, identity: null, category: "manual",
    needGrams: null, confirmedStockGrams: null, buyGrams: null, packageGrams: null,
    purchaseConversionStatus: "unknown", sources: [], pinned: false, checked: false, note: null,
    revision: 1, ...over };
}
const view = (ids: string[]) => ({ ids: new Set(ids), marks: new Map() });

describe("pick sources", () => {
  const foods = {
    eggs: food("eggs", "Eggs"),
    rice: food("rice", "Rice, cooked", { role: "carb", updatedAt: "2026-10-05T00:00:00Z" }),
    peanut: food("peanut", "Peanut butter", { status: "avoid", role: "fat" }),
  };

  it("never offers an Avoid food, from Favorites or Often eaten", () => {
    const { favorites, often } = pickSources({ foods, starred: () => false, view: view(["eggs", "rice"]),
      taste: [{ key: "t1", name: "Peanut butter", days180: 9 }, { key: "t2", name: "Spinach", days180: 4 }],
      lines: [] });
    expect([...favorites, ...often].map((row) => row.name)).not.toContain("Peanut butter");
    expect(often.map((row) => row.name)).toEqual(["Spinach"]);
  });

  it("puts starred foods first and names what you buy", () => {
    const { favorites } = pickSources({ foods, starred: (item) => item.id === "eggs", view: view(["eggs", "rice"]),
      taste: [], lines: [] });
    expect(favorites.map((row) => [row.name, row.source])).toEqual([["Eggs", "starred"], ["Rice", "favorite"]]);
  });

  it("shows a food not yet checked against the rules as unknown, and a verified one clear", () => {
    const { favorites } = pickSources({ foods, starred: () => false, view: view(["eggs"]), taste: [], lines: [] });
    expect(favorites.find((row) => row.name === "Eggs")?.ruleMark).toBeNull();
    expect(favorites.find((row) => row.name === "Rice")?.ruleMark?.verdict).toBe("unknown");
  });

  it("marks a listed food On list, and only a manual unchecked line can be taken off", () => {
    const manual = pickSources({ foods, starred: () => false, view: view(["eggs", "rice"]), taste: [],
      lines: [line("Egg")] }).favorites.find((row) => row.name === "Eggs")!;
    expect(manual.onList).toBe(true);
    expect(manual.removable?.id).toBe("l-Egg");
    const plan = pickSources({ foods, starred: () => false, view: view(["eggs", "rice"]), taste: [],
      lines: [line("Eggs", { origin: "plan", category: "core" }), line("Rice", { checked: true })] }).favorites;
    expect(plan.every((row) => row.onList && row.removable === null)).toBe(true);
  });

  it("offers a starred food that is not Favored, after starred Favorites, and never an Avoid one", () => {
    const { favorites } = pickSources({ foods, starred: (item) => item.id === "eggs", view: view(["eggs", "rice"]),
      taste: [], lines: [], starredRows: [{ name: "Oat milk, unsweetened" }, { name: "Peanut butter" }, { name: "Eggs" }, { name: " " }] });
    expect(favorites.map((row) => [row.name, row.source])).toEqual([
      ["Eggs", "starred"], ["Oat milk, unsweetened", "starred"], ["Rice", "favorite"]]);
  });

  it("groups by aisle in the store's order", () => {
    const { favorites } = pickSources({ foods, starred: () => false, view: view(["eggs", "rice"]), taste: [], lines: [] });
    // Rice was updated last, so it leads Favorites; by aisle, protein comes before grains.
    expect(favorites.map((row) => row.name)).toEqual(["Rice", "Eggs"]);
    expect(byAisle(favorites).map((row) => [row.name, row.aisle])).toEqual([["Eggs", "protein"], ["Rice", "grains"]]);
  });
});

describe("PickRow", () => {
  const item = (over: Partial<PickItem> = {}): PickItem => ({ key: "eggs", name: "Eggs", source: "favorite",
    role: "protein", aisle: "dairy_eggs", ruleMark: null, onList: false, removable: null, ...over });

  it("adds with a 44 px + that becomes On list", () => {
    const onToggle = vi.fn();
    const { rerender } = render(<PickRow item={item()} last busy={false} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole("button", { name: "Add Eggs to list" }));
    expect(onToggle).toHaveBeenCalledOnce();
    rerender(<PickRow item={item({ onList: true, removable: { id: "l1" } as ShoppingLine })} last busy={false}
      onToggle={onToggle} />);
    const off = screen.getByRole("button", { name: "Take Eggs off the list" });
    expect(off.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/On list/)).toBeTruthy();
  });

  it("shows a blocked food's mark and offers no add", () => {
    render(<PickRow item={item({ ruleMark: { verdict: "blocked", reason: "Eggs are an allergen for you." } })}
      last busy={false} onToggle={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Add Eggs to list" })).toBeNull();
    expect(screen.getByText(/allergen/)).toBeTruthy();
  });

  it("shows an unknown mark and still offers the add", () => {
    render(<PickRow item={item({ ruleMark: { verdict: "unknown", reason: "Eggs have not been checked." } })}
      last busy={false} onToggle={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Add Eggs to list" })).toBeTruthy();
    expect(screen.getByText(/not been checked/)).toBeTruthy();
  });
});
