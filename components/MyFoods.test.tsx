// @vitest-environment jsdom
/**
 * FluidVoice A04/A05/T09: a food row opens its edit sheet on tap; a left swipe reveals Remove and a
 * full swipe applies the durable neutral-membership operation, on role groups and Other foods
 * alike. Short, vertical and cancelled swipes write nothing. A star tap never reveals Remove (U13).
 * Every category card ends with one footer row: "Show all N" left, Add right, or Add alone (U14).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { Food } from "@/lib/foods";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { TEST_USER } from "@/tests/helpers/account";

const membership = vi.hoisted(() => ({
  set: vi.fn(async (..._args: unknown[]) => ({ truncated: false })),
}));
vi.mock("@/lib/foods/prefs-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/foods/prefs-client")>();
  return { ...actual, setFoodMembership: membership.set, saveFoodEdits: vi.fn() };
});

/** The hide path (W148): a synced Other row is hidden and restored through these two. */
const hide = vi.hoisted(() => ({ can: vi.fn(async (..._args: unknown[]) => false),
  hide: vi.fn(async (..._args: unknown[]) => true), unhide: vi.fn(async (..._args: unknown[]) => true) }));
vi.mock("@/lib/foods/hide-client", () => ({
  canHideFood: hide.can, hideFood: hide.hide, unhideFood: hide.unhide }));

/** The phone projection, pinned: the rows under test and the status writes against them. */
const seeded = vi.hoisted(() => ({ foods: {} as Record<string, Food> }));
vi.mock("@/lib/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store")>();
  const store = () => ({ ...actual.defaultStore(), foods: seeded.foods });
  return {
    ...actual,
    loadStore: store,
    setFoodStatus: (id: string, status: Food["status"]) => {
      seeded.foods = { ...seeded.foods, [id]: { ...seeded.foods[id], status } };
      return store();
    },
    setFoodNote: (id: string, note: string) => {
      seeded.foods = { ...seeded.foods, [id]: { ...seeded.foods[id], note } };
      return store();
    },
    upsertFood: (food: Food) => { seeded.foods = { ...seeded.foods, [food.id]: food }; return store(); },
  };
});

/** The Eats rule marks have their own spec (MyFoods.rule-marks.test.tsx): here every read clears
 *  every Eats food, so no mark or list line joins the rows under test. */
vi.mock("@/lib/foods/eligible-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/foods/eligible-client")>();
  const { foodRulesKey } = await import("@/lib/foods/rule-marks");
  const { foodRulesEpoch } = await import("@/lib/foods/rules-epoch");
  return { ...actual, loadEligibleLocalFoodIds: async (_account: unknown, foods: Record<string, Food>) =>
    new actual.StampedEligibleSet(Object.values(foods).filter((item) => item.status === "eats").map((item) => item.id),
      new Map(), foodRulesKey({ dietPrefs: { flags: [] } }), foodRulesEpoch()) };
});

const { default: EatsFoods, AvoidFoods, foodRowSwipeDecision, removeDragStyle } = await import("./MyFoods");

function food(over: Partial<Food>): Food {
  return { id: "oats", name: "Oats", role: "carb", unit: "g",
    perUnit: { protein: 0.1, carbs: 0.6, fat: 0.07 }, status: "eats",
    updatedAt: "2026-09-20T00:00:00.000Z", ...over } as Food;
}

function seed(...foods: Food[]): void {
  seeded.foods = Object.fromEntries(foods.map((item) => [item.id, item]));
}

beforeEach(() => {
  unbindAccount(); bindAccount(TEST_USER);
  membership.set.mockClear();
  hide.can.mockClear(); hide.hide.mockClear(); hide.unhide.mockClear();
  seed(food({ note: "fine in the morning" }),
    food({ id: "rice", name: "Rice", role: "carb", status: "neutral", note: "hurt on 9/12" }));
});
afterEach(() => { cleanup(); });

/** A finger drag across the row from x 300. */
function swipe(row: HTMLElement, dx: number, dy = 0) {
  fireEvent.pointerDown(row, { pointerType: "touch", pointerId: 1, clientX: 300, clientY: 100 });
  fireEvent.pointerMove(row, { pointerType: "touch", pointerId: 1, clientX: 300 + dx, clientY: 100 + dy });
  fireEvent.pointerUp(row, { pointerType: "touch", pointerId: 1, clientX: 300 + dx, clientY: 100 + dy });
}

