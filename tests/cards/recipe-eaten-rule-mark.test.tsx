// @vitest-environment jsdom
/**
 * The recipe eaten confirm and the rules (2026-10-05, contract #380). Before logging, the sheet shows
 * the slot's current mark; it never blocks the log. The consumed POST answers with the recipe's mark
 * under the CURRENT rules: with one, the sheet stays open on it, the one primary confirms "Logged" in
 * place and then reads Done; every way out then reports the log. With none, it closes as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import RecipeEatenConfirm from "@/components/RecipeEatenConfirm";
import { bindAccount, markAccountReady, unbindAccount } from "@/lib/device/account";
import type { AcceptedRecipeSelection } from "@/lib/shopping/preview-contract";
import type { RuleMark } from "@/lib/types";

const mocks = vi.hoisted(() => ({ saveEaten: vi.fn(), read: vi.fn() }));
vi.mock("@/lib/plan-day-client", () => ({ saveRecipeEatenSlot: mocks.saveEaten }));
vi.mock("@/lib/recipes/accepted-client", () => ({ loadAcceptedRecipeSelections: mocks.read }));

const selection = { id: "accepted", localDate: "2026-10-05", slotId: "meal-2",
  recipeId: "recipe", recipeRevisionId: "recipe-v1", recipeName: "Satay bowl", servingFraction: 1,
  nutritionSnapshot: Object.fromEntries(Object.entries({ kcal: 500, protein: 30, carbs: 50, fat: 18 })
    .map(([key, value]) => [key, { value, status: "estimated", sourceRevisionId: null }])),
  ingredientSnapshot: [], exactFitAvailable: true, approximateFitAvailable: true,
  evidenceIssues: [], planRevision: 1 } as AcceptedRecipeSelection;
const BLOCKED: RuleMark = { verdict: "blocked", reason: "Peanut sauce has peanut, which your rules exclude." };
const UNCHECKED: RuleMark = { verdict: "unknown",
  reason: "This recipe could not be checked against your current food rules." };

function sheet(ruleMark?: RuleMark | null) {
  const onLogged = vi.fn();
  const onClose = vi.fn();
  render(<RecipeEatenConfirm selection={selection} date={selection.localDate} slotId="meal-2"
    ruleMark={ruleMark} onClose={onClose} onLogged={onLogged} />);
  return { onLogged, onClose };
}

beforeEach(() => {
  unbindAccount(); markAccountReady(bindAccount("11111111-1111-4111-8111-111111111111"));
  mocks.read.mockResolvedValue([selection]);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); unbindAccount(); });

describe("RecipeEatenConfirm rule marks", () => {
  it("shows the slot's mark before logging and still lets the log go ahead", async () => {
    mocks.saveEaten.mockResolvedValue({ day: {}, ruleMark: null });
    const { onLogged } = sheet(BLOCKED);
    expect(document.querySelector("[data-recipe-rule-mark]")?.textContent).toContain(BLOCKED.reason);
    // Shown before logging, but read in place: nothing is announced until the server answers.
    expect(document.querySelector("[data-recipe-rule-status]")?.textContent).toBe("");
    const confirm = screen.getByRole("button", { name: "Confirm eaten amount" });
    expect(confirm).toHaveProperty("disabled", false);
    fireEvent.click(confirm);
    await waitFor(() => expect(onLogged).toHaveBeenCalledOnce());
  });

  it("stays open on a blocked answer: Logged in place, then Done reports the log", async () => {
    mocks.saveEaten.mockResolvedValue({ day: {}, ruleMark: BLOCKED });
    const { onLogged, onClose } = sheet(null);
    expect(document.querySelector("[data-recipe-rule-mark]")).toBeNull();
    const announcer = document.querySelector("[data-recipe-rule-status]") as HTMLElement;
    // In the page, empty, before anything arrives, so the verdict is announced when it does.
    expect(announcer.getAttribute("role")).toBe("status");
    expect(announcer.textContent).toBe("");
    const primary = screen.getByRole("button", { name: "Confirm eaten amount" });
    fireEvent.click(primary);
    await waitFor(() => expect(screen.getByRole("button", { name: "Done" })).toBe(primary));
    expect(primary.getAttribute("data-status")).toBe("success");
    const statuses = screen.getAllByRole("status").map((region) => region.textContent);
    expect(statuses).toContain("Logged");
    expect(statuses).toContain(`Off your rules: ${BLOCKED.reason}`);
    expect(document.querySelector("[data-recipe-rule-status]")).toBe(announcer);
    const mark = document.querySelector("[data-recipe-rule-mark]");
    expect(mark?.getAttribute("data-recipe-rule-mark")).toBe("blocked");
    expect(mark?.textContent).toContain("Off your rules");
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(onLogged).not.toHaveBeenCalled();
    fireEvent.click(primary);
    expect(onLogged).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    expect(mocks.saveEaten).toHaveBeenCalledOnce();
  });

  it("shows an unknown answer as Check, and closing the sheet still reports the log", async () => {
    mocks.saveEaten.mockResolvedValue({ day: {}, ruleMark: UNCHECKED });
    const { onLogged, onClose } = sheet(undefined);
    fireEvent.click(screen.getByRole("button", { name: "Confirm eaten amount" }));
    await screen.findByRole("button", { name: "Done" });
    expect(document.querySelector("[data-recipe-rule-mark]")?.textContent).toContain("Check");
    expect(document.querySelector("[data-recipe-rule-status]")?.textContent).toBe(`Check: ${UNCHECKED.reason}`);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(onLogged).toHaveBeenCalledOnce());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes at once when the answer carries no mark", async () => {
    mocks.saveEaten.mockResolvedValue({ day: {}, ruleMark: null });
    const { onLogged } = sheet(null);
    fireEvent.click(screen.getByRole("button", { name: "Confirm eaten amount" }));
    await waitFor(() => expect(onLogged).toHaveBeenCalledOnce());
    expect(document.querySelector("[data-recipe-rule-mark]")).toBeNull();
  });
});
