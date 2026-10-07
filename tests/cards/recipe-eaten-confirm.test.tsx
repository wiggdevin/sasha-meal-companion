// @vitest-environment jsdom
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import RecipeEatenConfirm from "@/components/RecipeEatenConfirm";
import { bindAccount, markAccountReady, unbindAccount } from "@/lib/device/account";
import type { AcceptedRecipeSelection } from "@/lib/shopping/preview-contract";

const mocks = vi.hoisted(() => ({ preview: vi.fn(), accept: vi.fn(), saveEaten: vi.fn(), read: vi.fn() }));
vi.mock("@/lib/recipe-plan-client", () => ({ previewRecipePlan: mocks.preview, acceptRecipePlan: mocks.accept }));
vi.mock("@/lib/plan-day-client", () => ({ saveRecipeEatenSlot: mocks.saveEaten }));
vi.mock("@/lib/recipes/accepted-client", () => ({ loadAcceptedRecipeSelections: mocks.read }));

const selection = { id: "accepted", localDate: "2026-09-27", slotId: "meal-3",
  recipeId: "recipe", recipeRevisionId: "recipe-v1", recipeName: "Stew", servingFraction: 1,
  nutritionSnapshot: Object.fromEntries(Object.entries({ kcal: 300, protein: 20, carbs: 40, fat: 8 })
    .map(([key, value]) => [key, { value, status: "estimated", sourceRevisionId: null }])),
  ingredientSnapshot: [], exactFitAvailable: false, approximateFitAvailable: true,
  evidenceIssues: [], planRevision: 1 } as AcceptedRecipeSelection;

beforeEach(() => {
  unbindAccount(); markAccountReady(bindAccount("11111111-1111-4111-8111-111111111111"));
  mocks.saveEaten.mockResolvedValue({});
  mocks.read.mockResolvedValue([selection]);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); unbindAccount(); });

it("confirms under StrictMode after effect setup and cleanup replay", async () => {
  const onLogged = vi.fn();
  render(<StrictMode><RecipeEatenConfirm selection={selection} currentSelection={selection}
    date={selection.localDate} slotId="meal-3" onClose={vi.fn()} onLogged={onLogged} /></StrictMode>);
  fireEvent.click(screen.getByRole("button", { name: "Confirm eaten amount" }));
  await waitFor(() => expect(mocks.saveEaten).toHaveBeenCalledOnce());
  await waitFor(() => expect(onLogged).toHaveBeenCalledOnce());
});

it("confirms the actual planned serving and saves one immutable recipe portion before marking eaten", async () => {
  const onLogged = vi.fn();
  render(<RecipeEatenConfirm selection={selection} date={selection.localDate} slotId="meal-3"
    onClose={vi.fn()} onLogged={onLogged} />);
  expect(screen.getByRole("spinbutton", { name: "Servings eaten" })).toHaveProperty("value", "1");
  fireEvent.click(screen.getByRole("button", { name: "Confirm eaten amount" }));
  await waitFor(() => expect(onLogged).toHaveBeenCalledOnce());
  expect(mocks.preview).not.toHaveBeenCalled();
  expect(mocks.read).toHaveBeenCalledWith("2026-09-27", "2026-09-27");
  expect(mocks.saveEaten).toHaveBeenCalledWith("2026-09-27", "meal-3", selection,
    1, expect.any(String));
});

it("logs a quarter serving from the immutable accepted snapshot without changing the plan", async () => {
  const accepted = { ...selection, servingFraction: 1.7847,
    nutritionSnapshot: Object.fromEntries(Object.entries(selection.nutritionSnapshot).map(([key, value]) =>
      [key, { ...value, value: value.value! * 1.7847 }])) } as AcceptedRecipeSelection;
  const original = structuredClone(accepted);
  mocks.read.mockResolvedValue([accepted]);
  render(<RecipeEatenConfirm selection={accepted} date={accepted.localDate} slotId="meal-3"
    onClose={vi.fn()} onLogged={vi.fn()} />);
  fireEvent.change(screen.getByRole("spinbutton", { name: "Servings eaten" }), { target: { value: "0.25" } });
  const nutrition = screen.getByText(/Nutrition scaled from your accepted portion/);
  expect(nutrition.textContent).toContain("75 calories");
  fireEvent.click(screen.getByRole("button", { name: "Confirm eaten amount" }));
  await waitFor(() => expect(mocks.saveEaten).toHaveBeenCalledOnce());
  expect(mocks.preview).not.toHaveBeenCalled();
  expect(mocks.accept).not.toHaveBeenCalled();
  expect(mocks.saveEaten.mock.calls[0][3]).toBe(0.25);
  expect(accepted).toEqual(original);
});

