// @vitest-environment jsdom
/**
 * "Put it in a meal" (owner ask 2026-10-03): from a recipe card or detail, pick a day (today and the
 * next six, the viewed day first chosen) and a meal slot of that day's layout, in place. Nothing is
 * written until the confirm; the confirm runs the catalog's recipe plan path with that date and slot.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import type { RecipeCandidate } from "@/lib/recipe-catalog/types";
import { addDays, clock12, dayChoices, dayName, defaultSlot, localDate, slotChoices, slotState,
  type SlotChoice } from "@/lib/recipes-hub/put-in-meal";

const previewRecipePlan = vi.hoisted(() => vi.fn());
const acceptRecipePlan = vi.hoisted(() => vi.fn());
vi.mock("@/lib/recipe-plan-client", () => ({ previewRecipePlan, acceptRecipePlan }));

import PutInMeal, { PutInMealPicker } from "@/components/recipes-hub/PutInMeal";
import { resetFlightsForTests } from "@/components/single-flight";
import RecipeResultCard from "@/components/RecipeResultCard";

const known = (value: number) => ({ value, status: "known" as const, sourceRevisionId: 1 });
const RECIPE: RecipeCandidate = {
  sourceKind: "shared", recipeId: "r1", revisionId: "v1", publicationState: "published",
  withdrawalReason: null, name: "Bean stew", cuisine: "Home", dishTags: [], activeMinutes: 15, totalMinutes: 40,
  effort: "standard", servings: 3, yieldGrams: 900, yieldStatus: "known", minServingFraction: 0.5,
  maxServingFraction: 2,
  ingredients: [{ seq: 1, name: "Beans", foodRefId: "f1", catalogFoodRevisionId: 1, quantity: 300, unit: "g",
    grams: 300, state: "raw", required: true, purchaseGrams: 300, purchaseConversionStatus: "known",
    nutrition: { kcal: known(900), protein: known(60), carbs: known(120), fat: known(15) }, allergenEvidence: {} }],
  steps: [{ seq: 1, text: "Simmer the beans." }],
  nutritionPerServing: { kcal: known(300), protein: known(20), carbs: known(40), fat: known(5) },
  source: { author: "Sasha kitchen", sourceUrl: null, rightsKind: "original", rightsRecord: "o", sourceRevision: "1",
    kitchenTested: false },
  eligibility: { status: "eligible", reasons: [] },
};

const SLOTS: SlotChoice[] = [
  { slotId: "meal-1", label: "Meal 1", time: "08:00", planned: "Oats", eaten: true },
  { slotId: "meal-2", label: "Meal 2", time: "12:30", planned: "Chicken & rice", eaten: false },
  { slotId: "meal-3", label: "Meal 3", time: "18:00", planned: null, eaten: false },
];
const readSlots = vi.fn((_date: string) => SLOTS);
const today = localDate();

function preview(over: Record<string, unknown> = {}) {
  return { previewId: "p1", recipe: RECIPE, servingFraction: 1.5, exactFitAvailable: true,
    approximateFitAvailable: true, ...over };
}

beforeEach(() => {
  resetFlightsForTests();
  unbindAccount();
  bindAccount("user-a");
  previewRecipePlan.mockReset().mockResolvedValue(preview());
  acceptRecipePlan.mockReset().mockResolvedValue({ id: "s1" });
  readSlots.mockClear();
});
afterEach(cleanup);

describe("the put-in-a-meal rules", () => {
  it("offers today and the next six days, and leads with a viewed day outside them", () => {
    const days = dayChoices("2026-10-03");
    expect(days.map((day) => day.date)).toEqual(["2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06",
      "2026-10-07", "2026-10-08", "2026-10-09"]);
    expect(days[0]).toMatchObject({ label: "Today", day: "3", name: "Today, Saturday, October 3" });
    expect(days[1]).toMatchObject({ label: "Sun", day: "4", name: "Sunday, October 4" });
    expect(dayChoices("2026-10-03", 7, "2026-10-20")[0].date).toBe("2026-10-20");
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(dayName("2026-10-04", "2026-10-03")).toBe("tomorrow");
    expect(dayName("2026-10-06", "2026-10-03")).toBe("Tuesday");
  });

  it("lists only the layout's meal slots in time order, with what is planned in each", () => {
    const meal = (name: string) => ({ name }) as never;
    const choices = slotChoices([
      { slot: "meal-2", label: "Meal 2", time: "12:30", meal: meal("Chicken & rice"), eaten: false },
      { slot: "meal-1", label: "Meal 1", time: "08:00", meal: null, eaten: false },
      { slot: "pre-bed" as never, label: "Pre-bed", time: "21:00", meal: meal("Casein"), eaten: false },
    ]);
    expect(choices.map((choice) => choice.slotId)).toEqual(["meal-1", "meal-2"]);
    expect(choices.map(slotState)).toEqual(["Empty", "Chicken & rice"]);
    expect(clock12("12:30")).toBe("12:30 pm");
    expect(clock12("08:00")).toBe("8:00 am");
  });

  it("pre-chooses the viewed meal or the first empty one, never an eaten or a planned one", () => {
    expect(defaultSlot(SLOTS, "meal-2")).toBe("meal-2");
    expect(defaultSlot(SLOTS, "meal-1")).toBe("meal-3");
    expect(defaultSlot(SLOTS)).toBe("meal-3");
    expect(defaultSlot(SLOTS.slice(0, 2))).toBeNull();
  });
});

describe("the put-in-a-meal picker", () => {
  it("shows seven day chips with the viewed day chosen, and slot chips with time and state", () => {
    const viewed = addDays(today, 2);
    render(<PutInMealPicker recipe={RECIPE} initialDate={viewed} readSlots={readSlots} />);
    const days = within(screen.getByRole("group", { name: "Day" })).getAllByRole("button");
    expect(days).toHaveLength(7);
    expect(days[0].textContent).toContain("Today");
    expect(days[2].getAttribute("aria-pressed")).toBe("true");
    expect(readSlots).toHaveBeenCalledWith(viewed);
    const slots = within(screen.getByRole("group", { name: "Meal" })).getAllByRole("button");
    expect(slots.map((slot) => slot.textContent)).toEqual([
      "Meal 18:00 amEaten", "Meal 212:30 pmReplaces Chicken & rice", "Meal 36:00 pmEmpty"]);
    expect((slots[0] as HTMLButtonElement).disabled).toBe(true);
    expect(slots[2].getAttribute("aria-pressed")).toBe("true");
  });

  it("writes nothing while choosing, and warns before replacing a planned meal", () => {
    render(<PutInMealPicker recipe={RECIPE} readSlots={readSlots} />);
    fireEvent.click(within(screen.getByRole("group", { name: "Day" })).getAllByRole("button")[3]);
    fireEvent.click(screen.getByRole("button", { name: /Meal 2/ }));
    expect(screen.getByText("This replaces Chicken & rice in Meal 2.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Meal 3/ }));
    expect(screen.queryByText(/This replaces/)).toBeNull();
    expect(previewRecipePlan).not.toHaveBeenCalled();
    expect(acceptRecipePlan).not.toHaveBeenCalled();
  });

  it("confirms through the recipe plan path with the chosen date and slot, and says so inline", async () => {
    const onPlanned = vi.fn();
    const accepted = vi.fn();
    window.addEventListener("recipe-plan-accepted", accepted);
    render(<PutInMealPicker recipe={RECIPE} readSlots={readSlots} onPlanned={onPlanned} />);
    const tomorrow = addDays(today, 1);
    fireEvent.click(within(screen.getByRole("group", { name: "Day" })).getAllByRole("button")[1]);
    fireEvent.click(screen.getByRole("button", { name: /Meal 2/ }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Put in Meal 2, tomorrow" })); });
    expect(previewRecipePlan).toHaveBeenCalledWith("r1", tomorrow, "meal-2");
    expect(acceptRecipePlan).toHaveBeenCalledWith("r1", "p1", expect.any(String), false);
    expect(screen.getByRole("status").textContent).toContain("In Meal 2, tomorrow · 1.5 servings.");
    expect(onPlanned).toHaveBeenCalledTimes(1);
    expect(accepted).toHaveBeenCalledTimes(1);
    window.removeEventListener("recipe-plan-accepted", accepted);
  });

  it("accepts an approximate portion only as approximate, and stops when no portion can be sized", async () => {
    previewRecipePlan.mockResolvedValueOnce(preview({ exactFitAvailable: false }));
    render(<PutInMealPicker recipe={RECIPE} readSlots={readSlots} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Put in Meal 3, today" })); });
    expect(acceptRecipePlan).toHaveBeenCalledWith("r1", "p1", expect.any(String), true);
    expect(screen.getByRole("status").textContent).toContain("approximate");
    cleanup();
    // A fresh scenario on the same day/slot, not a remount of the one above: forget what it left.
    resetFlightsForTests();
    previewRecipePlan.mockResolvedValueOnce(preview({ exactFitAvailable: false, approximateFitAvailable: false }));
    acceptRecipePlan.mockClear();
    render(<PutInMealPicker recipe={RECIPE} readSlots={readSlots} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Put in Meal 3, today" })); });
    expect(acceptRecipePlan).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/Adjust portion/);
  });

  it("grows in place from a result card's Put it in a meal button, with no dialog", async () => {
    render(<RecipeResultCard recipe={RECIPE} expanded onExpandedChange={() => {}}
      placement={{ initialDate: today, initialSlotId: "meal-3" }} />);
    const trigger = screen.getByRole("button", { name: "Put it in a meal" });
    fireEvent.click(trigger);
    const picker = await screen.findByRole("region", { name: "Put Bean stew in a meal" });
    expect(screen.getByRole("article").contains(picker)).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(previewRecipePlan).not.toHaveBeenCalled();
    fireEvent.click(within(picker).getByRole("button", { name: "Close meal picker" }));
    fireEvent.click(await screen.findByRole("button", { name: "Put it in a meal" }));
    fireEvent.keyDown(await screen.findByRole("region", { name: "Put Bean stew in a meal" }), { key: "Escape" });
    expect(await screen.findByRole("button", { name: "Put it in a meal" })).toBeTruthy();
  });
});

/** A promise and the hand that settles it, so a test can act while a request is in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("the put-in-a-meal confirm (audit 2026-10-04)", () => {
  const confirmButton = () => screen.getByRole("button", { name: "Put in Meal 3, today" });

  it("places once when the confirm is tapped twice in the same tick", async () => {
    const accepted = vi.fn();
    window.addEventListener("recipe-plan-accepted", accepted);
    render(<PutInMealPicker recipe={RECIPE} readSlots={readSlots} />);
    const button = confirmButton();
    await act(async () => { fireEvent.click(button); fireEvent.click(button); });
    expect(previewRecipePlan).toHaveBeenCalledTimes(1);
    expect(acceptRecipePlan).toHaveBeenCalledTimes(1);
    expect(accepted).toHaveBeenCalledTimes(1);
    window.removeEventListener("recipe-plan-accepted", accepted);
  });

  it("never accepts when the account changes while the preview is in flight", async () => {
    const pending = deferred<ReturnType<typeof preview>>();
    previewRecipePlan.mockReturnValueOnce(pending.promise);
    render(<PutInMealPicker recipe={RECIPE} readSlots={readSlots} />);
    fireEvent.click(confirmButton());
    bindAccount("user-b");
    await act(async () => { pending.resolve(preview()); });
    expect(acceptRecipePlan).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Account changed");
  });

  it("refuses to start for an account other than the one that opened the picker", async () => {
    render(<PutInMealPicker recipe={RECIPE} readSlots={readSlots} />);
    bindAccount("user-b");
    await act(async () => { fireEvent.click(confirmButton()); });
    expect(previewRecipePlan).not.toHaveBeenCalled();
    expect(acceptRecipePlan).not.toHaveBeenCalled();
  });

  it("drops an accept that lands after an account change: no success, no plan refresh", async () => {
    const pending = deferred<{ id: string }>();
    acceptRecipePlan.mockReturnValueOnce(pending.promise);
    const accepted = vi.fn();
    const onPlanned = vi.fn();
    window.addEventListener("recipe-plan-accepted", accepted);
    render(<PutInMealPicker recipe={RECIPE} readSlots={readSlots} onPlanned={onPlanned} />);
    await act(async () => { fireEvent.click(confirmButton()); });
    expect(acceptRecipePlan).toHaveBeenCalledTimes(1);
    bindAccount("user-b");
    await act(async () => { pending.resolve({ id: "s1" }); });
    expect(screen.queryByRole("status")).toBeNull();
    expect(accepted).not.toHaveBeenCalled();
    expect(onPlanned).not.toHaveBeenCalled();
    window.removeEventListener("recipe-plan-accepted", accepted);
  });

  it("never accepts after the picker has closed mid-preview", async () => {
    const pending = deferred<ReturnType<typeof preview>>();
    previewRecipePlan.mockReturnValueOnce(pending.promise);
    const { unmount } = render(<PutInMealPicker recipe={RECIPE} readSlots={readSlots} />);
    fireEvent.click(confirmButton());
    unmount();
    await act(async () => { pending.resolve(preview()); });
    expect(acceptRecipePlan).not.toHaveBeenCalled();
  });

  it("stops the confirm when one of the recipe's ingredients is avoided after the picker opened", async () => {
    render(<PutInMealPicker recipe={RECIPE} readSlots={readSlots} />);
    act(() => { window.dispatchEvent(new CustomEvent("recipe-avoid-changed", { detail: "beans" })); });
    expect((confirmButton() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Your Avoid list changed/)).toBeTruthy();
    await act(async () => { fireEvent.click(confirmButton()); });
    expect(previewRecipePlan).not.toHaveBeenCalled();
  });

  it("stops before the accept when the avoid change lands during the preview", async () => {
    const pending = deferred<ReturnType<typeof preview>>();
    previewRecipePlan.mockReturnValueOnce(pending.promise);
    render(<PutInMealPicker recipe={RECIPE} readSlots={readSlots} />);
    fireEvent.click(confirmButton());
    act(() => { window.dispatchEvent(new CustomEvent("recipe-avoid-changed", { detail: "Beans" })); });
    await act(async () => { pending.resolve(preview()); });
    expect(acceptRecipePlan).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Your Avoid list changed");
  });
});

describe("the put-in-a-meal lock outlives the picker (audit r4)", () => {
  it("disables Close while a placement is on the wire", async () => {
    const pending = deferred<{ id: string }>();
    acceptRecipePlan.mockReturnValueOnce(pending.promise);
    const onClose = vi.fn();
    render(<PutInMealPicker recipe={RECIPE} readSlots={readSlots} onClose={onClose} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Put in Meal 3, today" })); });
    const close = screen.getByRole("button", { name: "Close meal picker" }) as HTMLButtonElement;
    expect(close.disabled).toBe(true);
    fireEvent.keyDown(screen.getByRole("region"), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { pending.resolve({ id: "s1" }); });
    expect(close.disabled).toBe(false);
  });

  it("sends one accept when the picker is closed mid-accept, opened again and confirmed", async () => {
    const pending = deferred<{ id: string }>();
    acceptRecipePlan.mockReturnValueOnce(pending.promise);
    const first = render(<PutInMealPicker recipe={RECIPE} readSlots={readSlots} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Put in Meal 3, today" })); });
    expect(acceptRecipePlan).toHaveBeenCalledTimes(1);
    first.unmount();
    render(<PutInMealPicker recipe={RECIPE} readSlots={readSlots} />);
    const again = screen.getByRole("button", { name: "Placing…" }) as HTMLButtonElement;
    expect(again.disabled).toBe(true);
    await act(async () => { fireEvent.click(again); });
    expect(previewRecipePlan).toHaveBeenCalledTimes(1);
    expect(acceptRecipePlan).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve({ id: "s1" }); });
    // The outcome hydrates into this same remounted instance once the lock clears (audit g1
    // MAJOR): it shows what happened rather than a freshly enabled confirm over a done placement.
    expect(screen.getByRole("status").textContent).toContain("In Meal 3, today");
    expect(screen.queryByRole("button", { name: "Put in Meal 3, today" })).toBeNull();
  });

  it("shows the outcome on a picker that mounts after the placement already settled, and blocks a repeat (audit f2 MAJOR)", async () => {
    const pending = deferred<{ id: string }>();
    acceptRecipePlan.mockReturnValueOnce(pending.promise);
    const first = render(<PutInMealPicker recipe={RECIPE} readSlots={readSlots} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Put in Meal 3, today" })); });
    first.unmount();
    await act(async () => { pending.resolve({ id: "s1" }); });
    expect(acceptRecipePlan).toHaveBeenCalledTimes(1);
    render(<PutInMealPicker recipe={RECIPE} readSlots={readSlots} />);
    expect(screen.getByRole("status").textContent).toContain("In Meal 3, today");
    expect(screen.queryByRole("button", { name: "Put in Meal 3, today" })).toBeNull();
    // Nothing to tap that could repeat the accept: the outcome replaced the whole picker body.
    expect(acceptRecipePlan).toHaveBeenCalledTimes(1);
  });

  it("shows the outcome on a picker that remounted WHILE the placement was still in flight, and blocks a repeat (audit g1 MAJOR)", async () => {
    const pending = deferred<{ id: string }>();
    acceptRecipePlan.mockReturnValueOnce(pending.promise);
    const first = render(<PutInMealPicker recipe={RECIPE} readSlots={readSlots} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Put in Meal 3, today" })); });
    first.unmount();
    render(<PutInMealPicker recipe={RECIPE} readSlots={readSlots} />); // remounts while still in flight
    expect(screen.getByRole("button", { name: "Placing…" })).toBeTruthy();
    await act(async () => { pending.resolve({ id: "s1" }); });
    expect(screen.getByRole("status").textContent).toContain("In Meal 3, today");
    expect(screen.queryByRole("button", { name: "Put in Meal 3, today" })).toBeNull();
    expect(acceptRecipePlan).toHaveBeenCalledTimes(1);
  });

  it("forgets the outcome once Done is acknowledged, so a picker that mounts later starts fresh", async () => {
    const onClose = vi.fn();
    const first = render(<PutInMealPicker recipe={RECIPE} readSlots={readSlots} onClose={onClose} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Put in Meal 3, today" })); });
    expect(await screen.findByRole("status")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    first.unmount();
    render(<PutInMealPicker recipe={RECIPE} readSlots={readSlots} />);
    expect(screen.getByRole("button", { name: "Put in Meal 3, today" })).toBeTruthy();
  });

  it("keeps the trigger's picker open while placing: the outer Close cannot drop the lock", async () => {
    const pending = deferred<{ id: string }>();
    acceptRecipePlan.mockReturnValueOnce(pending.promise);
    render(<PutInMeal recipe={RECIPE} initialDate={today} initialSlotId="meal-3" />);
    fireEvent.click(screen.getByRole("button", { name: "Put it in a meal" }));
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: "Put in Meal 3, today" })); });
    fireEvent.click(screen.getByRole("button", { name: "Close meal picker" }));
    expect(screen.getByRole("region", { name: "Put Bean stew in a meal" })).toBeTruthy();
    await act(async () => { pending.resolve({ id: "s1" }); });
  });
});
