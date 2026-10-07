// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Food } from "@/lib/foods";
import { dbFood, searchFoods as searchBundledFoods } from "@/lib/food-db";

const { adopt, search, catalogAdd, accountState } = vi.hoisted(() => ({
  adopt: vi.fn(), search: vi.fn(), catalogAdd: vi.fn(), accountState: { current: true },
}));

vi.mock("@/components/Sheet", () => ({
  default: ({ children, footer, title }: { children: React.ReactNode; footer: React.ReactNode; title: string }) =>
    <div><h1>{title}</h1>{children}{footer}</div>,
  Pill: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
}));
vi.mock("@/lib/catalog-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/catalog-client")>();
  return {
    ...actual,
    createSearchController: () => ({
      search,
      cancel: () => undefined,
    }),
  };
});
vi.mock("@/lib/foods/adopt-client", () => ({
  adoptBundledFood: adopt,
  bundledFoodUserId: async (id: string) => `adopted-${id}`,
}));
vi.mock("@/lib/device/account", () => ({
  accountHandle: () => ({ userId: "owner", epoch: 1 }),
  currentAccountOrNull: () => ({ userId: "owner", epoch: 1 }),
  isCurrent: () => accountState.current,
  assertCurrent: () => undefined,
  onAccountGone: () => () => undefined,
}));
vi.mock("@/components/add-food/catalog-food", () => ({ addCatalogFood: catalogAdd }));

import AddFoodSheet from "@/components/AddFoodSheet";

afterEach(() => { cleanup(); vi.clearAllMocks(); accountState.current = true; });

it("shows a bean bundled fallback and re-adds it without overwriting prior metadata", async () => {
  const bean = searchBundledFoods("bean").find((hit) => hit.source === "db");
  expect(bean).toBeDefined();
  const source = dbFood(bean!.id)!;
  const prior: Food = {
    id: `adopted-${bean!.id}`, name: source.name, role: "carb", unit: "g",
    perUnit: { protein: 1, carbs: 2, fat: 3 }, status: "neutral",
    note: "Good with rice", updatedAt: "2026-01-01T00:00:00.000Z",
  };
  search.mockResolvedValue({ kind: "offline", reason: "no_match", hits: searchBundledFoods("bean") });
  adopt.mockResolvedValue({ foodRefId: "ref", per100g: {} });
  const onAdd = vi.fn();
  render(<AddFoodSheet existing={{ [prior.id]: prior }} onAdd={onAdd} onClose={() => undefined} />);
  fireEvent.change(screen.getByRole("searchbox", { name: "Search foods" }), { target: { value: "bean" } });
  const result = await screen.findByRole("button", { name: new RegExp(source.name, "i") });
  // The bundled row carries the shared source tag and states one serving (U8).
  expect(result.textContent).toContain("USDA");
  expect(result.textContent).toMatch(/\d+ kcal/);
  fireEvent.click(result);
  await waitFor(() => expect(onAdd).toHaveBeenCalledOnce());
  expect(adopt).not.toHaveBeenCalled();
  expect(onAdd.mock.calls[0][0]).toMatchObject({
    id: prior.id, status: "eats", note: prior.note, role: prior.role, perUnit: prior.perUnit,
  });
});

it("adopts a new built-in bean before adding it to Avoid", async () => {
  const bean = searchBundledFoods("bean").find((hit) => hit.source === "db")!;
  search.mockResolvedValue({ kind: "offline", reason: "no_match", hits: [bean] });
  adopt.mockResolvedValue({ foodRefId: "ref", per100g: {} });
  const onAdd = vi.fn();
  render(<AddFoodSheet existing={{}} targetStatus="avoid" onAdd={onAdd} onClose={() => undefined} />);
  fireEvent.change(screen.getByRole("searchbox", { name: "Search foods" }), { target: { value: "bean" } });
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(dbFood(bean.id)!.name, "i") }));
  await waitFor(() => expect(onAdd).toHaveBeenCalledOnce());
  expect(adopt).toHaveBeenCalledWith(bean.id, { account: { userId: "owner", epoch: 1 } });
  expect(onAdd.mock.calls[0][0]).toMatchObject({ status: "avoid", id: `adopted-${bean.id}` });
});

