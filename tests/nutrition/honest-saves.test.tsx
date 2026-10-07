// @vitest-environment jsdom
/**
 * Calculation audit #21, the UI half off Today: a saved recipe card says "at least" for a partly
 * measured serving and no number for an unknown one; a shopping choice names a protein shortfall
 * only when there is one; and a save whose partial check could not run (`nutrition_unchecked`)
 * says "Saved. Nutrition not fully checked." once — in the scan sheet's confirmation, the coach's
 * food-search row and its log draft — and a normal save says nothing more.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FoodSearchBlock from "@/components/coach/blocks/food_search";
import LogDraftBlock from "@/components/coach/blocks/log_draft";
import ShoppingPreview from "@/components/ShoppingPreview";
import { commitLogEntry } from "@/lib/log-commit-client";
import type { LogDraftBlockV1 } from "@/lib/coach/ui-blocks";
import type { RecipeRow } from "@/lib/recipes-client";
import type { AcceptedRecipeSelection } from "@/lib/shopping/preview-contract";
import type { ShoppingPeriod } from "@/lib/shopping/types";
import { blockContext } from "@/tests/coach/blocks-client/fixtures";
import { barcodeResponse } from "@/tests/coach/editors/fixtures";
import { resetTestAccount } from "@/tests/helpers/account";

const recipes = vi.hoisted(() => ({ rows: [] as RecipeRow[] }));
vi.mock("@/lib/recipes-client", async (original) => ({
  ...(await original<typeof import("@/lib/recipes-client")>()), listRecipes: vi.fn(async () => recipes.rows),
}));
vi.mock("@/lib/favorites-client", async (original) => ({
  ...(await original<typeof import("@/lib/favorites-client")>()), listFavorites: vi.fn(async () => []),
}));
vi.mock("@/lib/log-commit-client", async (original) => ({
  ...await original<typeof import("@/lib/log-commit-client")>(), commitLogEntry: vi.fn(),
}));

const UNCHECKED = "Saved. Nutrition not fully checked.";
const ok = (extra: Record<string, unknown> = {}) => ({ status: "ok" as const, entry_id: "e", rev: 1,
  items: [], totals: {}, ...extra }) as never;

beforeEach(async () => { await resetTestAccount(); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("saved recipe cards", () => {
  const row = (name: string, nutrients: Record<string, number | null>): RecipeRow => ({ id: name, name,
    servings: 2, yield_grams: null, rev: 1, items: [], nutrients_per_serving: nutrients });

  it("say at least for a partial serving, plainly for a whole one, and no number when unknown", async () => {
    recipes.rows = [row("Whole stew", { energy_kcal: 420, coverage: 1 }),
      row("Partial stew", { energy_kcal: 310, coverage: 0.5 }),
      row("Unknown stew", { energy_kcal: null, coverage: 0 }),
      row("Legacy stew", { energy_kcal: 250 })];
    const { default: RecipesSection } = await import("@/components/RecipesSection");
    render(<RecipesSection />);
    await act(async () => {});
    const card = (name: string) => screen.getByText(name).parentElement!.textContent ?? "";
    expect(card("Whole stew")).toContain("420 calories");
    expect(card("Whole stew")).not.toContain("at least");
    expect(card("Partial stew")).toContain("at least310 calories");
    expect(card("Unknown stew")).not.toMatch(/kcal|calories|—/);
    // A stored row with no coverage is not known to be whole: it reads as a lower bound.
    expect(card("Legacy stew")).toContain("at least250 calories");
  });
});

describe("shopping choices", () => {
  const period = { id: "p1", userId: "u1", startDate: "2026-10-05", endDate: "2026-10-11",
    timezone: "America/Denver", planRevision: 1, revision: 1, lockMode: "none" } as unknown as ShoppingPeriod;
  const choice = (gap: number | null | undefined, name: string): AcceptedRecipeSelection => ({
    localDate: "2026-10-06", slotId: "meal-2", recipeName: name, servingFraction: 1,
    proteinGapGrams: gap } as unknown as AcceptedRecipeSelection);

  it("names a protein shortfall below zero, and nothing at zero, above it, or unknown", () => {
    render(<ShoppingPreview current={[]} preview={{ period, lines: [], issues: [], unmetPins: [],
      choices: [choice(-12.4, "Short"), choice(0, "Even"), choice(6, "Over"), choice(null, "Kept"),
        choice(undefined, "Old")], accept: vi.fn() }} onAccepted={vi.fn()} onCancel={vi.fn()} />);
    const item = (name: string) => screen.getByText(new RegExp(`: ${name} ·`)).textContent ?? "";
    expect(item("Short")).toContain("· 12g short of protein");
    for (const name of ["Even", "Over", "Kept", "Old"]) expect(item(name)).not.toContain("short of protein");
  });
});

describe("nutrition not fully checked", () => {
  const row = { foodRefId: "11111111-1111-4111-8111-111111111111", revisionId: "71", name: "Stew",
    kcalPer100g: 130, status: "neutral" as const, blocked: false };
  const search = { kind: "food_search" as const, v: 1 as const, id: "s", query: "stew", intent: "log" as const,
    results: [row], truncated: false };

  it("shows the line once beside a logged food-search row, and nothing for a normal save", async () => {
    const logFood = vi.fn().mockResolvedValueOnce(UNCHECKED).mockResolvedValueOnce(undefined);
    render(<FoodSearchBlock block={search} ctx={blockContext({ logFood })} />);
    fireEvent.click(screen.getByRole("button", { name: "Log" }));
    expect(await screen.findByText(UNCHECKED)).toBeTruthy();
    expect(screen.getAllByText(UNCHECKED)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Log" }));
    await waitFor(() => expect(logFood).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(UNCHECKED)).toBeNull());
  });

  const draft: LogDraftBlockV1 = { kind: "log_draft", v: 1, id: "barcode-block", source: "barcode",
    localDate: "2026-09-19", slot: "meal-2", draft: barcodeResponse, policy: { blocked: false }, status: "pending" };

  it.each([
    ["an unchecked save says so in place of Logged", ok({ nutrition_unchecked: true }), UNCHECKED],
    ["a normal save says Logged", ok(), "Logged"],
  ])("log draft: %s", async (_name, answer, line) => {
    vi.mocked(commitLogEntry).mockResolvedValue(answer);
    render(<LogDraftBlock block={draft} ctx={blockContext()} />);
    fireEvent.click(screen.getByRole("button", { name: "Log it" }));
    expect(await screen.findByText(line)).toBeTruthy();
    if (line === UNCHECKED) expect(screen.queryByText("Logged")).toBeNull();
    else expect(screen.queryByText(UNCHECKED)).toBeNull();
  });

  it.each([
    ["hands Today the line for an unchecked save", ok({ nutrition_unchecked: true }), UNCHECKED],
    ["hands Today nothing more for a normal save", ok(), undefined],
  ])("scan sheet: %s", async (_name, answer, saved) => {
    vi.mocked(commitLogEntry).mockResolvedValue(answer);
    const { default: ScanConfirmSheet } = await import("@/components/ScanConfirmSheet");
    const onLogged = vi.fn();
    render(<ScanConfirmSheet response={barcodeResponse} slot="meal-2" onLogged={onLogged} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Log it" }));
    await waitFor(() => expect(onLogged).toHaveBeenCalledOnce());
    expect(onLogged.mock.calls[0][1]).toBe(saved);
  });
});
