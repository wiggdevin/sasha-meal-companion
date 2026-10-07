// @vitest-environment jsdom
/**
 * Owner, 2026-10-04: "The pop-up when clicking the Add button at the bottom of the food lists needs
 * to come up smoothly; it's a bit jumpy right now." What made it jump, and what holds it still:
 *  - the search box's `autoFocus` fired before the Sheet moved focus to its Close button, so the
 *    field (and a phone keyboard) flashed in and out; the Sheet now starts on `data-autofocus`,
 *    with `preventScroll`, and nothing else takes focus after it;
 *  - the card opens above an Add button at the bottom of a list, placed by its top, so every late
 *    height change (results arriving) shifted it for a frame; it now hangs from its bottom edge;
 *  - the results region reserves a floor and animates its height instead of snapping.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { __resetScrollLockForTests } from "@/lib/dom/scroll-lock";
import { TEST_USER } from "@/tests/helpers/account";

const search = vi.hoisted(() => vi.fn());
vi.mock("@/lib/catalog-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/catalog-client")>();
  return { ...actual, createSearchController: () => ({ search, cancel: () => undefined }) };
});

const { default: AddFoodSheet } = await import("@/components/AddFoodSheet");

function ListWithAdd() {
  const [adding, setAdding] = useState(false);
  return <>
    <button type="button" onClick={() => setAdding(true)}>Add</button>
    {adding && <AddFoodSheet existing={{}} onAdd={() => undefined} onClose={() => setAdding(false)} />}
  </>;
}

beforeEach(() => { unbindAccount(); bindAccount(TEST_USER); search.mockReset(); });
afterEach(() => { cleanup(); __resetScrollLockForTests(); vi.restoreAllMocks(); });

function openFromBottomAdd() {
  render(<ListWithAdd />);
  const add = screen.getByRole("button", { name: "Add" });
  // The Add row at the foot of a list, low on a 1024 x 768 window.
  add.getBoundingClientRect = () => ({ top: 640, bottom: 684, left: 16, right: 1008, width: 992,
    height: 44, x: 16, y: 640, toJSON: () => ({}) });
  add.focus();
  fireEvent.click(add);
  return screen.getByRole("dialog", { name: "Add a food" });
}

it("starts in the search box without scrolling, and leaves focus there", () => {
  const focus = vi.spyOn(HTMLElement.prototype, "focus");
  openFromBottomAdd();
  const field = screen.getByRole("searchbox", { name: "Search foods" });
  expect(document.activeElement).toBe(field);
  expect(field.hasAttribute("autofocus")).toBe(false);
  // Exactly one focus move on open: the field, with preventScroll. No Close-button detour.
  const opening = focus.mock.calls.filter((_, index) => focus.mock.instances[index] !== screen.getByRole("button", { name: "Add" }));
  expect(opening).toEqual([[{ preventScroll: true }]]);
});

it("opens above the Add button and hangs from its bottom edge", () => {
  // jsdom lays nothing out: give the card the 400 px a phone gives it, so it fits only above.
  const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")!;
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true,
    get(this: HTMLElement) { return this.classList.contains("sheet-surface") ? 400 : 0; } });
  let dialog: HTMLElement;
  try { dialog = openFromBottomAdd(); } finally {
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeight);
  }
  const card = dialog.querySelector<HTMLElement>(".sheet-surface")!;
  expect(card.getAttribute("data-popover-side")).toBe("above");
  expect(card.style.top).toBe("auto");
  // 768 (window) - (640 - 8): the card's bottom edge sits 8 px above the Add button.
  expect(card.style.bottom).toBe(`${768 - 632}px`);
  // It scales out of the Add button's centre.
  expect(card.style.transformOrigin).toMatch(/px .*px/);
});

it("reserves room for results and animates its height as they arrive", async () => {
  let answer: (value: unknown) => void = () => {};
  search.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
  const dialog = openFromBottomAdd();
  const region = dialog.querySelector<HTMLElement>("[data-auto-height]");
  expect(region).not.toBeNull();
  expect(region!.className).toContain("min-h-72");
  fireEvent.change(screen.getByRole("searchbox", { name: "Search foods" }), { target: { value: "oats" } });
  expect(region!.textContent).toContain("Searching…");
  answer({ kind: "offline", reason: "no_match", hits: [] });
  expect(await screen.findByText(/Nothing matches/)).toBeTruthy();
  expect(region!.contains(screen.getByText(/Nothing matches/))).toBe(true);
});
