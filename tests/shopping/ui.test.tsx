// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { unbindAccount } from "@/lib/device/account";
import ShoppingView from "@/components/ShoppingView";
import ShoppingPreview from "@/components/ShoppingPreview";
import { defaultShoppingDraft } from "@/components/ShoppingControls";
import type { ShoppingLine, ShoppingPeriod } from "@/lib/shopping/types";

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
const actions = () => ({ preview: vi.fn(), patchLine: vi.fn().mockResolvedValue(undefined),
  confirmPantry: vi.fn().mockResolvedValue(undefined), addItems: vi.fn().mockResolvedValue(undefined),
  removeLine: vi.fn().mockResolvedValue(undefined), removePantry: vi.fn().mockResolvedValue(undefined),
  refresh: vi.fn().mockResolvedValue(undefined) });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); unbindAccount(); });

/** The planner controls sit in the shared Disclosure, closed while the list has lines. */
const openPlan = () => fireEvent.click(screen.getByRole("button", { name: /Re-plan meals and update this list/ }));

describe("shopping UI", () => {
  it("starts with a seven-day range and keeps effort, variety, and budget separate", () => {
    const a = actions();
    render(<ShoppingView period={period} lines={[line()]} initialDraft={draft} actions={a} />);
    openPlan();
    expect((screen.getByLabelText("From") as HTMLInputElement).value).toBe("2026-09-27");
    expect((screen.getByLabelText("Through") as HTMLInputElement).value).toBe("2026-10-03");
    fireEvent.click(screen.getByRole("button", { name: "Details for Beans" }));
    expect(screen.getByText("Need")).toBeTruthy();
    expect(screen.getByText("Buy")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Cooking effort" }).textContent).toContain("Standard");
    expect(screen.getByRole("combobox", { name: "List style" }).textContent).toContain("Balanced");
    expect(screen.getByRole("combobox", { name: "Variety" }).textContent).toContain("Balanced");
    expect((screen.getByLabelText("Budget (optional)") as HTMLInputElement).value).toBe("");
  });

  it("keeps area and currency optional even with a budget", async () => {
    const a = actions();
    a.preview.mockResolvedValue({ period, lines: [], issues: [], unmetPins: [], accept: vi.fn() });
    render(<ShoppingView period={null} lines={[]} initialDraft={draft} actions={a} />);
    fireEvent.change(screen.getByLabelText("Budget (optional)"), { target: { value: "40" } });
    expect((screen.getByRole("button", { name: "Preview plan and list changes" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Preview plan and list changes" }));
    await waitFor(() => expect(a.preview).toHaveBeenCalledWith({
      draft: { ...draft, budgetAmount: 40 }, basket: [],
    }));
    expect(screen.queryByLabelText("Currency")).toBeNull();
  });

  it("requests approximate browser location only after a direct tap", () => {
    const getCurrentPosition = vi.fn((success: PositionCallback) => success({
      coords: { latitude: 39.7392, longitude: -104.9903 },
    } as GeolocationPosition));
    Object.defineProperty(navigator, "geolocation", { configurable: true,
      value: { getCurrentPosition } });
    render(<ShoppingView period={null} lines={[]} initialDraft={draft} actions={actions()} />);
    expect(getCurrentPosition).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Use my location" }));
    expect(getCurrentPosition).toHaveBeenCalledOnce();
    expect((screen.getByLabelText("Shopping area (optional)") as HTMLInputElement).value)
      .toBe("Near 39.74, -104.99");
  });

  it("sets a rolling month without skipping short February", () => {
    const a = actions();
    const january = defaultShoppingDraft("2027-01-31", "America/Denver");
    render(<ShoppingView period={null} lines={[]} initialDraft={january} actions={a} />);
    fireEvent.click(screen.getByRole("button", { name: "Month" }));
    expect((screen.getByLabelText("Through") as HTMLInputElement).value).toBe("2027-02-27");
  });

  it("picks From in the app's date sheet and keeps the seven-day range", async () => {
    render(<ShoppingView period={null} lines={[]} initialDraft={draft} actions={actions()} />);
    fireEvent.click(screen.getByLabelText("From"));
    const sheet = screen.getByRole("dialog", { name: "From" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Next month" }));
    fireEvent.click(within(sheet).getByRole("button", { name: /^Thursday 1 October 2026/ }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(document.querySelector("[role=dialog]")).toBeNull());
    expect((screen.getByLabelText("From") as HTMLButtonElement).value).toBe("2026-10-01");
    expect((screen.getByLabelText("Through") as HTMLButtonElement).value).toBe("2026-10-07");
    expect(screen.getByLabelText("From").textContent).toBe("1 Oct 2026");
  });

  it("supports multi-select meals and keeps saved meal-slot coverage", async () => {
    const a = actions();
    a.preview.mockResolvedValue({ period, lines: [], issues: [], unmetPins: [], accept: vi.fn() });
    const savedDraft = { ...draft, mealCoverage: ["meal-3", "meal-5"] };
    render(<ShoppingView period={null} lines={[]} initialDraft={savedDraft} actions={a} />);
    expect((screen.getByRole("button", { name: "Dinner" }) as HTMLButtonElement).getAttribute("aria-pressed"))
      .toBe("true");
    expect((screen.getByRole("button", { name: "Meal 5" }) as HTMLButtonElement).getAttribute("aria-pressed"))
      .toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Breakfast" }));
    fireEvent.click(screen.getByRole("button", { name: "Snack" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview plan and list changes" }));
    await waitFor(() => expect(a.preview).toHaveBeenCalledWith({
      draft: { ...savedDraft, mealCoverage: ["meal-3", "meal-5", "breakfast", "snack"] }, basket: [],
    }));
  });

  it("allows no meal slots but disables preview until one is selected", () => {
    const a = actions();
    render(<ShoppingView period={null} lines={[]} initialDraft={{ ...draft, mealCoverage: ["dinner"] }} actions={a} />);
    fireEvent.click(screen.getByRole("button", { name: "Dinner" }));
    expect((screen.getByRole("button", { name: "Preview plan and list changes" }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect(a.preview).not.toHaveBeenCalled();
  });

  it("does not accept a preview before the explicit accept tap", async () => {
    const a = actions();
    const accept = vi.fn().mockResolvedValue(undefined);
    a.preview.mockResolvedValue({ period, lines: [line({ id: "l2", name: "Rice" })],
      issues: [], unmetPins: [], accept });
    render(<ShoppingView period={period} lines={[line()]} initialDraft={draft} actions={a} />);
    openPlan();
    fireEvent.click(screen.getByRole("button", { name: "Preview plan and list changes" }));
    await screen.findByText("Review the list change");
    expect(a.preview).toHaveBeenCalledWith({ draft, basket: [line().identity] });
    expect(accept).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep current plan" }));
    expect(accept).not.toHaveBeenCalled();
  });

  it("rebuilds the basket from new lines after replanning the same saved period", async () => {
    const a = actions();
    a.preview.mockResolvedValue({ period, lines: [], issues: [], unmetPins: [], accept: vi.fn() });
    const beans = line();
    const rice = line({ id: "l2", name: "Rice", identity: { foodRefId: "f2",
      catalogFoodRevisionId: 2, purchaseState: "raw", variantKey: "plain" } });
    const view = render(<ShoppingView period={period} lines={[beans]} initialDraft={draft} actions={a} />);
    view.rerender(<ShoppingView period={{ ...period, revision: 2 }} lines={[beans, rice]}
      initialDraft={draft} actions={a} />);
    openPlan();
    await waitFor(() => expect(screen.getByRole("button", { name: "Details for Rice" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Details for Beans" }));
    fireEvent.click(screen.getByRole("button", { name: "Details for Rice" }));
    expect(screen.getAllByLabelText("Use in next plan", { selector: "input" })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Preview plan and list changes" }));
    await waitFor(() => expect(a.preview).toHaveBeenCalledWith({ draft,
      basket: [beans.identity, rice.identity] }));
  });

  it("clears the old preview when a new preview request fails", async () => {
    const a = actions();
    a.preview.mockResolvedValueOnce({ period, lines: [], issues: [], unmetPins: [], accept: vi.fn() })
      .mockRejectedValueOnce(new Error("Rules changed"));
    render(<ShoppingView period={period} lines={[line()]} initialDraft={draft} actions={a} />);
    openPlan();
    fireEvent.click(screen.getByRole("button", { name: "Preview plan and list changes" }));
    await screen.findByText("Review the list change");
    fireEvent.click(screen.getByRole("button", { name: "Preview plan and list changes" }));
    await screen.findByText("Rules changed");
    expect(screen.queryByRole("button", { name: "Accept plan and list" })).toBeNull();
  });

  it("parses several typed items into one addItems call, naming the toast for the count", async () => {
    const a = actions();
    render(<ShoppingView period={period} lines={[]} initialDraft={draft} actions={a} />);
    fireEvent.change(screen.getByLabelText("Add items"), { target: { value: "Soap, Rice" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(a.addItems).toHaveBeenCalledWith(["Soap", "Rice"]));
    expect(await screen.findByText("2 items added.")).toBeTruthy();
    expect((screen.getByLabelText("Add items") as HTMLInputElement).value).toBe("");
  });

  it("skips an item already on the list when quick-adding", async () => {
    const a = actions();
    render(<ShoppingView period={period} lines={[line({ name: "Beans" })]} initialDraft={draft} actions={a} />);
    fireEvent.change(screen.getByLabelText("Add items"), { target: { value: "Beans, Rice" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(a.addItems).toHaveBeenCalledWith(["Rice"]));
    expect(await screen.findByText("Rice added.")).toBeTruthy();
  });

  it("keeps the typed text and shows the error when the added items do not save", async () => {
    const a = actions();
    a.addItems.mockRejectedValue(new Error("Those items did not save. Try again."));
    render(<ShoppingView period={period} lines={[]} initialDraft={draft} actions={a} />);
    const input = screen.getByLabelText("Add items") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Soap" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText("Those items did not save. Try again.")).toBeTruthy();
    expect(input.value).toBe("Soap");
  });

  it("keeps a different item typed while an add is in flight", async () => {
    const a = actions();
    let resolveAdd!: () => void;
    a.addItems.mockReturnValue(new Promise<void>((resolve) => { resolveAdd = resolve; }));
    render(<ShoppingView period={period} lines={[]} initialDraft={draft} actions={a} />);
    const input = screen.getByLabelText("Add items") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Soap" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(a.addItems).toHaveBeenCalledWith(["Soap"]));
    fireEvent.change(input, { target: { value: "Rice" } });
    resolveAdd();
    await waitFor(() => expect(screen.queryByText("Soap added.")).toBeTruthy());
    expect(input.value).toBe("Rice");
  });

  it("retains a manual item, bought mark and note in a preview", () => {
    const manual = line({ id: "manual", origin: "manual", category: "manual", name: "Soap",
      identity: null, checked: true, note: "large", sources: [] });
    render(<ShoppingPreview current={[manual]} preview={{ period, lines: [], issues: [], unmetPins: [],
      accept: vi.fn() }} onAccepted={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText(/a manual item, bought mark or note would be lost/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Accept plan and list" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows an unapproved new ingredient under a strict basket lock", () => {
    render(<ShoppingPreview current={[line()]} preview={{ period: { ...period, lockMode: "ingredients" },
      lines: [line(), line({ id: "l2", name: "Rice", identity: { foodRefId: "f2",
        catalogFoodRevisionId: 2, purchaseState: "raw", variantKey: "plain" } })],
      issues: [], unmetPins: [], accept: vi.fn() }} onAccepted={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText(/Rice: outside the selected basket/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Accept plan and list" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("allows a confirmed pantry ingredient within the strict set", () => {
    const rice = line({ id: "l2", name: "Rice", identity: { foodRefId: "f2",
      catalogFoodRevisionId: 2, purchaseState: "raw", variantKey: "plain" } });
    render(<ShoppingPreview current={[line()]} basket={[line().identity!]} confirmedPantry={[rice.identity!]}
      preview={{ period: { ...period, lockMode: "ingredients" }, lines: [line(), rice],
        issues: [], unmetPins: [], accept: vi.fn() }} onAccepted={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByText(/Rice: outside the selected basket/)).toBeNull();
    expect((screen.getByRole("button", { name: "Accept plan and list" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows approximate evidence without blocking acceptance and permits an increased-need bought reset", () => {
    const accept = vi.fn();
    render(<ShoppingPreview current={[line({ checked: true, needGrams: 500 })]}
      preview={{ period, lines: [line({ checked: false, needGrams: 700 })],
        issues: ["Purchase conversion is estimated."], blockingIssues: [], unmetPins: [], accept }}
      onAccepted={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText("Purchase conversion is estimated.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Accept plan and list" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("deduplicates repeated evidence and distinguishes known need from unknown package buy amount", () => {
    render(<ShoppingPreview current={[]} preview={{ period,
      lines: [line({ id: "tofu", name: "Tofu", needGrams: 220.4537, buyGrams: null }),
        line({ id: "oil", name: "Oil", needGrams: null, buyGrams: null })],
      issues: Array(7).fill("Raw purchase amount for Oil is unknown."), unmetPins: [],
      choices: [{ localDate: "2026-09-28", slotId: "meal-3", recipeName: "Stew",
        servingFraction: 1.0843 } as never], accept: vi.fn() }}
      onAccepted={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getAllByText("Raw purchase amount for Oil is unknown.")).toHaveLength(1);
    expect(screen.getByText("Tofu · 220.5 g needed · package amount to buy unknown")).toBeTruthy();
    expect(screen.getByText("Oil · purchase amount unknown")).toBeTruthy();
    expect(screen.getByText(/Meal 3: Stew · 1.08 servings/)).toBeTruthy();
  });

  it("shows each preview week's own need and buy amount", () => {
    const week = (startDate: string, endDate: string, needGrams: number, buyGrams: number) => ({
      window: { startDate, endDate, kind: "weekly" as const },
      lines: [{ lineId: "l1", needGrams, confirmedStockGrams: 0, buyGrams,
        checked: false, note: null, revision: 0 }],
    });
    render(<ShoppingPreview current={[]} preview={{ period: { ...period, endDate: "2026-10-10" },
      lines: [line()], issues: [], unmetPins: [], accept: vi.fn(),
      replenishment: [week("2026-09-27", "2026-10-03", 220.4537, 250),
        week("2026-10-04", "2026-10-10", 110.25, 125)] }}
      onAccepted={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText(/220.5 g needed · 250 g to buy/)).toBeTruthy();
    expect(screen.getByText(/110.3 g needed · 125 g to buy/)).toBeTruthy();
    expect(screen.queryByText(/period totals until weekly purchases/)).toBeNull();
  });

  it("shows rounded shopping amounts and readable meal source references", () => {
    const source = { ...line().sources[0], localDate: "2026-09-28", slotId: "meal-3",
      recipeRevisionId: "4a652c4d-1c1a-4505-a107-7a80e843b132", requiredGrams: 220.4537 };
    render(<ShoppingView period={period} initialDraft={draft} actions={actions()} lines={[line({
      needGrams: 220.4537, buyGrams: 219.999, packageGrams: 250.567, sources: [source],
    })]} />);
    fireEvent.click(screen.getByRole("button", { name: "Details for Beans" }));
    expect(screen.getByText("220.5 g")).toBeTruthy();
    expect(screen.getByText("220 g")).toBeTruthy();
    expect(screen.getByText("Package 250.6 g")).toBeTruthy();
    fireEvent.click(screen.getByText("Needed for 1 planned use"));
    expect(screen.getByText((_, element) => element?.tagName === "LI"
      && element.textContent === "Sep 28 · Meal 3 · 220.5 g")).toBeTruthy();
    expect(screen.queryByText(/4a652c4d/)).toBeNull();
  });

  it("keeps an unknown weekly amount unknown and rounds confirmed stock for display", () => {
    const month = { ...period, endDate: "2026-10-26" };
    const weekly = [{ id: "w1", periodId: "p1", lineId: "l1", windowStartDate: "2026-09-27",
      windowEndDate: "2026-10-03", needGrams: null, confirmedStockGrams: 23.456,
      buyGrams: null, checked: false, note: null, revision: 1 }];
    render(<ShoppingView period={month} initialDraft={draft} lines={[line()]}
      purchaseWindows={weekly} actions={{ ...actions(), patchWindow: vi.fn().mockResolvedValue(undefined) }} />);
    expect(screen.getAllByText("Amount unknown")).toHaveLength(2);
    expect(screen.getByText("23.5 g confirmed stock allocated here.")).toBeTruthy();
  });

  it("splits a monthly line's requirement across its source weeks", () => {
    const month = { ...period, endDate: "2026-10-26" };
    render(<ShoppingView period={month} initialDraft={draft} actions={actions()} lines={[line({
      sources: [line().sources[0], { ...line().sources[0], localDate: "2026-10-07", requiredGrams: 150 }],
      needGrams: 650, buyGrams: 650,
    })]} />);
    expect(screen.getByRole("region", { name: "Week 1" }).textContent).toContain("500 g needed");
    expect(screen.getByRole("region", { name: "Week 2" }).textContent).toContain("150 g needed");
  });

  it("renders persisted weekly Buy and saves a check only for that purchase window", async () => {
    const month = { ...period, endDate: "2026-10-26" };
    const patchWindow = vi.fn().mockResolvedValue(undefined);
    const weekly = [
      { id: "w1", periodId: "p1", lineId: "l1", windowStartDate: "2026-09-27",
        windowEndDate: "2026-10-03", needGrams: 500, confirmedStockGrams: 100,
        buyGrams: 400, checked: false, note: null, revision: 1 },
      { id: "w2", periodId: "p1", lineId: "l1", windowStartDate: "2026-10-04",
        windowEndDate: "2026-10-10", needGrams: 150, confirmedStockGrams: 0,
        buyGrams: 150, checked: false, note: null, revision: 1 },
    ];
    render(<ShoppingView period={month} initialDraft={draft} lines={[line()]}
      purchaseWindows={weekly} actions={{ ...actions(), patchWindow }} />);
    expect(screen.getByRole("region", { name: "Week 1" }).textContent).toContain("400 g");
    expect(screen.getByRole("region", { name: "Week 2" }).textContent).toContain("150 g");
    fireEvent.click(screen.getByRole("checkbox", { name: "Bought Beans for 2026-09-27" }));
    await waitFor(() => expect(patchWindow).toHaveBeenCalledWith(weekly[0], { checked: true }));
    expect(await screen.findByText("Marked bought this week.")).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Bought Beans" })).toBeNull();
  });

  it("sends only selected basket identities to the plan preview", async () => {
    const a = actions();
    a.preview.mockResolvedValue({ period, lines: [], issues: [], unmetPins: [], accept: vi.fn() });
    render(<ShoppingView period={period} lines={[line()]} initialDraft={draft} actions={a} />);
    openPlan();
    fireEvent.click(screen.getByRole("button", { name: "Details for Beans" }));
    fireEvent.click(screen.getByLabelText("Use in next plan"));
    fireEvent.click(screen.getByRole("button", { name: "Preview plan and list changes" }));
    await waitFor(() => expect(a.preview).toHaveBeenCalledWith({ draft, basket: [] }));
  });

  it("saves a pin and stock through account-backed callbacks", async () => {
    const a = actions();
    render(<ShoppingView period={period} lines={[line()]} initialDraft={draft} actions={a} />);
    openPlan();
    fireEvent.click(screen.getByRole("button", { name: "Details for Beans" }));
    fireEvent.click(screen.getByLabelText("Keep this ingredient in my plan"));
    await waitFor(() => expect(a.patchLine).toHaveBeenCalledWith(expect.objectContaining({ id: "l1" }), { pinned: true }));
    expect(await screen.findByText("Ingredient kept in plan.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Have already (confirmed g)"), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm stock" }));
    await waitFor(() => expect(a.confirmPantry).toHaveBeenCalledWith(expect.objectContaining({ id: "l1" }), 100));
    expect(await screen.findByText("Stock confirmed.")).toBeTruthy();
  });

  it("edits a saved manual item's name through the revision-backed patch action", async () => {
    const a = actions();
    render(<ShoppingView period={period} lines={[line({ origin: "manual", category: "manual",
      identity: null, name: "Soap", sources: [] })]} initialDraft={draft} actions={a} />);
    fireEvent.click(screen.getByRole("button", { name: "Details for Soap" }));
    expect(screen.queryByLabelText("Keep this ingredient in my plan")).toBeNull();
    fireEvent.change(screen.getByLabelText("Item name"), { target: { value: "Dish soap" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(a.patchLine).toHaveBeenCalledWith(expect.objectContaining({ id: "l1" }),
      { name: "Dish soap" }));
    // The Save button confirms in itself (2026-10-04 button system), not with a toast.
    await waitFor(() => expect(screen.getByRole("button", { name: "Save name" }).getAttribute("data-status")).toBe("success"));
    expect(screen.getByRole("button", { name: "Save name" }).textContent).toContain("Saved");
    expect(screen.getByRole("button", { name: "Save name" }).getAttribute("data-feedback-state")).toBe("success");
    expect(screen.getByRole("button", { name: "Save note" }).getAttribute("data-feedback-state")).toBeNull();
  });

  it("keeps a failed manual note draft and shows no saved confirmation", async () => {
    const a = actions();
    a.patchLine.mockRejectedValueOnce(new Error("Could not reach shopping"));
    render(<ShoppingView period={period} lines={[line({ origin: "manual", category: "manual",
      identity: null, name: "Soap", sources: [] })]} initialDraft={draft} actions={a} />);
    fireEvent.click(screen.getByRole("button", { name: "Details for Soap" }));
    fireEvent.change(screen.getByLabelText("Note"), { target: { value: "Large bottle" } });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    expect(await screen.findByText("Could not reach shopping")).toBeTruthy();
    expect((screen.getByLabelText("Note") as HTMLInputElement).value).toBe("Large bottle");
    expect(screen.queryByText("Note saved.")).toBeNull();
  });

  it("keeps note confirmation visible when the saved row refreshes", async () => {
    const a = actions();
    const manual = line({ origin: "manual", category: "manual", identity: null,
      name: "Soap", sources: [] });
    const view = render(<ShoppingView period={period} lines={[manual]} initialDraft={draft} actions={a} />);
    fireEvent.click(screen.getByRole("button", { name: "Details for Soap" }));
    fireEvent.change(screen.getByLabelText("Note"), { target: { value: "Large bottle" } });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save note" }).getAttribute("data-status")).toBe("success"));
    view.rerender(<ShoppingView period={period} lines={[{ ...manual, note: "Large bottle", revision: 2 }]}
      initialDraft={draft} actions={a} />);
    expect((screen.getByLabelText("Note") as HTMLInputElement).value).toBe("Large bottle");
    expect(screen.getByRole("button", { name: "Save note" }).getAttribute("data-status")).toBe("success");
  });

  it("confirms a single item only after the add callback resolves", async () => {
    const a = actions();
    render(<ShoppingView period={period} lines={[]} initialDraft={draft} actions={a} />);
    fireEvent.change(screen.getByLabelText("Add items"), { target: { value: "Soap" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(a.addItems).toHaveBeenCalledWith(["Soap"]));
    expect(await screen.findByText("Soap added.")).toBeTruthy();
    expect((screen.getByLabelText("Add items") as HTMLInputElement).value).toBe("");
  });
});
