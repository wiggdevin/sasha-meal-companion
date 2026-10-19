// @vitest-environment jsdom
/**
 * Design §8.3 — the render spec for the Foods tab's cards: the favorites strip failed / empty /
 * populated / expanded, `MyFoods` empty / eats / avoid / save-error / truncated, the Avoid rules
 * card with no row / populated / offline / failed, and the recipes list empty / populated / with
 * a recipe whose energy is unset.
 *
 * jsdom, because three of these four read IndexedDB or `localStorage` in an effect; the stores
 * behind them are mocked so the spec is about what the card says, not about the database.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Food } from "@/lib/foods";
import type { Profile } from "@/lib/constraints-client";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { TEST_USER } from "@/tests/helpers/account";

/** Phase 9 §0.1: every call acts for the bound account. */
beforeEach(() => { unbindAccount(); bindAccount(TEST_USER); });

const listFavorites = vi.fn();
const listRecipes = vi.fn();
const toggleFavorite = vi.fn();
const { saveFoodEditsMock } = vi.hoisted(() => ({ saveFoodEditsMock: vi.fn() }));

vi.mock("@/lib/foods/prefs-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/foods/prefs-client")>();
  return { ...actual, saveFoodEdits: (...args: Parameters<typeof actual.saveFoodEdits>) =>
    saveFoodEditsMock(...args) };
});

vi.mock("@/lib/favorites-client", () => ({
  listFavorites: () => listFavorites(),
  toggleFavorite: (...a: unknown[]) => toggleFavorite(...a),
}));
/**
 * `MyFoods` reads the phone's food projection with `loadStore()` (components/MyFoods.tsx:97).
 * The projection is built from the account's sync mirrors and is deliberately NOT restored from
 * the local blob (design §7.1, lib/store.ts:102-104), so a seeded store cannot be read back
 * through localStorage. The read is pinned here instead, which is what these four states are
 * about: what the card says about a set of foods, not how the set reached the device.
 */
const seeded: { foods: Record<string, Food> } = { foods: {} };
vi.mock("@/lib/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store")>();
  return { ...actual, loadStore: () => ({ ...actual.defaultStore(), foods: seeded.foods }) };
});
vi.mock("@/lib/recipes-client", async (importOriginal) => ({
  // The pure serving reader is the real one (#21): the card says what the stored coverage allows.
  recipeServingNutrition: (await importOriginal<typeof import("@/lib/recipes-client")>()).recipeServingNutrition,
  listRecipes: () => listRecipes(),
  saveRecipe: vi.fn(), deleteRecipe: vi.fn(),
}));

const FavoritesStrip = (await import("@/components/FavoritesStrip")).default;
const AvoidRules = (await import("@/components/AvoidRules")).default;
const RecipesSection = (await import("@/components/RecipesSection")).default;
const { default: EatsFoods, AvoidFoods, foodMembershipError, foodMembershipNotice } =
  await import("@/components/MyFoods");
const { FOOD_MEMBERSHIP_SAVE_MESSAGE, FOOD_MEMBERSHIP_TRUNCATED_MESSAGE } =
  await import("@/lib/foods/prefs-client");

const FAVORITE = { kind: "food" as const, id: "f1", name: "Oats", sort: 1 };
/** One more than `PINNED_LIMIT`, so the strip has a rest to hide behind the count. */
const MANY = Array.from({ length: 13 }, (_, i) => ({ ...FAVORITE, id: `f${i}`,
  name: `Food ${i}`, sort: i + 1 }));

function food(over: Partial<Food>): Food {
  return { id: over.id ?? "f1", name: over.name ?? "Oats", role: "carb", unit: "g",
    perUnit: { protein: 0.1, carbs: 0.6, fat: 0.07 }, status: "eats",
    updatedAt: "2026-09-20T00:00:00.000Z", ...over } as Food;
}

function seedFoods(foods: Food[]): void {
  seeded.foods = Object.fromEntries(foods.map((f) => [f.id, f]));
}

beforeEach(() => {
  listFavorites.mockReset().mockResolvedValue([]);
  listRecipes.mockReset().mockResolvedValue([]);
  toggleFavorite.mockReset().mockResolvedValue(undefined);
  saveFoodEditsMock.mockReset().mockResolvedValue({ syncing: false, membership: null });
  localStorage.clear();
  seeded.foods = {};
});
afterEach(cleanup);

