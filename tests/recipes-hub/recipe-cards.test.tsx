// @vitest-environment jsdom
/**
 * Recipe card and detail design (owner ask 2026-10-03). Carousel cards are clearly cards: an ivory
 * surface with a hairline and the card shadow on the beige recess, a rounded photo, a bold `.kcal`
 * figure, protein in plum and a sage or Dijon fit tag. The detail reads top to bottom: hero and
 * serif title, glance chips, the colour-coded macro strip, actions, the ingredient checklist (Avoid
 * in each row's overflow), numbered method steps, and a muted footer.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindAccount, markAccountReady, unbindAccount } from "@/lib/device/account";
import type { RecipeCandidate } from "@/lib/recipe-catalog/types";

const search = vi.hoisted(() => vi.fn());
const setFoodMembership = vi.hoisted(() => vi.fn());
vi.mock("@/lib/recipe-catalog-client", async (original) => ({
  ...(await original<typeof import("@/lib/recipe-catalog-client")>()), searchCatalogRecipes: search,
}));
vi.mock("@/lib/foods/prefs-client", async (original) => ({
  ...(await original<typeof import("@/lib/foods/prefs-client")>()), setFoodMembership,
}));
vi.mock("@/lib/recipe-plan-client", () => ({ previewRecipePlan: vi.fn(), acceptRecipePlan: vi.fn() }));
const day = vi.hoisted(() => ({ eaten: { kcal: 600, protein: 40, carbs: 70, fat: 20 },
  targets: { kcal: 2000, protein: 150, carbs: 200, fat: 30 } as { kcal: number; protein: number; carbs: number; fat: number } | null }));
vi.mock("@/lib/recipes-hub/day-after", async (original) => ({
  ...(await original<typeof import("@/lib/recipes-hub/day-after")>()), dayEaten: () => day,
}));

import RecipeDetails from "@/components/RecipeDetails";
import RecipeResultCard from "@/components/RecipeResultCard";
import RecipeCarousel from "@/components/recipes-hub/RecipeCarousel";

const known = (value: number) => ({ value, status: "known" as const, sourceRevisionId: 1 });
function recipe(name: string, kcal: number, over: Partial<RecipeCandidate> = {}): RecipeCandidate {
  return {
    sourceKind: "shared", recipeId: `id-${name}`, revisionId: `rev-${name}`, publicationState: "published",
    withdrawalReason: null, name, cuisine: "Italian", dishTags: [], activeMinutes: 20, totalMinutes: 35,
    effort: "standard", servings: 4, yieldGrams: null, yieldStatus: "unknown", minServingFraction: 0.5,
    maxServingFraction: 2,
    ingredients: [
      { seq: 2, name: "Basil", foodRefId: "f2", catalogFoodRevisionId: 2, quantity: 10, unit: "g", grams: 10,
        state: "raw", required: false, purchaseGrams: 10, purchaseConversionStatus: "known",
        nutrition: { kcal: known(2), protein: known(0), carbs: known(0), fat: known(0) }, allergenEvidence: {} },
      { seq: 1, name: "Beef", foodRefId: "f1", catalogFoodRevisionId: 1, quantity: 500, unit: "g", grams: 500,
        state: "raw", required: true, purchaseGrams: 500, purchaseConversionStatus: "known",
        nutrition: { kcal: known(1000), protein: known(100), carbs: known(0), fat: known(60) }, allergenEvidence: {} },
    ],
    steps: [{ seq: 2, text: "Layer and bake." }, { seq: 1, text: "Brown the beef." }],
    nutritionPerServing: { kcal: known(kcal), protein: known(38), carbs: known(40), fat: known(20) },
    source: { author: "Sasha kitchen", sourceUrl: "https://example.org/r", rightsKind: "original", rightsRecord: "o",
      sourceRevision: "1", kitchenTested: false },
    eligibility: { status: "eligible", reasons: [] }, ...over,
  };
}

beforeEach(() => {
  unbindAccount();
  bindAccount("11111111-1111-4111-8111-111111111111");
  search.mockReset().mockResolvedValue({ recipes: [recipe("Beef lasagna", 520), recipe("Steak", 760)], count: 2,
    limitations: [] });
  setFoodMembership.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("the carousel recipe card", () => {
  it("is an ivory card in a row that bleeds to the panel (no recessed tray), with a rounded photo, bold kcal, plum protein and a fit tag", async () => {
    render(<RecipeCarousel remaining={{ kcal: 600, protein: 50, carbs: 60, fat: 20 }} date="2026-10-03" />);
    const carousel = await screen.findByRole("region", { name: "Recipe catalog" });
    const [fits, over] = within(carousel).getAllByRole("button", { expanded: false })
      .map((button) => button.closest("[data-recipe-card]") as HTMLElement);
    // 2026-10-05 (owner): no hollow tray around the row; an open card fills the panel's width.
    expect(fits.closest(".meal-detail-tray")).toBeNull();
    expect(fits.className).toMatch(/\bbg-surface\b/);
    expect(fits.className).toMatch(/\bborder-hairline\b/);
    expect(fits.className).toMatch(/\bshell\b/);
    expect(fits.querySelector("[data-suggestion-photo]")?.getAttribute("style")).toContain("border-radius: 16px");
    const kcal = fits.querySelector(".kcal")!;
    expect(kcal.textContent).toBe("520");
    expect(kcal.className).toMatch(/\bfont-semibold\b/);
    expect(fits.querySelector(".macro-ink-protein")?.textContent).toBe("38g");
    const fitTag = fits.querySelector('[data-fit="fits"]')!;
    expect(fitTag.textContent).toBe("Fits today");
    expect(fitTag.className).toMatch(/bg-sage-wash.*text-sage-ink/);
    const overTag = over.querySelector('[data-fit="over"]')!;
    expect(overTag.textContent).toBe("~160 kcal over");
    expect(overTag.className).toMatch(/bg-yellow-wash.*text-yellow-ink/);
  });

  it("grows the tapped card in place into the whole recipe, with its actions (U26)", async () => {
    render(<RecipeCarousel remaining={null} date="2026-10-03" />);
    const carousel = await screen.findByRole("region", { name: "Recipe catalog" });
    fireEvent.click(within(carousel).getAllByRole("button", { expanded: false })[0]);
    const open = within(carousel).getByRole("group", { name: "Beef lasagna" });
    expect(open.closest("li")?.className).toMatch(/\bw-full\b/);
    expect(await within(open).findByRole("button", { name: "Put it in a meal" })).toBeTruthy();
    expect(within(open).getByRole("button", { name: "Adjust portion" })).toBeTruthy();
    expect(within(open).getByRole("region", { name: "Ingredients" })).toBeTruthy();
  });

  it("hands focus to the open card and back to its button when it closes, from × or Escape", async () => {
    render(<RecipeCarousel remaining={null} date="2026-10-03" />);
    const carousel = await screen.findByRole("region", { name: "Recipe catalog" });
    fireEvent.click(within(carousel).getAllByRole("button", { expanded: false })[0]);
    const open = within(carousel).getByRole("group", { name: "Beef lasagna" });
    expect(document.activeElement).toBe(open);
    fireEvent.click(within(open).getByRole("button", { name: "Close Beef lasagna" }));
    await waitFor(() => expect(within(carousel).queryByRole("group", { name: "Beef lasagna" })).toBeNull());
    const card = within(carousel).getAllByRole("button", { expanded: false })[0];
    expect(document.activeElement).toBe(card);
    fireEvent.click(card);
    fireEvent.keyDown(await within(carousel).findByRole("button", { name: "Adjust portion" }), { key: "Escape" });
    await waitFor(() => expect(within(carousel).queryByRole("group", { name: "Beef lasagna" })).toBeNull());
    expect(document.activeElement).toBe(within(carousel).getAllByRole("button", { expanded: false })[0]);
  });
});

/** A promise and the hand that settles it, so a test can act while a request is in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("the carousel across an account change (audit g1 MAJOR)", () => {
  it("lets the new account's recipes paint even though the old account's fetch resolves after the new one is ready", async () => {
    const pending = deferred<{ recipes: RecipeCandidate[]; count: number; limitations: string[] }>();
    search.mockReturnValueOnce(pending.promise);
    render(<RecipeCarousel remaining={null} date="2026-10-03" />);
    await waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    search.mockResolvedValueOnce({ recipes: [recipe("Chicken soup", 300)], count: 1, limitations: [] });
    act(() => { markAccountReady(bindAccount("22222222-2222-4222-8222-222222222222")); });
    await screen.findByText("Chicken soup");
    // The old account's response lands last; it must not clobber the new account's painted list.
    await act(async () => { pending.resolve({ recipes: [recipe("Old account's dish", 100)], count: 1, limitations: [] }); });
    expect(screen.getByText("Chicken soup")).toBeTruthy();
    expect(screen.queryByText("Old account's dish")).toBeNull();
    expect(screen.queryByText("Account changed. Close and reopen.")).toBeNull();
  });
});

describe("the recipe detail", () => {
  it("leads with the hero photo, the serif title with the serving's calories, and one line of facets", () => {
    const { container } = render(<RecipeDetails recipe={recipe("Beef lasagna", 520)} />);
    const hero = container.querySelector("header img")!;
    expect(hero.getAttribute("src")).toContain("pasta");
    expect(hero.className).toMatch(/\brounded-2xl\b/);
    expect(screen.getByRole("heading", { name: "Beef lasagna" }).className).toMatch(/font-display.*text-heading\b/);
    const facets = within(screen.getByRole("list", { name: "At a glance" })).getAllByRole("listitem");
    expect(facets.map((facet) => facet.querySelector('span[aria-hidden="true"]')?.textContent)).toEqual(["Italian", "35 min", "Serves 4"]);
    expect(facets.map((facet) => facet.getAttribute("data-facet"))).toEqual(["cuisine", "time", "servings"]);
    expect(container.querySelector("header .kcal")?.textContent).toBe("520");
  });

  it("colour-codes the three macro columns, every bar measured against the day's target", () => {
    render(<RecipeDetails recipe={recipe("Beef lasagna", 520)} />);
    const panel = screen.getByRole("region", { name: "Nutrition" });
    const cell = (key: string) => panel.querySelector(`[data-macro="${key}"]`)!;
    expect(cell("kcal")).toBeNull();
    expect(cell("protein").querySelector(".macro-ink-protein")?.textContent).toBe("38g");
    expect(cell("carbs").querySelector(".macro-ink-carbs")?.textContent).toBe("40g");
    expect(cell("fat").querySelector(".macro-ink-fat")?.textContent).toBe("20g");
    expect(cell("protein").querySelector(".macro-protein.bg-current")).toBeTruthy();
    // 38 of the day's 150 g protein.
    expect(cell("protein").textContent).toContain("25% of day");
    expect(cell("protein").textContent).toContain("Protein: 38 grams, 25% of your day");
  });

  it("shows whole figures with no estimate sign, and switches to the day after one serving", async () => {
    render(<RecipeDetails recipe={recipe("Beef lasagna", 520)} date="2026-10-03" />);
    const panel = screen.getByRole("region", { name: "Nutrition" });
    expect(panel.textContent).not.toContain("≈");
    fireEvent.click(within(panel).getByRole("tab", { name: "Your day" }));
    expect(within(panel).getByRole("tab", { name: "Your day", selected: true })).toBeTruthy();
    // 600 eaten + 520 = 1,120 of 2,000; protein 40 + 38 = 78 of 150, 72 g left; fat 20 + 20 = 40 of 30, 10 g over.
    expect(panel.textContent).toContain("1,120 of 2,000 calories today after this serving");
    await waitFor(() => expect(panel.querySelector('[data-macro="protein"]')?.textContent).toContain("72g left"));
    expect(panel.querySelector('[data-macro="fat"]')?.textContent).toContain("10g over");
    fireEvent.click(within(panel).getByRole("tab", { name: "Per serving" }));
    await waitFor(() => expect(panel.querySelector('[data-macro="protein"]')?.textContent).toContain("25% of day"));
  });

  it("without targets shows each macro's share of the serving's calories and no switch", () => {
    const saved = day.targets;
    day.targets = null;
    try {
      render(<RecipeDetails recipe={recipe("Beef lasagna", 520)} />);
      const panel = screen.getByRole("region", { name: "Nutrition" });
      expect(within(panel).queryByRole("tab")).toBeNull();
      // Shares from the grams themselves: 38 g × 4 of 492 kcal across the three macros.
      expect(panel.querySelector('[data-macro="protein"]')?.textContent).toContain("31% of kcal");
    } finally { day.targets = saved; }
  });

  it("opens Adjust portion inside the card, under its button", () => {
    render(<RecipeResultCard recipe={recipe("Beef lasagna", 520)} expanded onExpandedChange={() => {}}
      actions={{ onFit: vi.fn(), fitPanel: () => <section aria-label="Portion panel" /> }} />);
    const actions = screen.getByRole("group", { name: "Beef lasagna actions" });
    expect(within(actions).getByRole("region", { name: "Portion panel" })).toBeTruthy();
  });

  it("renders its sections in order, with every action still present", async () => {
    render(<RecipeResultCard recipe={recipe("Beef lasagna", 520)} expanded onExpandedChange={() => {}}
      actions={{ onFavorite: vi.fn(), onFit: vi.fn() }} placement={{ initialDate: "2026-10-03" }} />);
    const order = [
      screen.getByRole("list", { name: "At a glance" }),
      screen.getByRole("region", { name: "Nutrition" }),
      screen.getByRole("group", { name: "Beef lasagna actions" }),
      screen.getByRole("region", { name: "Ingredients" }),
      screen.getByRole("region", { name: "Method" }),
      screen.getByRole("contentinfo", { name: "About this recipe" }),
    ];
    for (let index = 1; index < order.length; index += 1)
      expect(order[index - 1].compareDocumentPosition(order[index]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const actions = screen.getByRole("group", { name: "Beef lasagna actions" });
    for (const name of ["Put it in a meal", "Save recipe", "Adjust portion"])
      expect(within(actions).getByRole("button", { name })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Beef lasagna/, expanded: true })).toBeTruthy();
  });

  it("lists ingredients as a checklist with amounts on the right and Avoid in a quiet overflow", async () => {
    const changed = vi.fn();
    window.addEventListener("recipe-avoid-changed", changed);
    render(<RecipeDetails recipe={recipe("Beef lasagna", 520)} />);
    const list = screen.getByRole("region", { name: "Ingredients" });
    const boxes = within(list).getAllByRole("checkbox");
    expect(boxes.map((box) => box.closest("label")?.textContent)).toEqual(["Beef", "Basiloptional"]);
    expect(list.querySelector('[data-ingredient="Beef"]')?.textContent).toContain("500 g");
    expect(screen.queryByRole("button", { name: "Avoid Beef" })).toBeNull();
    fireEvent.click(boxes[0]);
    expect((boxes[0] as HTMLInputElement).checked).toBe(true);
    const more = screen.getByRole("button", { name: "More for Beef" });
    fireEvent.click(more);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Avoid Beef" })); });
    expect(setFoodMembership).toHaveBeenCalledWith("Beef", "avoid", expect.objectContaining({ acknowledge: true }));
    expect(screen.getByRole("status").textContent).toContain("Beef added to your Avoid rules.");
    expect(changed).toHaveBeenCalledTimes(1);
    window.removeEventListener("recipe-avoid-changed", changed);
  });

  it("numbers the method as step cards and keeps provenance in a muted footer", () => {
    render(<RecipeDetails recipe={recipe("Beef lasagna", 520, { nutritionPerServing: {
      kcal: { value: 520, status: "estimated", sourceRevisionId: null }, protein: known(38), carbs: known(40),
      fat: known(20) } })} />);
    const steps = within(screen.getByRole("region", { name: "Method" })).getAllByRole("listitem");
    expect(steps.map((step) => step.textContent)).toEqual(["1Step 1. Brown the beef.", "2Step 2. Layer and bake."]);
    // Each step its own tone, starting grey: neighbouring steps never share a wash.
    expect(steps.map((step) => step.getAttribute("data-step-tone"))).toEqual(["0", "1"]);
    expect(steps.every((step) => step.classList.contains("step-card"))).toBe(true);
    const footer = screen.getByRole("contentinfo", { name: "About this recipe" });
    expect(footer.className).toMatch(/text-tiny.*text-muted|text-muted.*text-tiny/);
    expect(footer.textContent).toContain("Nutrition is estimated.");
    expect(footer.textContent).toContain("Kitchen test not recorded.");
    expect(within(footer).getByRole("link", { name: "View source" })).toBeTruthy();
  });
});
