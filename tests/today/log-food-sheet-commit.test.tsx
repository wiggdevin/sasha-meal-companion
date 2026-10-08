// @vitest-environment jsdom
/**
 * Calc audit #15, the UI half: every pick the log sheet makes — catalog, bundled food-db or the
 * account's own food — and every "Log a meal" goes down the one durable commit path exactly once.
 * A pick that cannot be sent keeps today's local card, says so, and never commits. Never both:
 * that would count one food twice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CachedRevision } from "@/lib/db/catalog-cache";
import { unbindAccount } from "@/lib/device/account";
import { dbFood, searchFoods } from "@/lib/food-db";
import type { Food } from "@/lib/foods";
import type { LogCommitRequest } from "@/lib/log/contract";
import { resetFoodRefCache } from "@/lib/log-client";
import type { LoggedFood } from "@/lib/types";
import { resetTestAccount } from "@/tests/helpers/account";

const CATALOG_REF = "cccccccc-3333-4333-8333-333333333333";
const MINTED_REF = "dddddddd-0000-4000-8000-000000000001";

const spies = vi.hoisted(() => ({
  commit: vi.fn(),
  reconciled: [] as LoggedFood[],
  adopt: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock("@/components/FavoritesStrip", () => ({ default: () => null }));
vi.mock("@/components/Sheet", () => ({
  default: ({ children, footer, title }: { children: React.ReactNode; footer: React.ReactNode; title: string }) =>
    <div><h1>{title}</h1>{children}{footer}</div>,
  Pill: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) =>
    <button type="button" onClick={onClick}>{children}</button>,
}));
// The catalog search UI is not under test: its rows are buttons that hand the sheet a row — a
// catalog food, and the offline tier's bundled and own-list rows, as CatalogSearch does.
vi.mock("@/components/CatalogSearch", () => {
  const row = { brand: null, sourceTile: "USDA", prefStatus: null, qualityFlags: [], offPlan: [], score: 1 };
  return {
    default: ({ onPick }: { onPick: (row: unknown) => void }) => (
      <>
        <button type="button" onClick={() => onPick({ ...row, key: "c7", catalogFoodId: 7,
          revisionId: 910, description: "Bread", offline: false })}>Catalog bread</button>
        <button type="button" onClick={() => onPick({ ...row, key: "b", catalogFoodId: null,
          revisionId: null, description: "Chicken", offline: true, offlineFoodId: CHICKEN_ID,
          offlineSource: "db" })}>Offline chicken</button>
        <button type="button" onClick={() => onPick({ ...row, key: "m", catalogFoodId: null,
          revisionId: null, description: "Oats", offline: true, offlineFoodId: "oats-own",
          offlineSource: "mine" })}>Own oats</button>
      </>
    ),
  };
});
vi.mock("@/lib/catalog-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/catalog-client")>();
  return { ...actual, getFoodDetail: vi.fn(async () => ({ kind: "cached", revision: REVISION })) };
});
vi.mock("@/lib/log-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/log-client")>();
  return { ...actual, resolveFoodRef: vi.fn(async () => CATALOG_REF) };
});
vi.mock("@/lib/log-commit-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/log-commit-client")>();
  return {
    ...actual,
    commitLogEntry: spies.commit,
    // The card as the store holds it after reconcile: a new object, so the test can tell it apart.
    committedEntry: (_date: string, fallback: LoggedFood) => {
      const card = { ...fallback };
      spies.reconciled.push(card);
      return card;
    },
  };
});
vi.mock("@/lib/foods/adopt-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/foods/adopt-client")>();
  return { ...actual, adoptUserFood: spies.adopt };
});

const REVISION = {
  revision_id: 910, catalog_food_id: 7, description: "Bread", brand: null,
  source: "fdc_branded", version_label: "v1",
  per_100g: { energy_kcal: 265, protein: 9, carbohydrate: 49, fat_total: 3.2 }, portions: [],
  cached_at: "2026-11-02T17:00:00.000Z",
} as unknown as CachedRevision;

const OATS: Food = {
  id: "oats-own", name: "Oatmeal, cooked", role: "carb", unit: "oz",
  perUnit: { protein: 0.7, carbs: 3.4, fat: 0.4 }, status: "eats", updatedAt: "2026-11-01T00:00:00.000Z",
};
/** A unit with no known weight: committed as a count with its mass unknown (t17 gap 1). */
const STEW: Food = {
  id: "stew-own", name: "Grandma stew", role: "protein", unit: "cup",
  perUnit: { protein: 20, carbs: 15, fat: 8 }, status: "eats", updatedAt: "2026-11-01T00:00:00.000Z",
};
const MINE = { [OATS.id]: OATS, [STEW.id]: STEW };

const CHICKEN = searchFoods("chicken breast roasted").find((h) => h.source === "db")!;
const CHICKEN_ID = CHICKEN.id;

