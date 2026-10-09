// @vitest-environment jsdom
/**
 * The meal card panel's "+" (upload a meal plan or document): where it sits in log and plan mode,
 * what it accepts and refuses on the phone, and what each kind of document shows in place. A meal
 * plan's matched meal is placed through the same set_slot_meal path as "Put it in Meal N", and
 * only after the tap.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetTestAccount } from "@/tests/helpers/account";
import { DOCUMENT_ACCEPT, UNSUPPORTED_FILE } from "@/lib/plan/document-files";
import type { DocumentPlanResult } from "@/lib/plan/document-types";
import type { ResolvedSlot } from "@/lib/types";

const postTurn = vi.hoisted(() => vi.fn());
// Chips go to POST /api/plan/ideas; this double serves them from the same mocked coach reply.
vi.mock("@/lib/plan/ideas-client", async (original) => ({
  ...(await original<typeof import("@/lib/plan/ideas-client")>()),
  requestPlanIdeas: async (...args: [unknown, { chip: string }]) =>
    (await import("@/tests/helpers/plan-ideas")).ideasFromTurn(postTurn)(...args),
}));
const applyCoachAction = vi.hoisted(() => vi.fn());
const readPlanDocument = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coach-client", async (original) => ({
  ...(await original<typeof import("@/lib/coach-client")>()), postTurn,
}));
vi.mock("@/lib/coach/apply-client", async (original) => ({
  ...(await original<typeof import("@/lib/coach/apply-client")>()), applyCoachAction,
}));
vi.mock("@/lib/recipe-access-client", async (original) => ({
  ...(await original<typeof import("@/lib/recipe-access-client")>()),
  useRecipeAccess: () => ({ enabled: false, loading: false, unavailable: false, retry: vi.fn() }),
}));
vi.mock("@/lib/plan/document-client", async (original) => ({
  ...(await original<typeof import("@/lib/plan/document-client")>()), readPlanDocument,
}));

import PlanSheet from "@/components/PlanSheet";

const slot: ResolvedSlot = {
  slot: "meal-2", label: "Meal 2", time: "12:30", meal: null, components: [],
  macros: { kcal: 0, protein: 0, carbs: 0, fat: 0 }, eaten: false,
};
const item = (name: string, grams: number) => ({ name, grams, foodRefId: `${name}-ref`, catalogFoodRevisionId: 3,
  kcalPer100g: 100, proteinPer100g: 20, carbsPer100g: 0, fatPer100g: 2, verdict: "allowed" as const });
const plan = (days: number): DocumentPlanResult => ({
  kind: "meal_plan", title: "Coach plan",
  days: Array.from({ length: days }, (_, i) => ({ label: i === 0 ? "Monday" : `Day ${i + 1}`, meals: [
    { name: "Breakfast", time: "07:30", foods: [{ name: "oats", amount: "40 g" }] },
    { name: "Lunch", time: "12:30", foods: [{ name: "chicken breast", amount: "150 g" }] },
  ] })),
  match: { day: 0, meal: 1, title: "Lunch", items: [item("chicken breast", 150), item("rice", 158)],
    left: [{ name: "unicorn steak", amount: "100 g", reason: "Not found in the food list" }],
    totals: { kcal: 466, protein: 62, carbs: 0, fat: 6 } },
});

let realRead: typeof import("@/lib/plan/document-client").readPlanDocument;
beforeEach(async () => {
  await resetTestAccount();
  realRead = (await vi.importActual<typeof import("@/lib/plan/document-client")>("@/lib/plan/document-client")).readPlanDocument;
  postTurn.mockReset().mockResolvedValue({ threadId: "t", messages: [], composed: [], suggestions: [], actions: [], draft: null });
  applyCoachAction.mockReset().mockResolvedValue({ status: "applied", token: {} });
  readPlanDocument.mockReset();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in this test"); }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function open(mode: "plan" | "log" = "plan") {
  const onClose = vi.fn();
  const onPlaced = vi.fn();
  render(<PlanSheet date="2026-10-05" slot={slot} mode={mode} target={{ kcal: 620, protein: 45, carbs: 70, fat: 18 }}
    onClose={onClose} onPlaced={onPlaced} onLogged={vi.fn()} />);
  return { onClose, onPlaced };
}

const documentInput = () => document.querySelector('input[data-photo-input="document"]') as HTMLInputElement;
function upload(file: File) {
  fireEvent.change(documentInput(), { target: { files: [file] } });
}

describe("the meal card panel's +", () => {
  it("replaces the inner camera in log mode, under the big camera button, and accepts images and documents", () => {
    open("log");
    expect(screen.getByRole("button", { name: /Snap what you ate/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add a photo or file" }));
    expect(screen.queryByRole("button", { name: "Take a photo" })).toBeNull();
    expect(screen.getByRole("button", { name: "Upload a meal plan or document" })).toBeTruthy();
    expect(documentInput().getAttribute("accept")).toBe(DOCUMENT_ACCEPT);
    expect(DOCUMENT_ACCEPT).toBe("image/*,application/pdf,.pdf,text/plain,.txt,text/csv,.csv");
    expect(documentInput().hasAttribute("capture")).toBe(false);
  });

  it("sits beside the camera in plan mode", async () => {
    open();
    await waitFor(() => expect(postTurn).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Add a photo or file" }));
    expect(screen.getByRole("button", { name: "Take a photo" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Upload a meal plan or document" })).toBeTruthy();
  });

  it("refuses a Word file and an oversized PDF on the phone, with no request", async () => {
    readPlanDocument.mockImplementation((...args: Parameters<typeof realRead>) => realRead(...args));
    open("log");
    upload(new File(["x"], "plan.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }));
    expect((await screen.findByRole("alert")).textContent).toContain(UNSUPPORTED_FILE);
    const big = new File(["%PDF-1.4"], "plan.pdf", { type: "application/pdf" });
    Object.defineProperty(big, "size", { value: 3 * 1024 * 1024 + 1 });
    upload(big);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("That PDF is over 3 MB"));
    expect(fetch).not.toHaveBeenCalled();
    expect(applyCoachAction).not.toHaveBeenCalled();
  });

  it("previews a meal plan in place and places its matched meal only after Use for this meal", async () => {
    readPlanDocument.mockResolvedValueOnce(plan(2));
    const { onPlaced, onClose } = open("log");
    upload(new File(["plan"], "plan.pdf", { type: "application/pdf" }));
    expect(await screen.findByRole("region", { name: "Meal plan" })).toBeTruthy();
    expect(readPlanDocument.mock.calls[0][2]).toEqual({ localDate: "2026-10-05", slot: "meal-2", slotTime: "12:30", targetKcal: 620 });
    expect(screen.getByText("Coach plan")).toBeTruthy();
    expect(screen.getByRole("list", { name: "Plan days" }).textContent).toContain("Breakfast 07:30 · Lunch 12:30");
    expect(screen.getByText("For Meal 2: Lunch (Monday)")).toBeTruthy();
    expect(screen.getByText("chicken breast 150 g · rice 158 g")).toBeTruthy();
    expect(screen.getByText("unicorn steak (100 g): Not found in the food list")).toBeTruthy();
    expect(screen.getByText("Importing a whole plan is coming.")).toBeTruthy();
    expect(applyCoachAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Use for this meal" }));
    await waitFor(() => expect(applyCoachAction).toHaveBeenCalledTimes(1));
    const action = applyCoachAction.mock.calls[0][0];
    expect(action).toMatchObject({ kind: "set_slot_meal", slot: "meal-2", date: "2026-10-05", title: "Lunch", flagged: [] });
    expect(action.items.map((i: { name: string; grams: number }) => [i.name, i.grams]))
      .toEqual([["chicken breast", 150], ["rice", 158]]);
    await waitFor(() => expect(onPlaced).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalled();
  });

  it("says nothing about a whole-plan import for a one-day plan, and disables Use with nothing grounded", async () => {
    const one = plan(1);
    readPlanDocument.mockResolvedValueOnce({ ...one, match: { ...one.match!, items: [], totals: { kcal: 0, protein: 0, carbs: 0, fat: 0 } } });
    open("log");
    upload(new File(["plan"], "plan.txt", { type: "text/plain" }));
    await screen.findByRole("region", { name: "Meal plan" });
    expect(screen.queryByText("Importing a whole plan is coming.")).toBeNull();
    expect(screen.getByRole("button", { name: "Use for this meal" }).hasAttribute("disabled")).toBe(true);
  });

  it("shows a menu document with the menu picks and turns a recipe into a recipe ask", async () => {
    readPlanDocument.mockResolvedValueOnce({ kind: "menu", title: null, ingredients: [], menu: [
      { name: "Salmon plate", kcal: 590, protein: 40, carbs: 40, fat: 20, tip: null, check: null }] })
      .mockResolvedValueOnce({ kind: "recipe", title: "Lemon chicken", ingredients: ["chicken breast", "lemon"] });
    open();
    await waitFor(() => expect(postTurn).toHaveBeenCalledTimes(1));
    upload(new File(["m"], "menu.pdf", { type: "application/pdf" }));
    expect(await screen.findByRole("heading", { name: "Best picks for the 620 kcal left" })).toBeTruthy();
    // A document has no photo to re-read: no "Not right?" switch line.
    expect(screen.queryByLabelText("Not right?")).toBeNull();
    upload(new File(["r"], "recipe.txt", { type: "text/plain" }));
    await waitFor(() => expect(postTurn).toHaveBeenCalledTimes(2));
    expect(postTurn.mock.calls[1][0].planSource).toEqual({ title: "Lemon chicken", ingredients: ["chicken breast", "lemon"] });
    expect(await screen.findByText(/From “Lemon chicken”/)).toBeTruthy();
  });

  it("says when a file holds no plan, recipe or menu", async () => {
    readPlanDocument.mockResolvedValueOnce({ kind: "other" });
    open("log");
    upload(new File(["x"], "notes.txt", { type: "text/plain" }));
    expect(await screen.findByText(/couldn’t find a meal plan, recipe or menu/)).toBeTruthy();
  });
});
