// @vitest-environment jsdom
// UI audit 2026-10-18 §4 (Shopping list and planner): the fixes, held.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { unbindAccount } from "@/lib/device/account";
import ShoppingView from "@/components/ShoppingView";
import ShoppingList from "@/components/ShoppingList";
import ShoppingPreview from "@/components/ShoppingPreview";
import { defaultShoppingDraft, draftProblem } from "@/components/ShoppingControls";
import { MAX_QUICK_ITEMS, planQuickAdd } from "@/lib/shopping/quick-add";
import { currentWindowChecked, formatMoney, mealLabel, shoppingDate } from "@/lib/shopping/labels";
import type { ShoppingLine, ShoppingPeriod, ShoppingPurchaseWindow } from "@/lib/shopping/types";

const draft = defaultShoppingDraft("2026-09-27", "America/Denver");
const period: ShoppingPeriod = { id: "p1", userId: "u1", ...draft, planRevision: 1, revision: 1 };
function line(over: Partial<ShoppingLine> = {}): ShoppingLine {
  return { id: "l1", periodId: "p1", origin: "plan", name: "Beans",
    identity: { foodRefId: "f1", catalogFoodRevisionId: 1, purchaseState: "raw", variantKey: "plain" },
    category: "core", needGrams: 500, confirmedStockGrams: null, buyGrams: 500,
    packageGrams: null, purchaseConversionStatus: "known", sources: [{ localDate: "2026-09-28",
      slotId: "dinner", recipeId: "r1", recipeRevisionId: "v1", ingredientSeq: 1,
      batchId: null, requiredGrams: 500 }], pinned: false, checked: false, note: null, revision: 1, ...over };
}
function week(over: Partial<ShoppingPurchaseWindow> = {}): ShoppingPurchaseWindow {
  return { id: "w1", periodId: "p1", lineId: "l1", windowStartDate: "2026-09-27", windowEndDate: "2026-10-03",
    needGrams: 500, confirmedStockGrams: null, buyGrams: 500, checked: false, note: null, revision: 1, ...over };
}
const viewActions = () => ({ preview: vi.fn(), patchLine: vi.fn().mockResolvedValue(undefined),
  confirmPantry: vi.fn().mockResolvedValue(undefined), addItems: vi.fn().mockResolvedValue(undefined),
  removeLine: vi.fn().mockResolvedValue(undefined), removePantry: vi.fn().mockResolvedValue(undefined),
  refresh: vi.fn().mockResolvedValue(undefined) });
const listActions = () => ({ addItems: vi.fn().mockResolvedValue(undefined),
  setChecked: vi.fn().mockResolvedValue(undefined), removeLine: vi.fn().mockResolvedValue(undefined),
  patchLine: vi.fn().mockResolvedValue(undefined), confirmPantry: vi.fn().mockResolvedValue(undefined) });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); unbindAccount(); });
const openPlan = () => fireEvent.click(screen.getByRole("button", { name: /plan meals/i }));

