// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetTestAccount } from "@/tests/helpers/account";
import type { ResolvedSlot } from "@/lib/types";
import type { InspireResult } from "@/lib/plan/inspire-types";

const postTurn = vi.hoisted(() => vi.fn());
const uploadPlanPhoto = vi.hoisted(() => vi.fn());
const readPlanPhoto = vi.hoisted(() => vi.fn());
const proposePlate = vi.hoisted(() => vi.fn());
const proposeDescribed = vi.hoisted(() => vi.fn());
const commitPanelDraft = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coach-client", async (original) => ({
  ...(await original<typeof import("@/lib/coach-client")>()), postTurn,
}));
vi.mock("@/lib/recipe-access-client", async (original) => ({
  ...(await original<typeof import("@/lib/recipe-access-client")>()),
  useRecipeAccess: () => ({ enabled: false, loading: false, unavailable: false, retry: vi.fn() }),
}));
vi.mock("@/lib/plan/inspire-client", async (original) => ({
  ...(await original<typeof import("@/lib/plan/inspire-client")>()), uploadPlanPhoto, readPlanPhoto,
}));
vi.mock("@/lib/plan/photo-log", async (original) => ({
  ...(await original<typeof import("@/lib/plan/photo-log")>()), proposePlate, proposeDescribed, commitPanelDraft,
}));
vi.mock("@/components/coach/editors/useCaptureRevisions", () => ({
  useCaptureRevisions: () => ({ portions: {}, revisions: {}, alternativeRevisions: {} }),
}));
import { captureProposal } from "@/tests/coach/editors/fixtures";

import PlanSheet from "@/components/PlanSheet";
import { MealDetail } from "@/components/SlotCardDetail";

const slot: ResolvedSlot = {
  slot: "meal-2", label: "Meal 2", time: "12:30", meal: null, components: [],
  macros: { kcal: 0, protein: 0, carbs: 0, fat: 0 }, eaten: false,
};
const IMAGE = new Blob(["x"], { type: "image/jpeg" });
const plate: InspireResult = { kind: "plate", title: "Chicken rice bowl", ingredients: ["chicken breast"],
  plate: { title: "Chicken rice bowl", kcal: 600, protein: 40, carbs: 60, fat: 20,
    items: [{ name: "chicken breast", grams: 150 }, { name: "white rice", grams: 200 }] } };
const menu: InspireResult = { kind: "menu", title: null, ingredients: [], menu: [
  { name: "Grilled salmon", kcal: 580, protein: 42, carbs: 30, fat: 28, tip: "Dressing on the side",
    check: "Ask about peanut" },
  { name: "Chicken wrap", kcal: 640, protein: 38, carbs: 60, fat: 22, tip: null, check: null },
] };

/** A capture's draft waiting to be checked: what the capture editor shows before anything logs. */
function pending(method: "photo" | "text") {
  return { draft: { ...captureProposal, method, items: captureProposal.items.map((item) =>
    ({ ...item, policy: { verdict: "allowed" as const } })) },
  slot: "meal-2", at: { localDate: "2026-09-26", tz: "UTC", eatenAt: new Date("2026-09-26T12:30:00") } };
}

/** Open a menu pick's card in place from the carousel (it grows into its larger card, U26). */
function openPick(name: string, list = screen.getByRole("list", { name: "Menu picks" })) {
  const card = within(list).getAllByRole("button", { expanded: false })
    .find((button) => button.closest("[data-recipe-card]")?.textContent?.includes(name))!;
  fireEvent.click(card);
  expect(within(list).getByRole("group", { name })).toBeTruthy();
}

/** The review's "Log it" (the capture editor's), once the draft is on show. Nothing is logged before it. */
async function confirmReview() {
  const review = await screen.findByRole("region", { name: "Check before logging to Meal 2" });
  expect(commitPanelDraft).not.toHaveBeenCalled();
  expect(review.textContent).toContain("Roast chicken");
  fireEvent.click(within(review).getByRole("button", { name: "Log it" }));
  await waitFor(() => expect(commitPanelDraft).toHaveBeenCalledTimes(1));
  return review;
}

beforeEach(async () => {
  await resetTestAccount();
  postTurn.mockReset().mockResolvedValue({ threadId: "t", messages: [], composed: [], suggestions: [],
    actions: [], draft: null });
  uploadPlanPhoto.mockReset().mockResolvedValue({ image: IMAGE, mediaPath: "media/a/b.jpg" });
  readPlanPhoto.mockReset();
  proposePlate.mockReset().mockResolvedValue({ ok: true, pending: pending("photo") });
  proposeDescribed.mockReset().mockResolvedValue({ ok: true, pending: pending("text") });
  commitPanelDraft.mockReset().mockResolvedValue({ ok: true, date: "2026-09-26" });
});
afterEach(cleanup);

function open(mode: "plan" | "log" = "plan") {
  const onClose = vi.fn();
  const onLogged = vi.fn();
  render(<PlanSheet date="2026-09-26" slot={slot} mode={mode}
    target={{ kcal: 620, protein: 45, carbs: 70, fat: 18 }}
    onClose={onClose} onPlaced={vi.fn()} onLogged={onLogged} />);
  return { onClose, onLogged };
}