/** A row in the closed "Other foods" Disclosure is hidden until that section is opened. */
const rowOf = (name: string) => {
  const row = screen.queryByRole("button", { name: `Edit ${name}` });
  if (row) return row;
  fireEvent.click(screen.getByRole("button", { name: /^Other foods/ }));
  return screen.getByRole("button", { name: `Edit ${name}` });
};
const removeOf = (name: RegExp) => screen.getByRole("button", { name });

describe("foodRowSwipeDecision", () => {
  it("reveals on a partial left swipe and removes past the full threshold", () => {
    expect(foodRowSwipeDecision(-100, 4)).toBe("reveal");
    expect(foodRowSwipeDecision(-200, 10)).toBe("remove");
  });

  it("ignores short, rightward and vertical-dominant travel", () => {
    expect(foodRowSwipeDecision(-30, 0)).toBeNull();
    expect(foodRowSwipeDecision(120, 0)).toBeNull();
    expect(foodRowSwipeDecision(-200, 150)).toBeNull();
  });
});

describe("a food row", () => {
  it("opens the food's edit sheet on tap", async () => {
    render(<EatsFoods />);
    fireEvent.click(rowOf("Oats"));
    expect(await screen.findByRole("button", { name: "Add to Avoid" })).toBeTruthy();
  });

  it("writes nothing on a short, vertical or cancelled swipe", async () => {
    render(<EatsFoods />);
    swipe(rowOf("Oats"), -30);
    swipe(rowOf("Oats"), -60, 160);
    fireEvent.pointerDown(rowOf("Oats"), { pointerType: "touch", pointerId: 1, clientX: 300, clientY: 100 });
    fireEvent.pointerMove(rowOf("Oats"), { pointerType: "touch", pointerId: 1, clientX: 100, clientY: 102 });
    fireEvent.pointerCancel(rowOf("Oats"), { pointerType: "touch", pointerId: 1 });
    await act(async () => {});
    expect(membership.set).not.toHaveBeenCalled();
    expect(removeOf(/Remove Oats from Favorites/).getAttribute("data-revealed")).toBe("false");
    expect(seeded.foods.oats.status).toBe("eats");
  });

  it("reveals Remove on a partial left swipe without writing", async () => {
    render(<EatsFoods />);
    swipe(rowOf("Oats"), -100, 6);
    await act(async () => {});
    expect(removeOf(/Remove Oats from Favorites/).getAttribute("data-revealed")).toBe("true");
    expect(membership.set).not.toHaveBeenCalled();
    // The swipe's own click is swallowed: no edit sheet opens behind the revealed control.
    fireEvent.click(rowOf("Oats"), { detail: 1 });
    expect(screen.queryByRole("button", { name: "Add to Avoid" })).toBeNull();
  });

  it("applies the neutral membership operation once on a full left swipe, keeping the note", async () => {
    render(<EatsFoods />);
    swipe(rowOf("Oats"), -200, 8);
    await act(async () => {});
    expect(membership.set).toHaveBeenCalledTimes(1);
    expect(membership.set.mock.calls[0][0]).toBe("Oats");
    expect(membership.set.mock.calls[0][1]).toBeNull();
    expect(seeded.foods.oats).toMatchObject({ status: "neutral", note: "fine in the morning" });
  });

  it("gives Other foods the same edit and swipe behavior", async () => {
    render(<EatsFoods />);
    fireEvent.click(rowOf("Rice"));
    expect(await screen.findByRole("button", { name: "Add to Favorites" })).toBeTruthy();
    cleanup();
    render(<EatsFoods />);
    swipe(rowOf("Rice"), -100);
    await act(async () => {});
    const clear = screen.getByRole("button", { name: "Remove Rice from Other foods" });
    expect(clear.textContent).toBe("Remove");
    expect(clear.getAttribute("data-revealed")).toBe("true");
    swipe(rowOf("Rice"), -200);
    await act(async () => {});
    expect(membership.set).toHaveBeenCalledTimes(1);
    expect(membership.set.mock.calls[0].slice(0, 2)).toEqual(["Rice", null]);
    expect(seeded.foods.rice).toMatchObject({ status: "neutral", note: "hurt on 9/12" });
    // Already neutral: the row and its note stay in Other foods after the idempotent clear.
    expect(rowOf("Rice")).toBeTruthy();
    expect(screen.getByText("hurt on 9/12")).toBeTruthy();
  });

  it("offers a visible 44 px Remove without any gesture", async () => {
    render(<EatsFoods />);
    const toggle = screen.getByRole("button", { name: "Edit Carbs list" });
    expect(toggle.className).toContain("min-h-11");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    const remove = removeOf(/Remove Oats from Favorites/);
    expect(remove.getAttribute("data-revealed")).toBe("true");
    expect(remove.className).toContain("min-h-11");
    fireEvent.click(remove);
    await act(async () => {});
    expect(membership.set).toHaveBeenCalledTimes(1);
  });
});

