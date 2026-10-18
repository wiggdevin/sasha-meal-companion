// @vitest-environment jsdom
/**
 * Owner asks, 2026-10-04, on the Foods lists:
 *  - calories per 100 g ("165 kcal / 100 g", the figure in `.kcal`), never "0 kcal / 1 g";
 *  - a star on each Eats and Other row that favourites the food through the existing
 *    favorites_foods mechanism (an idempotent set), optimistic with a rollback on failure;
 *  - at most six rows, then "Show all N" opening the rest in place and "Show fewer" folding them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Food } from "@/lib/foods";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { TEST_USER } from "@/tests/helpers/account";

const favorites = vi.hoisted(() => ({
  list: vi.fn(async () => [] as { kind: string; id: string; name: string; sort: number }[]),
  set: vi.fn(async (..._args: unknown[]) => true as boolean),
}));
vi.mock("@/lib/favorites-client", () => ({
  listFavorites: () => favorites.list(),
  setFavorite: (...args: unknown[]) => favorites.set(...args),
}));

const refs = vi.hoisted(() => ({ forFood: vi.fn(async (food: { id: string }) => ({ userRefId: `ref-${food.id}` })) }));
vi.mock("@/lib/foods/prefs-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/foods/prefs-client")>();
  return { ...actual, setFoodMembership: vi.fn(async () => ({ truncated: false })), saveFoodEdits: vi.fn(),
    foodRefsFor: (food: { id: string }) => refs.forFood(food) };
});

const seeded = vi.hoisted(() => ({ foods: {} as Record<string, Food> }));
vi.mock("@/lib/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store")>();
  return { ...actual, loadStore: () => ({ ...actual.defaultStore(), foods: seeded.foods }) };
});

const { default: EatsFoods, AvoidFoods } = await import("@/components/MyFoods");

function food(over: Partial<Food>): Food {
  return { id: "chicken", name: "Chicken breast, cooked", role: "protein", unit: "g",
    perUnit: { protein: 0.31, carbs: 0, fat: 0.036 }, status: "eats",
    updatedAt: "2026-10-04T00:00:00.000Z", ...over } as Food;
}

function seed(...foods: Food[]): void {
  seeded.foods = Object.fromEntries(foods.map((item) => [item.id, item]));
}

const proteins = (n: number) => Array.from({ length: n }, (_, i) =>
  food({ id: `p${i}`, name: `Protein ${String(i).padStart(2, "0")}` }));

beforeEach(() => {
  unbindAccount(); bindAccount(TEST_USER);
  favorites.list.mockReset().mockResolvedValue([]);
  favorites.set.mockReset().mockResolvedValue(true);
  refs.forFood.mockClear();
});
afterEach(cleanup);

describe("calories on a Foods row", () => {
  it("reads per 100 g with the number in the calorie colour", async () => {
    seed(food({}));
    render(<EatsFoods />);
    const row = await screen.findByRole("button", { name: "Edit Chicken breast, cooked" });
    expect(row.textContent).toContain("156 kcal / 100 g");
    expect(row.textContent).not.toMatch(/kcal \/ ?1 g/);
    expect(within(row).getByText("156").className).toContain("kcal");
  });

  it("says a food without nutrition has none instead of printing zero", async () => {
    seed(food({ id: "honey", name: "Honey", role: "carb", status: "avoid", perUnit: { protein: 0, carbs: 0, fat: 0 },
      nutritionUnknown: true }));
    render(<AvoidFoods />);
    const row = await screen.findByRole("button", { name: "Edit Honey" });
    expect(row.textContent).toContain("No nutrition yet");
    expect(row.textContent).not.toContain("0 kcal");
  });
});

describe("starring a food from its row", () => {
  it("is a 44 px toggle button that fills at once and writes through setFavorite", async () => {
    seed(food({}));
    let finish: (value: boolean) => void = () => {};
    favorites.set.mockImplementation(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const changed = vi.fn();
    window.addEventListener("favorites-changed", changed);
    render(<EatsFoods />);
    const star = await screen.findByRole("button", { name: "Star Chicken breast, cooked" });
    expect(star.getAttribute("aria-pressed")).toBe("false");
    expect(star.className).toContain("size-11");
    favorites.list.mockResolvedValue([{ kind: "food", id: "ref-chicken", name: "Chicken", sort: 1 }]);
    fireEvent.click(star);
    // Optimistic: pressed before the write has answered.
    expect(star.getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(favorites.set).toHaveBeenCalledWith("food", "ref-chicken", true,
      { name: "Chicken breast, cooked", catalogFoodId: null }, expect.objectContaining({ userId: TEST_USER })));
    await act(async () => { finish(true); });
    await waitFor(() => expect(changed).toHaveBeenCalled());
    expect(star.getAttribute("aria-pressed")).toBe("true");
    expect(star.querySelector("svg")?.getAttribute("fill")).toBe("currentColor");
    window.removeEventListener("favorites-changed", changed);
  });

  it("rolls the star back and says so when the write fails", async () => {
    seed(food({}));
    favorites.set.mockRejectedValue(new Error("idb blocked"));
    render(<EatsFoods />);
    const star = await screen.findByRole("button", { name: "Star Chicken breast, cooked" });
    fireEvent.click(star);
    expect(star.getAttribute("aria-pressed")).toBe("true");
    expect(await screen.findByText("Could not star Chicken breast, cooked. Try again.")).toBeTruthy();
    expect(star.getAttribute("aria-pressed")).toBe("false");
  });

  it("shows a food already starred, and unstars it", async () => {
    seed(food({}));
    localStorage.setItem("meal-companion:food-pref-refs", JSON.stringify({
      [TEST_USER]: { chicken: { userRefId: "ref-chicken", syncedAt: "2026-10-04", status: "eats", note: null } },
    }));
    favorites.list.mockResolvedValue([{ kind: "food", id: "ref-chicken", name: "Chicken", sort: 1 }]);
    favorites.set.mockResolvedValue(false);
    render(<EatsFoods />);
    const star = await screen.findByRole("button", { name: "Star Chicken breast, cooked" });
    await waitFor(() => expect(star.getAttribute("aria-pressed")).toBe("true"));
    favorites.list.mockResolvedValue([]);
    fireEvent.click(star);
    await waitFor(() => expect(favorites.set).toHaveBeenCalledTimes(1));
    expect(favorites.set).toHaveBeenCalledWith("food", "ref-chicken", false, expect.anything(), expect.anything());
    await waitFor(() => expect(star.getAttribute("aria-pressed")).toBe("false"));
    localStorage.clear();
  });

  it("puts no star on an avoided food", async () => {
    seed(food({ status: "avoid" }));
    render(<AvoidFoods />);
    await screen.findByRole("button", { name: "Edit Chicken breast, cooked" });
    expect(screen.queryByRole("button", { name: /^Favorite / })).toBeNull();
  });
});

describe("a long list", () => {
  it("shows six rows, then Show all N opens the rest in place and Show fewer folds them", async () => {
    seed(...proteins(9));
    render(<EatsFoods />);
    await screen.findByRole("button", { name: "Edit Protein 00" });
    const toggle = screen.getByRole("button", { name: /^Show all 9/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const panel = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
    expect(panel).not.toBeNull();
    // The rest is in the page but inert and hidden until asked for — no nested scroll area.
    expect(within(panel!).getAllByRole("button", { hidden: true, name: /^Edit Protein \d/ })).toHaveLength(3);
    expect(panel!.hasAttribute("inert")).toBe(true);
    expect(screen.getAllByRole("button", { name: /^Edit Protein \d/ })).toHaveLength(6);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toContain("Show fewer");
    expect(panel!.hasAttribute("inert")).toBe(false);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector(".overflow-y-auto, .overflow-auto")).toBeNull();
  });

  it("shows no toggle at six or fewer, and caps the Avoid list too", async () => {
    seed(...proteins(6));
    const { unmount } = render(<EatsFoods />);
    await screen.findByRole("button", { name: "Edit Protein 05" });
    expect(screen.queryByRole("button", { name: /^Show all/ })).toBeNull();
    unmount();
    seed(...proteins(8).map((item) => ({ ...item, status: "avoid" as const })));
    render(<AvoidFoods />);
    await screen.findByRole("button", { name: "Edit Protein 00" });
    expect(screen.getByRole("button", { name: /^Show all 8/ })).toBeTruthy();
  });
});