function snap() {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(["x"], "plate.jpg", { type: "image/jpeg" })] } });
}

describe("Plan sheet photos", () => {
  it("offers to log a plate to this meal with a portion adjuster, through the capture log path", async () => {
    readPlanPhoto.mockResolvedValueOnce(plate);
    const { onClose, onLogged } = open();
    await waitFor(() => expect(postTurn).toHaveBeenCalledTimes(1));
    snap();
    expect(await screen.findByRole("heading", { name: "Log this as Meal 2?" })).toBeTruthy();
    expect(readPlanPhoto.mock.calls[0][3]).toMatchObject({ targetKcal: 620 });
    const full = screen.getByText((_, el) => el?.tagName === "P" && (el.textContent ?? "").startsWith("About"));
    expect(full.textContent).toContain("600");
    expect(full.textContent).toContain("40g");
    expect(full.textContent).toContain("PRO");
    expect(full.textContent).toContain("60g");
    expect(full.textContent).toContain("CAR");
    expect(full.textContent).toContain("20g");
    expect(full.textContent).toContain("FAT");
    fireEvent.click(screen.getByRole("button", { name: "½×" }));
    const halved = screen.getByText((_, el) => el?.tagName === "P" && (el.textContent ?? "").startsWith("About"));
    expect(halved.textContent).toContain("300");
    expect(halved.textContent).toContain("20g");
    expect(halved.textContent).toContain("30g");
    expect(halved.textContent).toContain("10g");
    fireEvent.click(screen.getByRole("button", { name: "Check and log" }));
    await waitFor(() => expect(proposePlate).toHaveBeenCalledTimes(1));
    expect(proposePlate.mock.calls[0].slice(1)).toEqual([IMAGE, "meal-2", 0.5, { date: "2026-09-26", time: "12:30" }]);
    // The capture's own foods are on show, and nothing is logged until "Log it" (AI audit B3).
    const review = await confirmReview();
    expect(commitPanelDraft.mock.calls[0][1]).toMatchObject({ slot: "meal-2" });
    // The button confirms in place, then the flow closes.
    expect(await within(review).findByRole("status", {}, { timeout: 2000 })).toBeTruthy();
    await waitFor(() => expect(onLogged).toHaveBeenCalledWith("2026-09-26"), { timeout: 5000 });
    expect(onClose).toHaveBeenCalled();
    // A plate is not a planning ask: no coach turn followed the photo.
    expect(postTurn).toHaveBeenCalledTimes(1);
  });

  it("shows a menu's best picks for the slot, and a tap logs that dish to this meal", async () => {
    readPlanPhoto.mockResolvedValueOnce(menu);
    const { onLogged } = open();
    snap();
    expect(await screen.findByRole("heading", { name: "Best picks for the 620 kcal left" })).toBeTruthy();
    // Image cards in an x-only carousel; a tap opens the larger card in place, which logs.
    const list = screen.getByRole("list", { name: "Menu picks" });
    expect(list.className).toMatch(/\boverscroll-x-contain\b/);
    expect(within(list).getAllByRole("button", { expanded: false })).toHaveLength(2);
    expect(screen.getByText("Tip: Dressing on the side")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Log Grilled salmon" })).toBeNull();
    openPick("Grilled salmon");
    expect(screen.getByText("Ask about peanut")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Log Grilled salmon" }));
    await waitFor(() => expect(proposeDescribed).toHaveBeenCalledTimes(1));
    expect(proposeDescribed.mock.calls[0].slice(1)).toEqual(["Grilled salmon", "meal-2", { date: "2026-09-26", time: "12:30" }]);
    await confirmReview();
    await waitFor(() => expect(onLogged).toHaveBeenCalledTimes(1), { timeout: 5000 });
  });

  it("drops a checked draft on Dismiss without logging it", async () => {
    readPlanPhoto.mockResolvedValueOnce(menu);
    const { onLogged } = open();
    snap();
    openPick("Grilled salmon", await screen.findByRole("list", { name: "Menu picks" }));
    fireEvent.click(await screen.findByRole("button", { name: "Log Grilled salmon" }));
    const review = await screen.findByRole("region", { name: "Check before logging to Meal 2" });
    fireEvent.click(within(review).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Check before logging to Meal 2" })).toBeNull());
    expect(commitPanelDraft).not.toHaveBeenCalled();
    expect(onLogged).not.toHaveBeenCalled();
  });

  it("keeps a failed log on screen with its reason and does not close", async () => {
    readPlanPhoto.mockResolvedValueOnce(menu);
    commitPanelDraft.mockResolvedValueOnce({ ok: false, message: "Not logged: peanuts is off your rules." });
    const { onClose } = open();
    snap();
    openPick("Chicken wrap", await screen.findByRole("list", { name: "Menu picks" }));
    fireEvent.click(await screen.findByRole("button", { name: "Log Chicken wrap" }));
    await confirmReview();
    expect(await screen.findByText(/Not logged: peanuts/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("says why a capture had nothing to check, and logs nothing", async () => {
    readPlanPhoto.mockResolvedValueOnce(menu);
    proposeDescribed.mockResolvedValueOnce({ ok: false, message: "I couldn’t match that to foods." });
    open();
    snap();
    openPick("Chicken wrap", await screen.findByRole("list", { name: "Menu picks" }));
    fireEvent.click(await screen.findByRole("button", { name: "Log Chicken wrap" }));
    expect((await screen.findByRole("alert")).textContent).toContain("I couldn’t match that");
    expect(commitPanelDraft).not.toHaveBeenCalled();
  });

  it("routes ingredients to meal ideas, and the switch line re-reads the same upload", async () => {
    readPlanPhoto.mockResolvedValueOnce({ kind: "ingredients", title: null, ingredients: ["eggs", "spinach"] })
      .mockResolvedValueOnce(plate);
    open();
    await waitFor(() => expect(postTurn).toHaveBeenCalledTimes(1));
    snap();
    await waitFor(() => expect(postTurn).toHaveBeenCalledTimes(2));
    expect(postTurn.mock.calls[1][0].planSource).toEqual({ title: null, ingredients: ["eggs", "spinach"] });
    expect(await screen.findByText(/From your photo/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cook from it instead" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Log it instead" }));
    expect(await screen.findByRole("heading", { name: "Log this as Meal 2?" })).toBeTruthy();
    expect(uploadPlanPhoto).toHaveBeenCalledTimes(1);
    expect(readPlanPhoto.mock.calls[1][1]).toBe("media/a/b.jpg");
    expect(readPlanPhoto.mock.calls[1][3]).toMatchObject({ as: "plate" });
  });

  it("opens in log mode camera first, sends no planning turn, and logs what was typed", async () => {
    const { onLogged } = open("log");
    expect(screen.getByRole("dialog", { name: "Log Meal 2 · 12:30 pm" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Snap what you ate/ })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Quick picks" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "What you had" }), { target: { value: "a turkey sandwich" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(proposeDescribed).toHaveBeenCalledTimes(1));
    expect(proposeDescribed.mock.calls[0].slice(1)).toEqual(["a turkey sandwich", "meal-2", { date: "2026-09-26", time: "12:30" }]);
    await confirmReview();
    await waitFor(() => expect(onLogged).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(postTurn).not.toHaveBeenCalled();
  });

  it("reads one capture for a double tap on Send, Check and log or a menu pick (audit b4b #3)", async () => {
    const hold = () => new Promise(() => {});
    proposeDescribed.mockImplementation(hold);
    open("log");
    fireEvent.change(screen.getByRole("textbox", { name: "What you had" }), { target: { value: "a turkey sandwich" } });
    const send = screen.getByRole("button", { name: "Send" });
    fireEvent.click(send); fireEvent.click(send);
    await waitFor(() => expect(proposeDescribed).toHaveBeenCalledTimes(1));
    cleanup();

    proposePlate.mockImplementation(hold);
    readPlanPhoto.mockResolvedValueOnce(plate);
    open("log");
    snap();
    const logIt = await screen.findByRole("button", { name: "Check and log" });
    fireEvent.click(logIt); fireEvent.click(logIt);
    await waitFor(() => expect(proposePlate).toHaveBeenCalledTimes(1));
    cleanup();

    proposeDescribed.mockClear();
    readPlanPhoto.mockResolvedValueOnce(menu);
    open();
    snap();
    openPick("Grilled salmon", await screen.findByRole("list", { name: "Menu picks" }));
    const pick = await screen.findByRole("button", { name: "Log Grilled salmon" });
    fireEvent.click(pick); fireEvent.click(pick);
    await waitFor(() => expect(proposeDescribed).toHaveBeenCalledTimes(1));
    expect(proposeDescribed.mock.calls[0][1]).toBe("Grilled salmon");
    expect(commitPanelDraft).not.toHaveBeenCalled();
  });

  it("reads a log-mode photo as a plate", async () => {
    readPlanPhoto.mockResolvedValueOnce(plate);
    open("log");
    snap();
    await screen.findByRole("heading", { name: "Log this as Meal 2?" });
    expect(readPlanPhoto.mock.calls[0][3]).toMatchObject({ as: "plate" });
  });

  it("puts Ate something else among a planned card's expanded links (cards v4)", () => {
    const onAteElse = vi.fn();
    const zero = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
    render(<MealDetail id="d" label="Meal 2" components={[]} macros={zero} onAsk={vi.fn()} onAteElse={onAteElse} />);
    fireEvent.click(screen.getByRole("button", { name: "Ate something else for Meal 2" }));
    expect(onAteElse).toHaveBeenCalledTimes(1);
    cleanup();
    render(<MealDetail id="d" label="Meal 2" components={[]} macros={zero} onAsk={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Ate something else/ })).toBeNull();
  });
});
