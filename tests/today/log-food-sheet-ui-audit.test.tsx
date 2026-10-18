// @vitest-environment jsdom
/**
 * UI audit 2026-10-18 §6, the log sheet: a catalog pick says it is getting ready (never "Sign in"
 * to someone signed in), a favorite chip that cannot open a food says why instead of doing
 * nothing, and the bundled food's Add button no longer carries a long USDA portion label.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CachedRevision } from "@/lib/db/catalog-cache";
import { dbFood, searchFoods } from "@/lib/food-db";
import type { FoodRefFailureReason } from "@/lib/log-client";
import { resetFoodRefCache } from "@/lib/log-client";
import { resetTestAccount } from "@/tests/helpers/account";

const CATALOG_REF = "cccccccc-3333-4333-8333-333333333333";

const ref = vi.hoisted(() => ({
  resolve: null as null | ((value: string | null) => void),
  reason: null as null | "signed_out" | "rpc_error",
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock("@/components/FavoritesStrip", () => ({
  default: ({ onPick }: { onPick: (row: unknown) => void }) => (
    <>
      <button type="button" onClick={() => onPick({ kind: "meal", id: "m1", name: "Taco night", sort: 1 })}>
        Taco night
      </button>
      <button type="button" onClick={() => onPick({ kind: "food", id: "f1", name: "Skyr", sort: 2 })}>
        Skyr
      </button>
    </>
  ),
}));
vi.mock("@/components/Sheet", () => ({
  default: ({ children, footer, title }: { children: React.ReactNode; footer: React.ReactNode; title: string }) =>
    <div><h1>{title}</h1>{children}{footer}</div>,
  Pill: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) =>
    <button type="button" onClick={onClick}>{children}</button>,
}));
vi.mock("@/components/CatalogSearch", () => ({
  default: ({ onPick }: { onPick: (row: unknown) => void }) => (
    <button type="button" onClick={() => onPick({ brand: null, sourceTile: "USDA", prefStatus: null,
      qualityFlags: [], offPlan: [], score: 1, key: "c7", catalogFoodId: 7, revisionId: 910,
      description: "Bread", offline: false })}>Catalog bread</button>
  ),
}));
vi.mock("@/lib/catalog-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/catalog-client")>();
  return { ...actual, getFoodDetail: vi.fn(async () => ({ kind: "cached", revision: REVISION })) };
});
vi.mock("@/lib/log-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/log-client")>();
  return {
    ...actual,
    resolveFoodRef: vi.fn((_id: number, onFailure?: (reason: FoodRefFailureReason) => void) =>
      new Promise<string | null>((resolve) => {
        ref.resolve = (value) => {
          if (value === null && ref.reason) onFailure?.(ref.reason);
          resolve(value);
        };
      })),
  };
});

const REVISION = {
  revision_id: 910, catalog_food_id: 7, description: "Bread", brand: null,
  source: "fdc_branded", version_label: "v1",
  per_100g: { energy_kcal: 265, protein: 9, carbohydrate: 49, fat_total: 3.2 }, portions: [],
  cached_at: "2026-11-02T17:00:00.000Z",
} as unknown as CachedRevision;

let savedFlag: string | undefined;

beforeEach(async () => {
  await resetTestAccount();
  resetFoodRefCache();
  ref.resolve = null;
  ref.reason = null;
  savedFlag = process.env.NEXT_PUBLIC_CATALOG_SEARCH;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  if (savedFlag === undefined) delete process.env.NEXT_PUBLIC_CATALOG_SEARCH;
  else process.env.NEXT_PUBLIC_CATALOG_SEARCH = savedFlag;
});

async function sheet() {
  const { default: LogFoodSheet } = await import("@/components/LogFoodSheet");
  render(<LogFoodSheet mode="food" mine={{}} slot="meal-1" onAdd={vi.fn()}
    onSomethingElse={() => {}} onClose={() => {}} onCapture={() => {}} />);
}

describe("catalog pick while its food is resolving", () => {
  it("says it is getting ready, then nothing once the food is ready", async () => {
    process.env.NEXT_PUBLIC_CATALOG_SEARCH = "1";
    await sheet();
    fireEvent.click(screen.getByRole("button", { name: "Catalog bread" }));
    expect(await screen.findByText("Getting this food ready…")).toBeTruthy();
    expect(screen.queryByText("Sign in to log from the catalog.")).toBeNull();
    await act(async () => ref.resolve?.(CATALOG_REF));
    expect(screen.queryByText("Getting this food ready…")).toBeNull();
    expect(screen.queryByText("Sign in to log from the catalog.")).toBeNull();
  });

  it("asks to sign in only when the resolve says signed out", async () => {
    process.env.NEXT_PUBLIC_CATALOG_SEARCH = "1";
    ref.reason = "signed_out";
    await sheet();
    fireEvent.click(screen.getByRole("button", { name: "Catalog bread" }));
    await screen.findByText("Getting this food ready…");
    await act(async () => ref.resolve?.(null));
    expect(screen.getByText("Sign in to log from the catalog.")).toBeTruthy();
  });
});

describe("favorite chips that cannot open a food here", () => {
  it("says why for a saved meal and for a food not opened on this phone", async () => {
    process.env.NEXT_PUBLIC_CATALOG_SEARCH = "1";
    await sheet();
    fireEvent.click(screen.getByRole("button", { name: "Taco night" }));
    expect(screen.getByText(/Saved meals are offered in each meal's swap list/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Skyr" }));
    expect(screen.getByText(/Search for Skyr once on this phone/)).toBeTruthy();
  });
});

describe("bundled food Add button", () => {
  it("leaves the long USDA portion label to the serving pill", async () => {
    delete process.env.NEXT_PUBLIC_CATALOG_SEARCH;
    await sheet();
    const hit = searchFoods("chicken breast roasted").find((h) => h.source === "db")!;
    fireEvent.change(screen.getByRole("searchbox", { name: "Search foods" }),
      { target: { value: "chicken breast roasted" } });
    const name = dbFood(hit.id)!.name;
    fireEvent.click(screen.getAllByRole("button").find((b) => b.textContent?.includes(name))!);
    const add = screen.getAllByRole("button").find((b) => /^Add · /.test(b.textContent ?? ""))!;
    expect(add.textContent).toMatch(/^Add · \d+ calories\d+kcal$/);
    expect(add.textContent).not.toContain("×");
  });
});