describe("category cards", () => {
  it("end in one footer row: Add alone while nothing is hidden, on every role group and Other", () => {
    const { container } = render(<EatsFoods />);
    const footers = [...container.querySelectorAll<HTMLElement>("[data-list-footer]")];
    const adds = footers.map((footer) => footer.querySelector<HTMLElement>("[data-category-add]")!);
    expect(adds.map((node) => node.getAttribute("aria-label"))).toEqual([
      "Add protein food", "Add carbs food", "Add fats food", "Add another food"]);
    for (const [index, footer] of footers.entries()) {
      expect(footer.getAttribute("data-split")).toBe("false");
      expect(footer.className).toMatch(/border-t/);
      expect(footer.lastElementChild).toBe(adds[index]);
      expect(adds[index].textContent).toBe("Add");
      expect(adds[index].className).toMatch(/justify-center/);
    }
    expect(container.querySelector("[data-show-all]")).toBeNull();
  });

  it("splits the footer once a card hides rows: Show all N on the left, Add on the right", () => {
    seed(...Array.from({ length: 8 }, (_, index) =>
      food({ id: `oat-${index}`, name: `Oat ${index}` })));
    const { container } = render(<EatsFoods />);
    const carbs = screen.getByRole("button", { name: "Add carbs food" }).closest<HTMLElement>("[data-list-footer]")!;
    expect(carbs.getAttribute("data-split")).toBe("true");
    const [left, right] = [...carbs.children] as HTMLElement[];
    expect(left.hasAttribute("data-show-all")).toBe(true);
    expect(left.textContent).toContain("Show all 8");
    expect(right.getAttribute("aria-label")).toBe("Add carbs food");
    // One footer row per card: nothing else under the rows, and no second Add.
    expect(container.querySelectorAll("[data-show-all]")).toHaveLength(1);
    expect(container.querySelectorAll('[data-category-add][aria-label="Add carbs food"]')).toHaveLength(1);
    fireEvent.click(left);
    expect(left.getAttribute("aria-expanded")).toBe("true");
    expect(left.textContent).toContain("Show fewer");
  });

  it("uses the same footer on the Avoid list", () => {
    seed(food({ id: "garlic", name: "Garlic", status: "avoid" }));
    const { container } = render(<AvoidFoods />);
    const footer = container.querySelector<HTMLElement>("[data-list-footer]");
    const add = footer?.querySelector<HTMLElement>("[data-category-add]");
    expect(add?.getAttribute("aria-label")).toBe("Add a food to avoid");
    const eats = render(<EatsFoods />).container.querySelector<HTMLElement>("[data-list-footer]");
    expect(footer?.className).toBe(eats?.className);
    expect(add?.className).toBe(eats?.querySelector("[data-category-add]")?.className);
    expect(within(container).getByRole("heading", { name: "Can't eat right now" })).toBeTruthy();
  });
});

/**
 * U13 (owner, 2026-10-04): "if I try to click the favorite star, then it just changes real quick,
 * and that button actually ends up being the remove button". Remove lies over the row and is
 * revealed only by the swipe, the Edit toggle or keyboard focus on the row's face — never by the
 * star taking focus — so the star stays where it is and toggles every time.
 */
