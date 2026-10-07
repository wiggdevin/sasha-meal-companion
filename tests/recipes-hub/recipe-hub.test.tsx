// @vitest-environment jsdom
/**
 * The Foods recipe widget (owner ask 2026-10-03): New recipe grows into a card in place, with quick
 * chips, a swipeable catalog gated on recipe access, and an ask box with camera and upload. Asks are
 * `recipes`-surface coach turns; a meal already eaten is logged only after a Log it tap.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetTestAccount, TEST_USER } from "@/tests/helpers/account";
import { bindAccount } from "@/lib/device/account";
import { fly, resetFlightsForTests } from "@/components/single-flight";
import type { RecipeCandidate } from "@/lib/recipe-catalog/types";

const postTurn = vi.hoisted(() => vi.fn());
const search = vi.hoisted(() => vi.fn());
const logDescribed = vi.hoisted(() => vi.fn());
const proposeDescribed = vi.hoisted(() => vi.fn());
const commitPanelDraft = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coach-client", async (original) => ({
  ...(await original<typeof import("@/lib/coach-client")>()), postTurn,
}));
vi.mock("@/lib/recipe-catalog-client", async (original) => ({
  ...(await original<typeof import("@/lib/recipe-catalog-client")>()), searchCatalogRecipes: search,
}));
vi.mock("@/lib/plan/photo-log", async (original) => ({
  ...(await original<typeof import("@/lib/plan/photo-log")>()), logDescribed, proposeDescribed, commitPanelDraft,
}));
vi.mock("@/lib/resolve", async (original) => ({
  ...(await original<typeof import("@/lib/resolve")>()),
  resolveDay: () => ({
    targets: { kcal: 2000, protein: 150, carbs: 200, fat: 60 },
    consumed: { kcal: 1400, protein: 100, carbs: 150, fat: 40 },
    slots: [{ slot: "meal-1", time: "00:00", label: "Meal 1" }],
  }),
}));
vi.mock("@/components/RecipePlanFlow", () => ({
  default: ({ recipe }: { recipe: { name: string } }) => <p>Planning {recipe.name}</p>,
}));
vi.mock("@/components/CatalogRecipeResults", () => ({
  default: ({ recipes }: { recipes: { name: string }[] }) =>
    <ul aria-label="Catalog matches">{recipes.map((recipe) => <li key={recipe.name}>{recipe.name}</li>)}</ul>,
}));
vi.mock("@/components/RecipeSheet", async () => {
  const { useSheetPresentation } = await import("@/components/Sheet");
  return { default: function Editor() {
    return <div data-testid="recipe-editor" data-presentation={useSheetPresentation()}>Recipe name</div>;
  } };
});

import RecipeHub from "@/components/recipes-hub/RecipeHub";
import { hubApplyPrefix } from "@/components/recipes-hub/HubAnswer";

function recipe(name: string, kcal: number | null, protein: number): RecipeCandidate {
  return {
    sourceKind: "shared", recipeId: `id-${name}`, revisionId: `rev-${name}`, publicationState: "published",
    withdrawalReason: null, name, cuisine: "Italian", dishTags: [], activeMinutes: 20, totalMinutes: 25,
    effort: "minimal", servings: 4, yieldGrams: null, yieldStatus: "unknown", minServingFraction: 0.5,
    maxServingFraction: 2, ingredients: [], steps: [{ seq: 1, text: "Boil the water." }],
    nutritionPerServing: {
      kcal: { value: kcal, status: kcal === null ? "unknown" : "known", sourceRevisionId: null },
      protein: { value: protein, status: "known", sourceRevisionId: null },
      carbs: { value: 40, status: "known", sourceRevisionId: null },
      fat: { value: 18, status: "known", sourceRevisionId: null },
    },
    source: { author: "x", sourceUrl: null, rightsKind: "original", rightsRecord: "x", sourceRevision: "1",
      kitchenTested: true },
    eligibility: { status: "eligible", reasons: [] },
  };
}

const RECIPES = [recipe("Beef lasagna", 520, 38), recipe("Steak and potatoes", 760, 55), recipe("Mystery stew", null, 20)];

function answer(content: string, extra: Record<string, unknown> = {}) {
  return { threadId: "3f1b1a2c-0000-4000-8000-0000000000aa", suggestions: [], actions: [], draft: null,
    composed: [], deflected: false, toolsUsed: [], model: { provider: "gemini", modelId: "m" },
    messages: [{ id: "a", role: "assistant", content }], ...extra };
}

const ENABLED = { enabled: true, loading: false };
const field = () => screen.getByRole("textbox", { name: "Ask about recipes" }) as HTMLInputElement;
async function ask(text: string) {
  fireEvent.change(field(), { target: { value: text } });
  await act(async () => { fireEvent.submit(field().form!); });
}

beforeEach(async () => {
  resetFlightsForTests();
  await resetTestAccount();
  postTurn.mockReset().mockResolvedValue(answer("Here are a few."));
  search.mockReset().mockResolvedValue({ recipes: RECIPES, count: 3, limitations: [] });
  logDescribed.mockReset().mockResolvedValue({ ok: true, date: "2026-10-03" });
  // A proposal the test does not render: the review step is proven in tests/plan/plan-sheet-photo.
  proposeDescribed.mockReset().mockResolvedValue({ ok: false, message: "Nothing matched to log." });
  commitPanelDraft.mockReset();
});
afterEach(() => { cleanup(); });

describe("the recipe widget", () => {
  it("leads with one scrollable row of the six quick actions and a close button", () => {
    render(<RecipeHub access={ENABLED} onClose={() => {}} onSaved={() => {}} />);
    const chips = within(screen.getByRole("group", { name: "Quick actions" })).getAllByRole("button");
    expect(chips.map((chip) => chip.textContent)).toEqual(["Suggest a recipe", "High protein",
      "Under 30 min", "Comfort food", "Use what I have", "Build my own"]);
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    expect(screen.getByText(/About 600 kcal · 50 g protein left today/)).toBeTruthy();
  });

  it("shows the catalog as swipeable cards with a fit tag, and opens one in place to adjust its portion", async () => {
    render(<RecipeHub access={ENABLED} onClose={() => {}} onSaved={() => {}} />);
    const carousel = await screen.findByRole("region", { name: "Recipe catalog" });
    expect(search).toHaveBeenCalledWith({ query: "", limit: 25 }, expect.anything());
    // Each card is one button over its content; the content sits in the card (U26: it grows in place).
    const buttons = within(carousel).getAllByRole("button", { expanded: false });
    expect(buttons).toHaveLength(3);
    const cards = buttons.map((button) => button.closest("[data-recipe-card]") as HTMLElement);
    expect(cards[0].textContent).toContain("Beef lasagna");
    expect(cards[0].textContent).toContain("520kcal");
    expect(cards[0].textContent).toContain("38g");
    expect(cards[0].querySelector(".kcal")?.textContent).toBe("520");
    expect(cards[0].textContent).toContain("Fits today");
    expect(cards[1].textContent).toContain("~160 kcal over");
    expect(cards[2].textContent).not.toMatch(/Fits today|over/);
    expect(cards[0].querySelector("img")?.getAttribute("src")).toContain("pasta");
    fireEvent.click(buttons[0]);
    expect(within(carousel).getByRole("group", { name: "Beef lasagna" })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Adjust portion" }));
    expect(screen.getByText("Planning Beef lasagna")).toBeTruthy();
  });

  it("hides the catalog and says why when the account has no recipe access", () => {
    render(<RecipeHub access={{ enabled: false, loading: false }} onClose={() => {}} onSaved={() => {}} />);
    expect(screen.queryByRole("region", { name: "Recipe catalog" })).toBeNull();
    expect(screen.getByText(/recipe catalog isn’t on for this account/)).toBeTruthy();
    expect(search).not.toHaveBeenCalled();
  });

  it("sends a typed ask as a recipes-surface turn, catalog matches first", async () => {
    postTurn.mockResolvedValue(answer("Two Italian dishes fit.", { composed: [{
      wish: "Chicken pesto pasta", slot: null, fitsTarget: true, flagged: [],
      totals: { kcal: 550, protein: 45, carbs: 50, fat: 15 }, target: { kcal: 600, protein: 50, carbs: 50, fat: 20 },
      items: [{ name: "chicken breast", grams: 150, foodRefId: "f1", verdict: "allowed" }],
    }] }));
    render(<RecipeHub access={ENABLED} onClose={() => {}} onSaved={() => {}} />);
    await ask("I feel like Italian, is there anything I can have without going over?");
    expect(postTurn).toHaveBeenCalledTimes(1);
    expect(postTurn.mock.calls[0][0]).toMatchObject({ surface: "recipes",
      text: "I feel like Italian, is there anything I can have without going over?" });
    expect(search).toHaveBeenCalledWith(expect.objectContaining({
      query: "I feel like Italian, is there anything I can have without going over?" }), expect.anything());
    await screen.findByText("Two Italian dishes fit.");
    const matches = screen.getByRole("list", { name: "Catalog matches" });
    const meals = screen.getByRole("region", { name: "Meals that fit" });
    expect(matches.compareDocumentPosition(meals) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(meals).getByText("Chicken pesto pasta")).toBeTruthy();
  });

  it("turns a chip into a recipes-surface turn with its own need", async () => {
    render(<RecipeHub access={ENABLED} onClose={() => {}} onSaved={() => {}} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Under 30 min" })); });
    expect(postTurn.mock.calls[0][0]).toMatchObject({ surface: "recipes" });
    expect(postTurn.mock.calls[0][0].text).toMatch(/under 30 minutes/);
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ maxMinutes: 30 }), expect.anything());
    expect(screen.getByRole("button", { name: "Under 30 min" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("has both a rear camera and an upload picker for photos", () => {
    const { container } = render(<RecipeHub access={ENABLED} onClose={() => {}} onSaved={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Add a photo or file" }));
    expect(screen.getByRole("button", { name: "Take a photo" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Upload a photo" })).toBeTruthy();
    const camera = container.querySelector<HTMLInputElement>('input[data-photo-input="camera"]')!;
    const upload = container.querySelector<HTMLInputElement>('input[data-photo-input="upload"]')!;
    expect(camera.accept).toBe("image/*");
    expect(camera.hasAttribute("capture")).toBe(false);
    expect(upload.accept).toBe("image/*");
    expect(upload.hasAttribute("capture")).toBe(false);
  });

  it("rotates the owner's own phrasings through the placeholder", () => {
    vi.useFakeTimers();
    try {
      render(<RecipeHub access={ENABLED} onClose={() => {}} onSaved={() => {}} />);
      expect(field().placeholder).toBe("I feel like Italian…");
      act(() => { vi.advanceTimersByTime(3500); });
      expect(field().placeholder).toBe("Something hearty, it’s cold");
      act(() => { vi.advanceTimersByTime(3500); });
      expect(field().placeholder).toBe("How much lasagna can I have?");
    } finally { vi.useRealTimers(); }
  });

  it("opens Build my own as the recipe editor inside the widget, not a bottom sheet", () => {
    render(<RecipeHub access={ENABLED} onClose={() => {}} onSaved={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Build my own" }));
    const editor = screen.getByTestId("recipe-editor");
    expect(editor.getAttribute("data-presentation")).toBe("attached");
    expect(screen.getByRole("region", { name: "New recipe" }).contains(editor)).toBe(true);
    expect(screen.queryByRole("textbox", { name: "Ask about recipes" })).toBeNull();
  });

  it("checks a meal already eaten before anything is logged, and sends no coach turn (U23)", async () => {
    render(<RecipeHub access={ENABLED} onClose={() => {}} onSaved={() => {}} />);
    await ask("I had two slices of the lasagna");
    expect(postTurn).not.toHaveBeenCalled();
    expect(proposeDescribed).not.toHaveBeenCalled();
    expect(screen.getByText("Log “I had two slices of the lasagna” to Meal 1?")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Check it" })); });
    expect(proposeDescribed).toHaveBeenCalledTimes(1);
    expect(proposeDescribed.mock.calls[0][1]).toBe("I had two slices of the lasagna");
    expect(proposeDescribed.mock.calls[0][2]).toBe("meal-1");
    // Proposing writes nothing: no one-step log, no commit.
    expect(logDescribed).not.toHaveBeenCalled();
    expect(commitPanelDraft).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText("Nothing matched to log.")).toBeTruthy());
  });

  it("answers a portion question with the coach's words and checks its portion before logging", async () => {
    postTurn.mockResolvedValue(answer(
      "About 1 slice (~350 g, ~520 kcal) fits; 2 slices puts you ~300 kcal over. This is an estimate.",
      { suggestions: [{ foodRefId: "f", name: "lasagna", grams: 350, reason: null, verdict: "allowed" }] }));
    render(<RecipeHub access={ENABLED} onClose={() => {}} onSaved={() => {}} />);
    await ask("A friend is coming over and cooking lasagna, how much can I eat?");
    expect(postTurn.mock.calls[0][0]).toMatchObject({ surface: "recipes" });
    await screen.findByText(/About 1 slice/);
    expect(proposeDescribed).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Check it" })); });
    expect(proposeDescribed.mock.calls[0][1]).toBe("350 g lasagna");
    expect(logDescribed).not.toHaveBeenCalled();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("the recipe widget across an account change (audit r4)", () => {
  it("keeps Close disabled while a composed meal is saving, wherever it was tapped", async () => {
    const pending = deferred<void>();
    const onClose = vi.fn();
    void fly(`${hubApplyPrefix(TEST_USER)}a1`, () => pending.promise);
    render(<RecipeHub access={ENABLED} onClose={onClose} onSaved={() => {}} />);
    const close = screen.getByRole("button", { name: "Close" }) as HTMLButtonElement;
    expect(close.disabled).toBe(true);
    await act(async () => { pending.resolve(); });
    expect(close.disabled).toBe(false);
  });

  it("drops an ask's catalog matches that land after the account changed", async () => {
    const pending = deferred<{ recipes: RecipeCandidate[]; count: number; limitations: [] }>();
    render(<RecipeHub access={ENABLED} onClose={() => {}} onSaved={() => {}} />);
    await screen.findByRole("region", { name: "Recipe catalog" });
    search.mockReturnValueOnce(pending.promise);
    const turn = deferred<ReturnType<typeof answer>>();
    postTurn.mockReturnValueOnce(turn.promise);
    await ask("Something Italian");
    bindAccount("22222222-2222-4222-8222-222222222222");
    await act(async () => { pending.resolve({ recipes: RECIPES, count: 3, limitations: [] }); });
    await act(async () => { turn.resolve(answer("Here.")); });
    expect(screen.queryByRole("list", { name: "Catalog matches" })).toBeNull();
  });

  it("never paints the carousel read for an account that is no longer bound", async () => {
    const pending = deferred<{ recipes: RecipeCandidate[]; count: number; limitations: [] }>();
    search.mockReturnValueOnce(pending.promise);
    render(<RecipeHub access={ENABLED} onClose={() => {}} onSaved={() => {}} />);
    bindAccount("22222222-2222-4222-8222-222222222222");
    await act(async () => { pending.resolve({ recipes: RECIPES, count: 3, limitations: [] }); });
    expect(screen.queryByRole("region", { name: "Recipe catalog" })).toBeNull();
    // The ask box's own account-gone state says the same thing now (audit f2 BLOCKER): more than
    // one "Account changed" notice on screen is expected, not a single, specific one.
    expect(screen.getAllByText("Account changed. Close and reopen.").length).toBeGreaterThan(0);
  });

  it("drops the carousel and an ask's catalog matches already settled on screen when the account changes (audit f2 BLOCKER)", async () => {
    render(<RecipeHub access={ENABLED} onClose={() => {}} onSaved={() => {}} />);
    await screen.findByRole("region", { name: "Recipe catalog" });
    await ask("Something Italian");
    expect(screen.getByRole("list", { name: "Catalog matches" })).toBeTruthy();
    act(() => { bindAccount("22222222-2222-4222-8222-222222222222"); });
    expect(screen.queryByRole("region", { name: "Recipe catalog" })).toBeNull();
    expect(screen.queryByRole("list", { name: "Catalog matches" })).toBeNull();
    expect(screen.getAllByText("Account changed. Close and reopen.").length).toBeGreaterThan(0);
  });
});