describe("the favorites strip", () => {
  it("renders nothing at all before anything is starred", async () => {
    const { container } = render(<FavoritesStrip />);
    await waitFor(() => expect(listFavorites).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("says the read failed rather than looking like an empty list", async () => {
    listFavorites.mockRejectedValue(new Error("blocked"));
    render(<FavoritesStrip />);
    await screen.findByText("Couldn't load favorites.");
  });

  it("draws the pinned chips, and keeps the rest behind one count", () => {
    const markup = renderToStaticMarkup(<FavoritesStrip initial={MANY} />);
    expect(markup).toContain("Food 0");
    expect(markup).toContain("All (13)");
    // The thirteenth is the one past the pinned limit: it is not drawn until asked for.
    expect(markup).not.toContain("Food 12");
  });

  it("shows every chip once expanded", async () => {
    listFavorites.mockResolvedValue(MANY);
    render(<FavoritesStrip initial={MANY} />);
    const all = await screen.findByText("All (13)");
    fireEvent.click(all);
    await screen.findByText("Food 12");
    expect(screen.queryByText("All (13)")).toBeNull();
  });
});

describe("MyFoods", () => {
  it("says the favorites list is empty rather than showing nothing", async () => {
    seedFoods([]);
    render(<EatsFoods />);
    await waitFor(() =>
      expect(screen.getByText("Nothing here yet.")).toBeTruthy());
  });

  it("lists an Eats food under its own macro role", async () => {
    seedFoods([food({ name: "Oats", role: "carb", status: "eats" })]);
    render(<EatsFoods />);
    await screen.findByText("Oats");
  });

  it("says the avoid list is empty, and lists the food once one is marked", async () => {
    seedFoods([]);
    const { unmount } = render(<AvoidFoods />);
    await screen.findByText(
      "Nothing here. Add one below, or move a food here from Favorites.");
    unmount();

    seedFoods([food({ id: "f2", name: "Raw onion", status: "avoid" })]);
    render(<AvoidFoods />);
    await screen.findByText("Raw onion");
  });

  it("does not treat editing an existing Avoid note as a new exclusion", async () => {
    seedFoods([food({ id: "f2", name: "Raw onion", status: "avoid", note: "Old note" })]);
    const onAvoidSaved = vi.fn();
    render(<AvoidFoods onAvoidSaved={onAvoidSaved} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Raw onion" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Note to self" }),
      { target: { value: "New note" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(saveFoodEditsMock).toHaveBeenCalledTimes(1));
    await screen.findByText("Changes saved.");
    expect(onAvoidSaved).not.toHaveBeenCalled();
  });

  it("has one save error sentence for a save that did not go through", () => {
    expect(foodMembershipError(new Error("nope"))).toBe(FOOD_MEMBERSHIP_SAVE_MESSAGE);
  });

  it("says truncated when a mark reached only part of a wider family", () => {
    expect(foodMembershipNotice({ truncated: true })).toBe(FOOD_MEMBERSHIP_TRUNCATED_MESSAGE);
    expect(foodMembershipNotice({ truncated: false })).toBeNull();
    expect(foodMembershipNotice(null)).toBeNull();
  });
});

describe("the Avoid rules card", () => {
  const profile = (over: Partial<Profile> = {}): Profile => ({
    avoid_allergens: [], banned_categories: [], conditions: [], ...over } as Profile);

  it("says there are no rules yet on an account that has set none", () => {
    const markup = renderToStaticMarkup(<AvoidRules initial={profile()} />);
    expect(markup).toContain("No food rules yet");
    expect(markup).toContain("Add a rule");
  });

  it("is populated: it lists the rules the account actually has", () => {
    const markup = renderToStaticMarkup(
      <AvoidRules initial={profile({ avoid_allergens: ["gluten"] })} />);
    expect(markup).toContain("Allergens");
    expect(markup).not.toContain("No food rules yet");
  });

  it("never calls an unread profile an empty one", () => {
    const markup = renderToStaticMarkup(<AvoidRules />);
    expect(markup).not.toContain("No food rules yet");
    expect(markup).toMatch(/Checking your rules…|Your rules load when you are back online\./);
  });

  it("says the load failed, and offers Retry, when the read comes back empty online", async () => {
    // `loadConstraints` answers `null` on any non-OK response (lib/constraints-client.ts:26-34),
    // which is the failed read this state is about.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("no", { status: 500 }) as never);
    render(<AvoidRules />);
    await screen.findByText("Could not load your rules.");
    // The wrong answer here is "no rules yet": a failed read must never read as an empty list.
    expect(screen.queryByText("No food rules yet")).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    vi.restoreAllMocks();
  });

  it("is offline: it says the rules load again once the device is back online", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    render(<AvoidRules />);
    await screen.findByText("Your rules load when you are back online.");
    vi.restoreAllMocks();
  });
});

describe("the recipes list", () => {
  it("says nothing is saved yet, and what a recipe is for", async () => {
    render(<RecipesSection />);
    await screen.findByText(/Nothing saved yet\./);
  });

  it("is populated: it names each recipe with its servings, and no version", async () => {
    listRecipes.mockResolvedValue([{ id: "r1", name: "Tray bake", servings: 4, rev: 2,
      nutrients_per_serving: { energy_kcal: 520, coverage: 1 }, items: [] }]);
    render(<RecipesSection />);
    await screen.findByText("Tray bake");
    const meta = await screen.findByText(/^4 servings/);
    expect(meta.textContent).toContain("520");
    expect(meta.textContent).toContain("kcal a serving");
    expect(meta.textContent).not.toContain("at least");
    expect(meta.textContent).not.toContain("version");
  });

  it("has no calories clause on a recipe whose energy is not set", async () => {
    listRecipes.mockResolvedValue([{ id: "r2", name: "Soup", servings: 2, rev: 1,
      nutrients_per_serving: {}, items: [] }]);
    render(<RecipesSection />);
    const meta = await screen.findByText(/^2 servings/);
    expect(meta.textContent).not.toContain("kcal a serving");
    expect(meta.textContent).not.toContain("0 kcal");
  });
});