it("shows an actionable search failure instead of Nothing matches", async () => {
  search.mockRejectedValue(new Error("network failed"));
  render(<AddFoodSheet existing={{}} onAdd={() => undefined} onClose={() => undefined} />);
  fireEvent.change(screen.getByRole("searchbox", { name: "Search foods" }), { target: { value: "bean" } });
  expect(await screen.findByRole("alert")).toHaveProperty("textContent",
    "Search could not finish. Try again or use Something else below.");
  expect(screen.queryByText(/Nothing matches/)).toBeNull();
});

it("does not paint a previous account's late search result", async () => {
  let settle!: (result: unknown) => void;
  search.mockReturnValue(new Promise((resolve) => { settle = resolve; }));
  render(<AddFoodSheet existing={{}} onAdd={() => undefined} onClose={() => undefined} />);
  fireEvent.change(screen.getByRole("searchbox", { name: "Search foods" }), { target: { value: "bean" } });
  await waitFor(() => expect(search).toHaveBeenCalledOnce());
  accountState.current = false;
  settle({ kind: "offline", reason: "no_match", hits: searchBundledFoods("bean") });
  await waitFor(() => expect(screen.queryByText(/\d+ kcal/)).toBeNull());
});

it("passes Avoid as the first catalog membership target", async () => {
  search.mockResolvedValue({ kind: "online", hits: [{
    catalogFoodId: 7, revisionId: 11, description: "White rice", brand: null,
    source: "fdc_sr_legacy", qualityFlags: [], prefStatus: null, score: 100,
  }], queryClass: "generic", autoResolve: null, catalogVersion: "v1" });
  catalogAdd.mockResolvedValue({ id: "rice", name: "White rice", role: "carb", unit: "g",
    perUnit: { protein: 0.1, carbs: 0.3, fat: 0 }, status: "avoid", updatedAt: "now" });
  const onAdd = vi.fn();
  render(<AddFoodSheet existing={{}} targetStatus="avoid" onAdd={onAdd} onClose={() => undefined} />);
  fireEvent.change(screen.getByRole("searchbox", { name: "Search foods" }), { target: { value: "rice" } });
  fireEvent.click(await screen.findByRole("button", { name: /White rice/i }));
  await waitFor(() => expect(onAdd).toHaveBeenCalledOnce());
  expect(catalogAdd).toHaveBeenCalledWith(7, 11, "avoid");
  expect(onAdd.mock.calls[0][0].status).toBe("avoid");
});

it("requires a second deliberate tap before restoring an avoided food to Eats", async () => {
  const bean = searchBundledFoods("bean").find((hit) => hit.source === "db")!;
  const source = dbFood(bean.id)!;
  const prior: Food = { id: `adopted-${bean.id}`, name: source.name, role: "carb", unit: "g",
    perUnit: { protein: 1, carbs: 2, fat: 0 }, status: "avoid", note: "hurt",
    updatedAt: "2026-01-01T00:00:00.000Z" };
  search.mockResolvedValue({ kind: "offline", reason: "no_match", hits: [bean] });
  adopt.mockResolvedValue({ foodRefId: "ref", per100g: {} });
  const onAdd = vi.fn();
  render(<AddFoodSheet existing={{ [prior.id]: prior }} onAdd={onAdd} onClose={() => undefined} />);
  fireEvent.change(screen.getByRole("searchbox", { name: "Search foods" }), { target: { value: "bean" } });
  const row = await screen.findByRole("button", { name: new RegExp(source.name, "i") });
  fireEvent.click(row);
  expect(screen.getByText(/This food is on Avoid/)).toBeTruthy();
  expect(adopt).not.toHaveBeenCalled();
  fireEvent.click(row);
  await waitFor(() => expect(onAdd).toHaveBeenCalledOnce());
  expect(onAdd.mock.calls[0][0]).toMatchObject({ status: "eats", note: "hurt" });
});