describe("quick add", () => {
  it("keeps what one add cannot take, and counts names already listed", () => {
    const names = Array.from({ length: 25 }, (_, index) => `item ${index + 1}`);
    const plan = planQuickAdd(["beans", ...names].join(", "), [line()]);
    expect(plan.items).toHaveLength(MAX_QUICK_ITEMS);
    expect(plan.rest).toBe("item 21, item 22, item 23, item 24, item 25");
    expect(plan.duplicates).toBe(1);
  });

  it("puts the unsent items back in the field and says so", async () => {
    const actions = listActions();
    render(<ShoppingList title="This week" lines={[]} favorites={[]} actions={actions} />);
    const field = screen.getByLabelText("Add items") as HTMLInputElement;
    fireEvent.change(field, { target: { value: Array.from({ length: 22 }, (_, index) => `food ${index}`).join(", ") } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText("20 items added; 2 more left in the box.")).toBeTruthy();
    expect(actions.addItems.mock.calls[0][0]).toHaveLength(20);
    expect(field.value).toBe("food 20, food 21");
  });

  it("says why Add is off when every name is already on the list", () => {
    render(<ShoppingList title="This week" lines={[line({ origin: "manual", category: "manual" })]}
      favorites={[]} actions={listActions()} />);
    fireEvent.change(screen.getByLabelText("Add items"), { target: { value: "beans" } });
    expect((screen.getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Already on your list.")).toBeTruthy();
  });
});

describe("ticks", () => {
  it("sends a quick untick after the tick lands, on the saved revision", async () => {
    let finish!: (value: ShoppingLine) => void;
    const actions = listActions();
    actions.setChecked.mockImplementationOnce(() => new Promise<ShoppingLine>((resolve) => { finish = resolve; }));
    render(<ShoppingList title="This week" lines={[line()]} favorites={[]} actions={actions} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /Beans, to buy/ }));
    fireEvent.click(screen.getByRole("button", { name: /In cart/ }));
    fireEvent.click(await screen.findByRole("checkbox", { name: /Beans, in cart/ }));
    expect(actions.setChecked).toHaveBeenCalledTimes(1);
    await act(async () => { finish(line({ checked: true, revision: 2 })); });
    await waitFor(() => expect(actions.setChecked).toHaveBeenCalledTimes(2));
    expect(actions.setChecked.mock.calls[1][0].revision).toBe(2);
    expect(actions.setChecked.mock.calls[1][1]).toBe(false);
    expect(screen.queryByText(/changed elsewhere/)).toBeNull();
  });
});

describe("monthly lists", () => {
  const month = { ...period, endDate: "2026-10-26" };
  it("shows plan rows as ticked by week, and counts a ticked week as in the cart", () => {
    render(<ShoppingView period={month} initialDraft={draft} lines={[line()]}
      purchaseWindows={[week({ checked: true })]}
      actions={{ ...viewActions(), patchWindow: vi.fn().mockResolvedValue(undefined) }} />);
    expect(screen.queryByRole("checkbox", { name: /Beans, / })).toBeNull();
    expect(screen.getByText(/1 of 1 in cart/)).toBeTruthy();
    expect(screen.getByText(/Bought this week ·/)).toBeTruthy();
  });

  it("reads the week covering today, else the latest started, else the first", () => {
    const rows = [week({ checked: true }),
      week({ id: "w2", windowStartDate: "2026-10-04", windowEndDate: "2026-10-10", checked: false })];
    expect(currentWindowChecked("l1", rows, "2026-09-29")).toBe(true);
    expect(currentWindowChecked("l1", rows, "2026-10-05")).toBe(false);
    expect(currentWindowChecked("l1", rows, "2026-09-01")).toBe(true);
    expect(currentWindowChecked("other", rows, "2026-09-29")).toBeNull();
  });
});

describe("planner", () => {
  it("names why Preview is off, and lets People be cleared to retype", () => {
    render(<ShoppingView period={period} lines={[line()]} initialDraft={draft} actions={viewActions()} />);
    openPlan();
    const people = screen.getByLabelText("People") as HTMLInputElement;
    fireEvent.change(people, { target: { value: "" } });
    expect(people.value).toBe("");
    expect(screen.getByText("People must be 1 or more.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Preview changes" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(people, { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Dinner" }));
    expect(screen.getByText("Pick at least one meal.")).toBeTruthy();
  });

  it("says when the dates are the wrong way round", () => {
    expect(draftProblem({ ...draft, endDate: "2026-09-01" })).toBe("Through must be on or after From.");
    expect(draftProblem({ ...draft, mealCoverage: [] }, { needMeals: false })).toBeNull();
  });

  it("brings the preview into view once it is ready", async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const actions = viewActions();
    actions.preview.mockResolvedValue({ period, lines: [], issues: [], unmetPins: [], accept: vi.fn() });
    render(<ShoppingView period={period} lines={[line()]} initialDraft={draft} actions={actions} />);
    openPlan();
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(await screen.findByRole("region", { name: "Plan and shopping preview" })).toBeTruthy();
    await waitFor(() => expect(scroll).toHaveBeenCalled());
  });

  it("confirms an accepted plan", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const actions = viewActions();
    actions.preview.mockResolvedValue({ period, lines: [line()], issues: [], unmetPins: [],
      accept: vi.fn().mockResolvedValue(undefined) });
    render(<ShoppingView period={period} lines={[line()]} initialDraft={draft} actions={actions} />);
    openPlan();
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    fireEvent.click(await screen.findByRole("button", { name: "Accept plan and list" }));
    expect(await screen.findByText("Plan accepted. List updated.")).toBeTruthy();
  });

  it("removes a pantry item without touching the preview button, one tap at a time", async () => {
    let finish!: () => void;
    const actions = viewActions();
    actions.removePantry.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const item = { id: "pan1", name: "Rice", identity: line().identity!, confirmedGrams: 200, revision: 1 };
    render(<ShoppingView period={period} lines={[line()]} initialDraft={draft} actions={actions}
      pantry={[item as never]} />);
    fireEvent.click(screen.getByRole("button", { name: /Have already/ }));
    const remove = screen.getByRole("button", { name: "Remove Rice from Have already" }) as HTMLButtonElement;
    fireEvent.click(remove);
    fireEvent.click(remove);
    expect(actions.removePantry).toHaveBeenCalledTimes(1);
    expect(remove.disabled).toBe(true);
    openPlan();
    expect(screen.getByRole("button", { name: "Preview changes" })).toBeTruthy();
    await act(async () => { finish(); });
  });
});

describe("words and dates", () => {
  it("formats dates, meals and money one way", () => {
    expect(shoppingDate("2026-10-18")).toMatch(/^18 Oct/);
    expect(mealLabel("meal-2")).toBe("Meal 2");
    expect(mealLabel("late_snack")).toBe("Late Snack");
    expect(formatMoney(42.5, "USD")).toBe("$42.50");
  });

  it("shows a preview's dates and slots readably, with money and plain blockers", () => {
    render(<ShoppingPreview current={[]} preview={{ period, lines: [], issues: [], unmetPins: [],
      blockingIssues: ["Beans: a note would change."],
      choices: [{ localDate: "2026-09-28", slotId: "dinner", recipeName: "Chili", servingFraction: 1 } as never],
      price: { estimatedCheckoutAmount: 42.5, currency: "USD", pricedLines: 0, requiredLines: 0, budgetMet: null } as never,
      accept: vi.fn() }} onAccepted={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText(/Fix these before accepting/)).toBeTruthy();
    expect(screen.getByText(new RegExp(`${shoppingDate("2026-09-28")} · Dinner: Chili`))).toBeTruthy();
    expect(screen.getByText(/Estimated total: \$42\.50/)).toBeTruthy();
  });

  it("names the line's group as the list does", () => {
    render(<ShoppingList title="This week" lines={[line({ category: "pantry_top_up" })]} favorites={[]}
      actions={listActions()} />);
    fireEvent.click(screen.getByRole("button", { name: "Details for Beans" }));
    expect(screen.getAllByText("Pantry top-ups").length).toBeGreaterThan(1);
    expect(screen.queryByText("pantry top up")).toBeNull();
  });
});