describe("the favorite star", () => {
  it("toggles ten times in a row and never reveals Remove", async () => {
    render(<EatsFoods />);
    const star = screen.getByRole("button", { name: "Star Oats" });
    const row = star.closest<HTMLElement>("[data-food-row]")!;
    const remove = removeOf(/Remove Oats from Favorites/);
    const before = { className: star.className, index: [...row.children].indexOf(star) };
    for (let tap = 0; tap < 10; tap += 1) {
      fireEvent.pointerDown(star, { pointerType: "touch", pointerId: 1, clientX: 320, clientY: 100 });
      fireEvent.pointerUp(star, { pointerType: "touch", pointerId: 1, clientX: 320, clientY: 100 });
      star.focus();
      fireEvent.click(star, { detail: 1 });
      await act(async () => {});
      expect(remove.getAttribute("data-revealed")).toBe("false");
      expect(row.getAttribute("data-open")).toBe("false");
      expect(star.className).toBe(before.className);
      expect([...row.children].indexOf(star)).toBe(before.index);
    }
    expect(membership.set).not.toHaveBeenCalled();
  });

  it("is laid out before Remove, which overlays the row instead of joining its flow", () => {
    render(<EatsFoods />);
    const star = screen.getByRole("button", { name: "Star Oats" });
    const remove = removeOf(/Remove Oats from Favorites/);
    expect(star.compareDocumentPosition(remove) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The CSS module's `.remove` is absolutely positioned; the star carries no class that moves it.
    expect(remove.className).toMatch(/remove/);
    expect(star.className).not.toMatch(/remove|revealed/);
  });
});

describe("removeDragStyle", () => {
  it("brings Remove in from the edge over its width, then widens it to follow a full swipe", () => {
    expect(removeDragStyle(0, 72)).toMatchObject({ opacity: 0, width: 72 });
    expect(removeDragStyle(36, 72)).toMatchObject({ opacity: 0.5, transform: "translate(6px, -50%)" });
    expect(removeDragStyle(72, 72)).toMatchObject({ opacity: 1, transform: "translate(0px, -50%)", width: 72 });
    expect(removeDragStyle(150, 72)).toMatchObject({ opacity: 1, width: 150 });
  });
});

/**
 * FluidVoice F01-F09 carry-forward: Eats membership writes use the shared ActionFeedback. A
 * removal confirms in violet with Undo, a failure rolls the row back and shows the shared alert,
 * and the neutral row without a synced row keeps its older clear-marks path, which stays idempotent and keeps the row and its note.
 */
describe("Eats membership feedback", () => {
  const vibrate = vi.fn(() => true);
  beforeEach(() => {
    vibrate.mockClear();
    Object.defineProperty(window.navigator, "vibrate", { configurable: true, value: vibrate });
    membership.set.mockImplementation(async () => ({ truncated: false }));
  });

  it("confirms a removal with Undo, and Undo puts the food back on Eats", async () => {
    render(<EatsFoods />);
    swipe(rowOf("Oats"), -200, 8);
    await act(async () => {});
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Oats removed from Favorites.");
    await act(async () => { fireEvent.click(within(status).getByRole("button", { name: "Undo" })); });
    expect(membership.set).toHaveBeenCalledTimes(2);
    expect(membership.set.mock.calls[1].slice(0, 2)).toEqual(["Oats", "eats"]);
    expect(seeded.foods.oats).toMatchObject({ status: "eats", note: "fine in the morning" });
    expect(rowOf("Oats")).toBeTruthy();
  });

  it("rolls a failed removal back and shows the shared alert without the success haptic", async () => {
    membership.set.mockImplementationOnce(async () => { throw new Error("offline"); });
    render(<EatsFoods />);
    swipe(rowOf("Oats"), -200, 8);
    await act(async () => {});
    const alert = screen.getByRole("alert");
    expect(alert.querySelector('button[aria-label="Dismiss notification"]')).toBeTruthy();
    expect(seeded.foods.oats).toMatchObject({ status: "eats", note: "fine in the morning" });
    expect(removeOf(/Remove Oats from Favorites/)).toBeTruthy();
    expect(vibrate).not.toHaveBeenCalled();
  });

  it("clears marks on a neutral row with no synced row, without Undo, keeping the row and its note", async () => {
    render(<EatsFoods />);
    swipe(rowOf("Rice"), -200);
    await act(async () => {});
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Marks cleared for Rice.");
    expect(within(status).queryByRole("button", { name: "Undo" })).toBeNull();
    expect(seeded.foods.rice).toMatchObject({ status: "neutral", note: "hurt on 9/12" });
    swipe(rowOf("Rice"), -200);
    await act(async () => {});
    expect(membership.set).toHaveBeenCalledTimes(2);
    expect(membership.set.mock.calls.map((call) => call.slice(0, 2)))
      .toEqual([["Rice", null], ["Rice", null]]);
    expect(rowOf("Rice")).toBeTruthy();
  });

  it("hides a synced Other row with Undo, writing no membership", async () => {
    hide.can.mockImplementationOnce(async () => true);
    hide.hide.mockImplementationOnce(async () => {
      const { rice: _rice, ...rest } = seeded.foods; seeded.foods = rest; return true;
    });
    render(<EatsFoods />);
    swipe(rowOf("Rice"), -200);
    await act(async () => {});
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Rice removed from Other foods.");
    expect(hide.hide).toHaveBeenCalledTimes(1);
    expect(membership.set).not.toHaveBeenCalled();
    expect(screen.queryByText("hurt on 9/12")).toBeNull();
    hide.unhide.mockImplementationOnce(async () => {
      seeded.foods = { ...seeded.foods, rice: food({ id: "rice", name: "Rice", status: "neutral", note: "hurt on 9/12" }) };
      return true;
    });
    await act(async () => { fireEvent.click(within(status).getByRole("button", { name: "Undo" })); });
    expect(hide.unhide).toHaveBeenCalledTimes(1);
    expect(screen.getByText("hurt on 9/12")).toBeTruthy();
  });

  it("confirms a sheet status change with Undo that restores the earlier membership", async () => {
    render(<EatsFoods />);
    fireEvent.click(rowOf("Oats"));
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: "Add to Avoid" })); });
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Oats moved to Avoid.");
    expect(seeded.foods.oats.status).toBe("avoid");
    await act(async () => { fireEvent.click(within(status).getByRole("button", { name: "Undo" })); });
    expect(seeded.foods.oats.status).toBe("eats");
    expect(membership.set.mock.calls.at(-1)?.slice(0, 2)).toEqual(["Oats", "eats"]);
  });

  it("does not roll a failed move back over a newer move of the same food", async () => {
    let failFirst!: (error: Error) => void;
    membership.set.mockImplementationOnce(() => new Promise((_resolve, reject) => { failFirst = reject; }));
    render(<EatsFoods />);
    swipe(rowOf("Oats"), -200, 8);
    await act(async () => {});
    expect(seeded.foods.oats.status).toBe("neutral");
    // The newer move, made while the first write is still in flight: back onto Eats from its sheet.
    fireEvent.click(rowOf("Oats"));
    fireEvent.click(await screen.findByRole("button", { name: "Add to Favorites" }));
    expect(seeded.foods.oats.status).toBe("eats");
    // A later local edit of the same food (another screen's write), still in the store.
    seeded.foods = { ...seeded.foods, oats: { ...seeded.foods.oats, status: "avoid" } };
    await act(async () => { failFirst(new Error("offline")); });
    await act(async () => {});
    // The failed first write must not put back "eats" over the newer local state.
    expect(seeded.foods.oats.status).toBe("avoid");
    expect(screen.getByRole("alert")).toBeTruthy();
  });
});