let savedFlag: string | undefined;

beforeEach(async () => {
  await resetTestAccount();
  resetFoodRefCache();
  savedFlag = process.env.NEXT_PUBLIC_CATALOG_SEARCH;
  delete process.env.NEXT_PUBLIC_CATALOG_SEARCH;
  spies.reconciled.length = 0;
  spies.adopt.mockImplementation(async () => MINTED_REF);
  spies.commit.mockImplementation(async () => ({ status: "queued" }));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  if (savedFlag === undefined) delete process.env.NEXT_PUBLIC_CATALOG_SEARCH;
  else process.env.NEXT_PUBLIC_CATALOG_SEARCH = savedFlag;
});

async function sheet(mode: "food" | "meal" = "food") {
  const { default: LogFoodSheet } = await import("@/components/LogFoodSheet");
  const onAdd = vi.fn();
  render(<LogFoodSheet mode={mode} mine={MINE} slot="meal-1" onAdd={onAdd}
    onSomethingElse={() => {}} onClose={() => {}} onCapture={() => {}} />);
  return onAdd;
}

/** Search the bundled list and open a row by its exact name. */
function openFood(query: string, name: string) {
  if (screen.queryByRole("button", { name: "Add a food to this meal" })) {
    fireEvent.click(screen.getByRole("button", { name: "Add a food to this meal" }));
  }
  fireEvent.change(screen.getByRole("searchbox", { name: "Search foods" }), { target: { value: query } });
  const row = screen.getAllByRole("button").find((b) => b.textContent?.includes(name));
  expect(row, name).toBeTruthy();
  fireEvent.click(row!);
}

const addButton = () => screen.getAllByRole("button").find((b) => /^(Add|Add to meal) · /.test(b.textContent ?? ""))!;

function commitCall(n = 0): { req: LogCommitRequest; opts: { optimistic: { date: string; entry: LoggedFood } } } {
  const [req, opts] = spies.commit.mock.calls[n];
  return { req, opts };
}