it("closes an open sheet when the same account has accepted a newer selection", async () => {
  const onClose = vi.fn();
  const newer = { ...selection, id: "new-accepted", servingFraction: 1.5 };
  mocks.read.mockResolvedValue([newer]);
  render(<RecipeEatenConfirm selection={selection} currentSelection={selection}
    date={selection.localDate} slotId="meal-3" onClose={onClose} onLogged={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Confirm eaten amount" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(mocks.saveEaten).not.toHaveBeenCalled();
});

it("closes when a Today refresh observes a replacement while the sheet is open", async () => {
  const onClose = vi.fn();
  const view = render(<RecipeEatenConfirm selection={selection} currentSelection={selection}
    date={selection.localDate} slotId="meal-3" onClose={onClose} onLogged={vi.fn()} />);
  view.rerender(<RecipeEatenConfirm selection={selection} currentSelection={{ ...selection, id: "new-accepted" }}
    date={selection.localDate} slotId="meal-3" onClose={onClose} onLogged={vi.fn()} />);
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(mocks.saveEaten).not.toHaveBeenCalled();
});

it("does not write if a same-account replacement arrives during the validation request", async () => {
  let finish!: (rows: AcceptedRecipeSelection[]) => void;
  mocks.read.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const onClose = vi.fn();
  const view = render(<RecipeEatenConfirm selection={selection} currentSelection={selection}
    date={selection.localDate} slotId="meal-3" onClose={onClose} onLogged={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Confirm eaten amount" }));
  await waitFor(() => expect(mocks.read).toHaveBeenCalledOnce());
  view.rerender(<RecipeEatenConfirm selection={selection} currentSelection={{ ...selection,
    id: "replacement" }} date={selection.localDate} slotId="meal-3"
    onClose={onClose} onLogged={vi.fn()} />);
  finish([selection]);
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(mocks.saveEaten).not.toHaveBeenCalled();
});

it("retries only the eaten write after failure", async () => {
  mocks.saveEaten.mockRejectedValueOnce(new Error("Offline"));
  const onLogged = vi.fn();
  render(<RecipeEatenConfirm selection={selection} date={selection.localDate} slotId="meal-3"
    onClose={vi.fn()} onLogged={onLogged} />);
  fireEvent.change(screen.getByRole("spinbutton", { name: "Servings eaten" }), { target: { value: "0.25" } });
  fireEvent.click(screen.getByRole("button", { name: "Confirm eaten amount" }));
  await screen.findByRole("alert");
  expect(onLogged).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm eaten amount" }));
  await waitFor(() => expect(onLogged).toHaveBeenCalledOnce());
  expect(mocks.saveEaten).toHaveBeenCalledTimes(2);
  expect(mocks.saveEaten.mock.calls[1][4]).toBe(mocks.saveEaten.mock.calls[0][4]);
  expect(mocks.preview).not.toHaveBeenCalled();
  expect(mocks.accept).not.toHaveBeenCalled();
});

it("rejects missing nutrition without fabricating zero or saving history", async () => {
  const incomplete = { ...selection, nutritionSnapshot: { ...selection.nutritionSnapshot,
    carbs: { value: null, status: "unknown" as const, sourceRevisionId: null } } };
  render(<RecipeEatenConfirm selection={incomplete} date={selection.localDate} slotId="meal-3"
    onClose={vi.fn()} onLogged={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Confirm eaten amount" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent",
    "This accepted portion has missing nutrition. Log the foods you ate instead.");
  expect(mocks.saveEaten).not.toHaveBeenCalled();
});

it("does not complete a prior account's pending eaten write after account switch", async () => {
  let finish!: (value: object) => void;
  mocks.saveEaten.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const onLogged = vi.fn();
  render(<RecipeEatenConfirm selection={selection} date={selection.localDate} slotId="meal-3"
    onClose={vi.fn()} onLogged={onLogged} />);
  fireEvent.click(screen.getByRole("button", { name: "Confirm eaten amount" }));
  await waitFor(() => expect(mocks.saveEaten).toHaveBeenCalledOnce());
  unbindAccount(); markAccountReady(bindAccount("22222222-2222-4222-8222-222222222222"));
  finish({});
  await waitFor(() => expect(screen.getByRole("button", { name: "Confirm eaten amount" })).toHaveProperty("disabled", false));
  expect(onLogged).not.toHaveBeenCalled();
  expect(mocks.preview).not.toHaveBeenCalled();
  expect(mocks.accept).not.toHaveBeenCalled();
});