/**
 * UI audit 2026-10-07 (Foods r1 BLOCK): the Avoid list's sheet and its Undo wrote fire-and-forget,
 * so a failed membership write left the row moved locally with no server mark behind it.
 */
describe("Avoid membership feedback", () => {
  beforeEach(() => { seed(food({ id: "garlic", name: "Garlic", status: "avoid", note: "hurt on 9/12" })); });

  it("rolls a failed sheet move back onto Avoid", async () => {
    render(<AvoidFoods />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Garlic" }));
    // The sheet saves its note first; only the status write that follows fails.
    membership.set.mockImplementationOnce(async () => ({ truncated: false }))
      .mockImplementationOnce(async () => { throw new Error("offline"); });
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: "Remove from Avoid" })); });
    await act(async () => {});
    expect(membership.set.mock.calls.at(-1)?.slice(0, 2)).toEqual(["Garlic", null]);
    expect(seeded.foods.garlic).toMatchObject({ status: "avoid", note: "hurt on 9/12" });
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("reports a saved removal to the caller and restores Avoid on Undo", async () => {
    const onAvoidSaved = vi.fn();
    render(<AvoidFoods onAvoidSaved={onAvoidSaved} />);
    swipe(screen.getByRole("button", { name: "Edit Garlic" }), -200, 8);
    await act(async () => {});
    expect(seeded.foods.garlic.status).toBe("neutral");
    expect(onAvoidSaved).toHaveBeenLastCalledWith(expect.objectContaining({ id: "garlic", status: "neutral" }));
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Garlic removed from Avoid.");
    membership.set.mockImplementationOnce(async () => { throw new Error("offline"); });
    await act(async () => { fireEvent.click(within(status).getByRole("button", { name: "Undo" })); });
    await act(async () => {});
    // The Undo's own write failed, so the row goes back to what the server last acknowledged.
    expect(membership.set.mock.calls.at(-1)?.slice(0, 2)).toEqual(["Garlic", "avoid"]);
    expect(seeded.foods.garlic.status).toBe("neutral");
  });
});