describe("a single pick", () => {
  it("scales grams typed by hand with the count, so the stepper never moves alone (UI audit r1)", async () => {
    process.env.NEXT_PUBLIC_CATALOG_SEARCH = "1";
    await sheet();
    fireEvent.click(screen.getByRole("button", { name: "Catalog bread" }));
    const grams = await screen.findByRole("textbox", { name: "Grams" }) as HTMLInputElement;
    fireEvent.change(grams, { target: { value: "150" } });
    for (let i = 0; i < 4; i += 1) fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(grams.value).toBe("300");
  });

  it("commits a bundled food once and hands Today the committed card once", async () => {
    const onAdd = await sheet();
    openFood("chicken breast roasted", dbFood(CHICKEN.id)!.name);
    fireEvent.click(addButton());
    await waitFor(() => expect(onAdd).toHaveBeenCalledOnce());
    expect(spies.commit).toHaveBeenCalledOnce();
    const { req, opts } = commitCall();
    expect(req.items).toHaveLength(1);
    expect(req.items[0].food_ref_id).toBe(MINTED_REF);
    expect(opts.optimistic.entry.id).toBe(req.entry_id);
    expect(onAdd.mock.calls[0]).toEqual([spies.reconciled[0], req.local_date]);
    expect(onAdd.mock.calls[0][0].id).toBe(req.entry_id);
  });

  it("says once that a save's nutrition was not fully checked, and nothing more otherwise", async () => {
    spies.commit.mockImplementationOnce(async (req: LogCommitRequest) => ({ status: "ok", entry_id: req.entry_id,
      rev: 1, items: [], totals: {}, nutrition_unchecked: true }));
    const onAdd = await sheet();
    openFood("chicken breast roasted", dbFood(CHICKEN.id)!.name);
    fireEvent.click(addButton());
    await waitFor(() => expect(onAdd).toHaveBeenCalledOnce());
    expect(onAdd.mock.calls[0][3]).toBe("Saved. Nutrition not fully checked.");
    // The card itself carries nothing of it: the line is said once, never stored.
    expect(JSON.stringify(onAdd.mock.calls[0][0])).not.toContain("unchecked");
  });

  it("commits an account food once, counted in its own unit", async () => {
    const onAdd = await sheet();
    openFood("oatmeal", OATS.name);
    fireEvent.click(addButton());
    await waitFor(() => expect(onAdd).toHaveBeenCalledOnce());
    expect(spies.commit).toHaveBeenCalledOnce();
    const { req } = commitCall();
    expect(req.items).toMatchObject([{ food_ref_id: MINTED_REF, qty: 1, unit: "oz" }]);
    expect(onAdd.mock.calls[0]).toEqual([spies.reconciled[0], req.local_date]);
  });

  it("commits a catalog food once through the same path", async () => {
    process.env.NEXT_PUBLIC_CATALOG_SEARCH = "1";
    const onAdd = await sheet();
    fireEvent.click(screen.getByRole("button", { name: "Catalog bread" }));
    const logIt = await screen.findByRole("button", { name: /^Log it · / });
    await waitFor(() => expect((logIt as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(logIt);
    await waitFor(() => expect(onAdd).toHaveBeenCalledOnce());
    expect(spies.commit).toHaveBeenCalledOnce();
    const { req } = commitCall();
    expect(req.items).toMatchObject([{ food_ref_id: CATALOG_REF, food_revision_id: 910 }]);
    expect(spies.adopt).not.toHaveBeenCalled();
    expect(onAdd.mock.calls[0]).toEqual([spies.reconciled[0], req.local_date]);
  });

  it("commits a food with no known weight once, as a count with an unknown mass (t17)", async () => {
    const onAdd = await sheet();
    openFood("grandma stew", STEW.name);
    fireEvent.click(addButton());
    await waitFor(() => expect(onAdd).toHaveBeenCalledOnce());
    expect(spies.commit).toHaveBeenCalledOnce();
    const { req } = commitCall();
    // No invented grams: the mass is null and the entered per-cup macros ride as per_unit.
    expect(req.items).toMatchObject([{ food_ref_id: MINTED_REF, qty: 1, unit: "cup", grams: null,
      per_unit: { energy_kcal: 212, protein: 20, carbohydrate: 15, fat_total: 8 } }]);
    const [entry, date] = onAdd.mock.calls[0];
    expect(entry).toMatchObject({ foodId: STEW.id, qty: 1, massUnknown: true,
      macros: { kcal: 212, protein: 20, carbs: 15, fat: 8 } });
    expect(entry.items[0].grams).toBeNull();
    expect(date).toBe(req.local_date);
  });

  it("shows the account's own count for a food with no known weight, never 0 g, marked partial (t17)", async () => {
    const { default: LogFoodSheet } = await import("@/components/LogFoodSheet");
    const { container } = render(<LogFoodSheet mode="food" mine={MINE} slot="meal-1" onAdd={() => {}}
      onSomethingElse={() => {}} onClose={() => {}} onCapture={() => {}} />);
    openFood("grandma stew", STEW.name);
    expect(container.textContent).not.toContain("0 g");
    expect(container.textContent).toContain("1 × 1 cup");
    expect(container.querySelector("[data-partial]")).toBeTruthy();
  });

  it("keeps a signed-out pick on the local path once and never commits", async () => {
    const onAdd = await sheet();
    openFood("chicken breast roasted", dbFood(CHICKEN.id)!.name);
    unbindAccount();
    fireEvent.click(addButton());
    await waitFor(() => expect(onAdd).toHaveBeenCalledOnce());
    expect(spies.commit).not.toHaveBeenCalled();
    expect(onAdd.mock.calls[0][2]).toBe("Saved on this phone only. It could not reach your account.");
  });
});

describe("no double count", () => {
  it("sends one commit for a double tap while the first is in flight", async () => {
    let answer: (value: unknown) => void = () => {};
    spies.commit.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    const onAdd = await sheet();
    openFood("chicken breast roasted", dbFood(CHICKEN.id)!.name);
    const button = addButton();
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(spies.commit).toHaveBeenCalledOnce());
    fireEvent.click(addButton());
    await act(async () => { answer({ status: "queued" }); });
    await waitFor(() => expect(onAdd).toHaveBeenCalledOnce());
    expect(spies.commit).toHaveBeenCalledOnce();
  });

  it("adds nothing on a refusal, and a retry adds the one entry once", async () => {
    spies.commit.mockResolvedValueOnce({ status: "refused" });
    const onAdd = await sheet();
    openFood("oatmeal", OATS.name);
    fireEvent.click(addButton());
    await screen.findByText("The server would not take that one. Try again.");
    expect(onAdd).not.toHaveBeenCalled();
    fireEvent.click(addButton());
    await waitFor(() => expect(onAdd).toHaveBeenCalledOnce());
    expect(spies.commit).toHaveBeenCalledTimes(2);
    expect(onAdd.mock.calls[0][0].id).toBe(commitCall(1).req.entry_id);
  });
});

describe("Log a meal", () => {
  it("commits a meal of catalog, bundled and account picks as one entry, once", async () => {
    process.env.NEXT_PUBLIC_CATALOG_SEARCH = "1";
    const onAdd = await sheet("meal");
    fireEvent.click(screen.getByRole("button", { name: "Add a food to this meal" }));
    fireEvent.click(screen.getByRole("button", { name: "Catalog bread" }));
    const toMeal = await screen.findByRole("button", { name: /^Add to meal · / });
    await waitFor(() => expect((toMeal as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(toMeal);
    // The bundled and own-list rows come through the catalog search's offline tier.
    for (const name of ["Offline chicken", "Own oats"]) {
      fireEvent.click(screen.getByRole("button", { name: "Add a food to this meal" }));
      fireEvent.click(screen.getByRole("button", { name }));
      fireEvent.click(addButton());
    }
    fireEvent.change(screen.getByRole("textbox", { name: "Meal name" }), { target: { value: "Lunch" } });
    const save = screen.getByRole("button", { name: "Log this meal" });
    fireEvent.click(save);
    fireEvent.click(save);
    await waitFor(() => expect(onAdd).toHaveBeenCalledOnce());
    expect(spies.commit).toHaveBeenCalledOnce();
    const { req, opts } = commitCall();
    expect(req.items.map((i) => i.food_ref_id)).toEqual([CATALOG_REF, MINTED_REF, MINTED_REF]);
    expect(req.title).toBe("Lunch");
    expect(opts.optimistic.entry).toMatchObject({ id: req.entry_id, name: "Lunch", foodId: "meal" });
    expect(opts.optimistic.entry.items?.map((i) => i.id)).toEqual(req.items.map((i) => i.id));
    expect(onAdd.mock.calls[0]).toEqual([spies.reconciled[0], req.local_date]);
  });

  it.each([["Offline chicken"], ["Own oats"], ["Catalog bread"]])(
    "adds one pick for two taps on Add to meal before the view changes (%s)", async (row) => {
      process.env.NEXT_PUBLIC_CATALOG_SEARCH = "1";
      const onAdd = await sheet("meal");
      fireEvent.click(screen.getByRole("button", { name: "Add a food to this meal" }));
      fireEvent.click(screen.getByRole("button", { name: row }));
      const toMeal = await screen.findByRole("button", { name: /^Add to meal · / });
      await waitFor(() => expect((toMeal as HTMLButtonElement).disabled).toBe(false));
      // Both taps land on the same render: React has not switched the view yet.
      act(() => { toMeal.click(); toMeal.click(); });
      expect(screen.getAllByRole("button", { name: /^Remove / })).toHaveLength(1);
      fireEvent.click(screen.getByRole("button", { name: "Log this meal" }));
      await waitFor(() => expect(onAdd).toHaveBeenCalledOnce());
      expect(commitCall().req.items).toHaveLength(1);
    });

  it("can add the same food twice on purpose, one tap each", async () => {
    const onAdd = await sheet("meal");
    openFood("oatmeal", OATS.name);
    fireEvent.click(addButton());
    openFood("oatmeal", OATS.name);
    fireEvent.click(addButton());
    expect(screen.getAllByRole("button", { name: /^Remove / })).toHaveLength(2);
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("marks every line of a meal kept on this phone as never sent, catalog lines too", async () => {
    process.env.NEXT_PUBLIC_CATALOG_SEARCH = "1";
    const onAdd = await sheet("meal");
    fireEvent.click(screen.getByRole("button", { name: "Add a food to this meal" }));
    fireEvent.click(screen.getByRole("button", { name: "Catalog bread" }));
    const toMeal = await screen.findByRole("button", { name: /^Add to meal · / });
    await waitFor(() => expect((toMeal as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(toMeal);
    unbindAccount();
    fireEvent.click(screen.getByRole("button", { name: "Log this meal" }));
    await waitFor(() => expect(onAdd).toHaveBeenCalledOnce());
    expect(spies.commit).not.toHaveBeenCalled();
    const [entry, , notice] = onAdd.mock.calls[0] as [LoggedFood, string | undefined, string];
    expect(notice).toBe("Saved on this phone only. It could not reach your account.");
    // lib/log/delete-entry.ts `neverOnTheWire`: an Undo of this card owes the server nothing.
    expect(entry.items?.length).toBe(1);
    expect(entry.items?.every((i) => i.food_ref_id.startsWith("local:"))).toBe(true);
    expect(entry.localOnly).toBe(true);
  });

  it("commits a meal with a food of no known weight once, that item's mass unknown (t17)", async () => {
    const onAdd = await sheet("meal");
    openFood("oatmeal", OATS.name);
    fireEvent.click(addButton());
    openFood("grandma stew", STEW.name);
    fireEvent.click(addButton());
    fireEvent.click(screen.getByRole("button", { name: "Log this meal" }));
    await waitFor(() => expect(onAdd).toHaveBeenCalledOnce());
    expect(spies.commit).toHaveBeenCalledOnce();
    const { req } = commitCall();
    expect(req.items.map((i: { grams: number | null }) => i.grams === null)).toEqual([false, true]);
    const [entry] = onAdd.mock.calls[0];
    expect(entry).toMatchObject({ foodId: "meal", portionLabel: "2 items", massUnknown: true });
  });
});