/**
 * Sol review of PR #23: a write a newer membership intent superseded (another tap, the coach) was
 * reported as this screen's success with an Undo, and a failed one rolled back over the newer choice.
 */
describe("a superseded membership write", () => {
  it("settles quietly: no confirmation and no Undo", async () => {
    const { reserveFoodMembershipIntent } = await import("@/lib/foods/prefs-client");
    let land!: () => void;
    membership.set.mockImplementationOnce(() => new Promise((resolve) => { land = () => resolve({ truncated: false }); }));
    render(<EatsFoods />);
    swipe(rowOf("Oats"), -200, 8);
    await act(async () => {});
    // Another surface (the coach) marks the same food while this write is in flight.
    reserveFoodMembershipIntent("Oats");
    await act(async () => { land(); });
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(screen.queryByText("Oats removed from Favorites.")).toBeNull();
  });

  it("does not roll back over the newer choice when it fails", async () => {
    const { reserveFoodMembershipIntent } = await import("@/lib/foods/prefs-client");
    let fail!: () => void;
    membership.set.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = () => reject(new Error("offline")); }));
    render(<EatsFoods />);
    swipe(rowOf("Oats"), -200, 8);
    await act(async () => {});
    reserveFoodMembershipIntent("Oats");
    seeded.foods = { ...seeded.foods, oats: { ...seeded.foods.oats, status: "avoid" } };
    await act(async () => { fail(); });
    await act(async () => {});
    expect(seeded.foods.oats.status).toBe("avoid");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("still rolls back after a note edit of the same row", async () => {
    let fail!: () => void;
    membership.set.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = () => reject(new Error("offline")); }));
    render(<EatsFoods />);
    swipe(rowOf("Oats"), -200, 8);
    await act(async () => {});
    seeded.foods = { ...seeded.foods, oats: { ...seeded.foods.oats, note: "crunchy", updatedAt: "2099-01-01T00:00:00.000Z" } };
    await act(async () => { fail(); });
    await act(async () => {});
    expect(seeded.foods.oats).toMatchObject({ status: "eats", note: "crunchy" });
  });

  it("does not roll back over a newer choice of the same status", async () => {
    const { reserveFoodMembershipIntent } = await import("@/lib/foods/prefs-client");
    let fail!: () => void;
    membership.set.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = () => reject(new Error("offline")); }));
    render(<EatsFoods />);
    swipe(rowOf("Oats"), -200, 8);
    await act(async () => {});
    // Another surface clears the same marks again (same status, a newer membership write).
    reserveFoodMembershipIntent("Oats");
    seeded.foods = { ...seeded.foods, oats: { ...seeded.foods.oats, status: "neutral", updatedAt: "2099-01-01T00:00:00.000Z" } };
    await act(async () => { fail(); });
    await act(async () => {});
    expect(seeded.foods.oats.status).toBe("neutral");
  });

  it("offers an Undo that does nothing once the row has moved on", async () => {
    render(<EatsFoods />);
    swipe(rowOf("Oats"), -200, 8);
    await act(async () => {});
    const status = screen.getByRole("status");
    seeded.foods = { ...seeded.foods, oats: { ...seeded.foods.oats, status: "avoid" } };
    const calls = membership.set.mock.calls.length;
    await act(async () => { fireEvent.click(within(status).getByRole("button", { name: "Undo" })); });
    expect(membership.set.mock.calls.length).toBe(calls);
    expect(seeded.foods.oats.status).toBe("avoid");
  });

  it("still rolls back when the newer reservation changed nothing on the phone", async () => {
    const { reserveFoodMembershipIntent } = await import("@/lib/foods/prefs-client");
    let fail!: () => void;
    membership.set.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = () => reject(new Error("offline")); }));
    render(<EatsFoods />);
    swipe(rowOf("Oats"), -200, 8);
    await act(async () => {});
    // The coach reserves, then its own read fails: it writes nothing and moves nothing.
    reserveFoodMembershipIntent("Oats");
    await act(async () => { fail(); });
    await act(async () => {});
    expect(seeded.foods.oats.status).toBe("eats");
  });
});
