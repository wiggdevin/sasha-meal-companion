import { describe, expect, it, vi } from "vitest";
import { buildCandidates } from "@/lib/shopping/build-candidates";
import { buildReducer, canSwapMeals, initialBuildState, MAX_MEAL_ROUNDS, newSaveProgress, previewInput,
  planDraftProblem, runSave, SAVE_TARGET_CHANGED, savePlan, saveSummary, saveTarget, swappableRecipeIds, type BuildAction, type BuildState, type MealCard,
  type SaveDeps } from "@/lib/shopping/build-flow";
import { defaultShoppingDraft, type ShoppingDraft } from "@/lib/shopping/contracts";

const draft = { ...defaultShoppingDraft("2026-10-20", "UTC"), mealCoverage: ["meal-1", "meal-3"] };
const run = (state: BuildState, ...actions: BuildAction[]) => actions.reduce(buildReducer, state);
const meal = (date: string, slotId: string, recipeId: string): MealCard =>
  ({ key: `${date}|${slotId}|${recipeId}`, recipeId, name: `Recipe ${recipeId}`, date, slotId, kcal: 500, proteinG: 30 });

function withDeck(names: string[], extra: Parameters<typeof buildCandidates>[0] = { sources: [], avoid: [], pantry: [], listed: [] }) {
  const built = buildCandidates({ ...extra, sources: [...extra.sources, ...names.map((name) => ({ name, source: "favored" as const }))] });
  return run(initialBuildState(draft), { type: "next" },
    { type: "deck-loaded", cards: built.candidates, leftOutByRules: built.leftOutByRules, total: built.total,
      provenance: { ai: false, source: "app" } });
}
function atMeals(state: BuildState, cards: MealCard[]) {
  const moved = run(state, { type: "yes-to-rest" }, { type: "next" });
  return run(moved, { type: "preview-loaded", request: moved.meals.request, previewId: "p1", cards });
}

describe("the build flow reducer", () => {
  it("never offers an Avoid food and leaves blocked foods out with a count", () => {
    const state = withDeck([], { sources: [
      { name: "Peanuts", source: "favored" }, { name: "Eggs", source: "favored" },
      { name: "Shrimp", source: "eaten", ruleMark: { verdict: "blocked", reason: "Shellfish." } }],
    avoid: ["Peanuts"], pantry: [], listed: [] });
    expect(state.ingredients.cards.map((card) => card.name)).toEqual(["Eggs"]);
    expect(state.ingredients.leftOutByRules).toBe(1);
  });

  it("answers Yes to the rest from the current card", () => {
    const state = run(withDeck(["A", "B", "C", "D"]), { type: "answer", answer: "no" }, { type: "yes-to-rest" });
    expect(state.ingredients.answers).toEqual({ c1: "no", c2: "yes", c3: "yes", c4: "yes" });
    expect(state.ingredients.index).toBe(4);
  });

  it("goes Back one card, then one step", () => {
    let state = run(withDeck(["A", "B"]), { type: "answer", answer: "yes" });
    state = run(state, { type: "back" });
    expect(state.ingredients.index).toBe(0);
    expect(state.ingredients.answers).toEqual({});
    expect(run(state, { type: "back" }).step).toBe("budget");
    const meals = atMeals(withDeck(["A"]), [meal("2026-10-20", "meal-1", "r1")]);
    expect(run(meals, { type: "back" }).step).toBe("ingredients");
  });

  it("keeps the budget only on the draft and skips it cleanly", () => {
    const set = run(initialBuildState(draft), { type: "budget", amount: 80, currency: "USD" });
    expect(set.draft).toMatchObject({ budgetAmount: 80, currency: "USD" });
    const skipped = run(set, { type: "skip" });
    expect(skipped.step).toBe("ingredients");
    expect(skipped.draft).toMatchObject({ budgetAmount: null, currency: null });
  });

  it("excludes No meals in one re-preview and walks only the replacements", () => {
    let state = atMeals(withDeck(["A"]), [meal("2026-10-20", "meal-1", "r1"), meal("2026-10-20", "meal-3", "r2")]);
    state = run(state, { type: "answer", answer: "yes" }, { type: "answer", answer: "no" });
    expect(canSwapMeals(state)).toBe(true);
    state = run(state, { type: "swap-no-meals" });
    expect(state.meals.status).toBe("loading");
    expect(previewInput(state).excludeRecipeIds).toEqual(["r2"]);
    state = run(state, { type: "preview-loaded", request: state.meals.request, previewId: "p2",
      cards: [meal("2026-10-20", "meal-1", "r1"), meal("2026-10-20", "meal-3", "r3")] });
    expect(state.meals.index).toBe(1);
    expect(state.meals.cards[1].recipeId).toBe("r3");
  });

  it("stops swapping after the 2-round cap and offers Keep these", () => {
    let state = atMeals(withDeck(["A"]), [meal("d", "meal-1", "r0")]);
    for (let round = 1; round <= MAX_MEAL_ROUNDS; round += 1) {
      state = run(state, { type: "answer", answer: "no" }, { type: "swap-no-meals" });
      state = run(state, { type: "preview-loaded", request: state.meals.request, previewId: `p${round}`,
        cards: [meal("d", "meal-1", `r${round}`)] });
    }
    state = run(state, { type: "answer", answer: "no" });
    expect(state.meals.rounds).toBe(MAX_MEAL_ROUNDS);
    expect(canSwapMeals(state)).toBe(false);
    expect(run(state, { type: "swap-no-meals" })).toBe(state);
    expect(run(state, { type: "next" }).step).toBe("meals");
    expect(run(state, { type: "keep-these" }).step).toBe("stores");
  });

  it("ignores a preview answer for an older request", () => {
    const state = run(withDeck(["A"]), { type: "yes-to-rest" }, { type: "next" });
    expect(run(state, { type: "preview-loaded", request: state.meals.request - 1, previewId: "old", cards: [] }))
      .toBe(state);
  });

  it("keeps a recipe said Yes in one slot out of the swap, even when said No in another", () => {
    let state = atMeals(withDeck(["A"]), [meal("d1", "meal-1", "r1"), meal("d2", "meal-1", "r1"), meal("d2", "meal-3", "r2")]);
    state = run(state, { type: "answer", answer: "yes" }, { type: "answer", answer: "no" }, { type: "answer", answer: "no" });
    expect(swappableRecipeIds(state)).toEqual(["r2"]);
    state = run(state, { type: "swap-no-meals" });
    expect(previewInput(state).excludeRecipeIds).toEqual(["r2"]);
  });

  it("offers no swap when every No recipe is also a Yes elsewhere", () => {
    const state = run(atMeals(withDeck(["A"]), [meal("d1", "meal-1", "r1"), meal("d2", "meal-1", "r1")]),
      { type: "answer", answer: "yes" }, { type: "answer", answer: "no" });
    expect(canSwapMeals(state)).toBe(false);
  });

  it("plans the meals again after a budget change", () => {
    let state = atMeals(withDeck(["A"]), [meal("d", "meal-1", "r1")]);
    const request = state.meals.request;
    state = run(state, { type: "budget", amount: 50, currency: "USD" });
    expect(state.meals.status).toBe("idle");
    expect(state.meals.previewId).toBeNull();
    expect(state.meals.request).toBe(request + 1);
    // The same budget again keeps the preview.
    const kept = atMeals(withDeck(["A"]), [meal("d", "meal-1", "r1")]);
    expect(run(kept, { type: "budget", amount: null, currency: null }).meals.previewId).toBe("p1");
  });

  it("saves just the foods when the planner refuses the days", () => {
    let state = run(withDeck(["A", "B"]), { type: "yes-to-rest" }, { type: "next" });
    expect(run(state, { type: "foods-only" }).step).toBe("meals");
    state = run(state, { type: "preview-failed", request: state.meals.request, message: "No recipes fit." });
    state = run(state, { type: "foods-only" });
    expect(state.step).toBe("stores");
    state = run(state, { type: "skip" }, { type: "title", title: "Foods" });
    expect(saveSummary(state)).toBe("2 items · no meals");
    expect(savePlan(state)).toMatchObject({ title: "Foods", draft: { title: "Foods" } });
    expect(savePlan(state)?.previewId).toBeUndefined();
    const edited = run(state, { type: "edit-plan", draft: { ...draft, endDate: "2026-10-22" } });
    expect(edited.meals).toMatchObject({ skipped: false, status: "loading" });
  });

  it("plans meals again after Try again, even once foods-only was chosen", () => {
    let state = run(withDeck(["A"]), { type: "yes-to-rest" }, { type: "next" });
    state = run(state, { type: "preview-failed", request: state.meals.request, message: "Offline." },
      { type: "foods-only" }, { type: "back" });
    state = run(state, { type: "retry-preview" });
    expect(state.meals).toMatchObject({ skipped: false, status: "loading" });
    state = run(state, { type: "preview-loaded", request: state.meals.request, previewId: "p9",
      cards: [meal("2026-10-20", "meal-1", "r1")] });
    expect(savePlan(state)).toMatchObject({ previewId: "p9" });
  });

  it("refuses more than 31 days for a preview", () => {
    expect(planDraftProblem({ ...draft, endDate: "2026-11-19" })).toBeNull();
    expect(planDraftProblem({ ...draft, endDate: "2026-11-20" })).toBe("Pick 31 days or fewer.");
  });

  it("picks at most 5 stores", () => {
    let state = initialBuildState(draft);
    for (let index = 0; index < 7; index += 1) {
      state = run(state, { type: "toggle-store", store: { id: `s${index}`, name: `Store ${index}`, lat: 0, lon: 0, distanceM: 1 } });
    }
    expect(state.stores).toHaveLength(5);
  });

  it("makes no write before Save", async () => {
    const deps: SaveDeps = { accept: vi.fn(), create: vi.fn(), rename: vi.fn(), addLine: vi.fn(), newId: () => "id" };
    let state = atMeals(withDeck(["A", "B"]), [meal("d", "meal-1", "r1")]);
    state = run(state, { type: "yes-to-rest" }, { type: "next" }, { type: "skip" }, { type: "title", title: "Big shop" });
    expect(state.step).toBe("save");
    expect(saveSummary(state)).toBe("2 items · 1 meal");
    expect(deps.accept).not.toHaveBeenCalled();
    expect(deps.create).not.toHaveBeenCalled();
    expect(deps.rename).not.toHaveBeenCalled();
    expect(deps.addLine).not.toHaveBeenCalled();
  });
});

describe("Save list", () => {
  function deps(over: Partial<SaveDeps> = {}): SaveDeps & { periods: string[] } {
    let next = 0;
    const periods: string[] = [];
    const titles = new Map<string, string | null>();
    return {
      periods,
      accept: vi.fn(async (_preview: string, requestId: string) => {
        if (!periods.includes(requestId)) periods.push(requestId);
        return { period: { id: "period-1", revision: 1 }, lines: [{ name: "Rice" }] };
      }),
      create: vi.fn(async (_draft: ShoppingDraft, requestId: string) => {
        if (!periods.includes(requestId)) periods.push(requestId);
        return { id: "period-2", revision: 1 };
      }),
      rename: vi.fn(async (id: string, title: string | null) => { titles.set(id, title); return { id, revision: 2 }; }),
      addLine: vi.fn(async () => ({})),
      newId: () => `req-${++next}`,
      ...over,
    };
  }
  const plan = { previewId: "p1", title: "Big shop", items: [{ key: "eggs", name: "Eggs" }, { key: "rice", name: "Rice" }] };

  it("makes exactly one period and it carries its title", async () => {
    const d = deps();
    const result = await runSave(plan, newSaveProgress(d.newId), d);
    expect(result.status).toBe("done");
    expect(d.periods).toHaveLength(1);
    expect(d.rename).toHaveBeenCalledWith("period-1", "Big shop", 1, expect.any(String));
    // Rice is already a plan line from the accept: only Eggs is added.
    expect(d.addLine).toHaveBeenCalledTimes(1);
    expect(d.addLine).toHaveBeenCalledWith("period-1", "Eggs", expect.any(String));
  });

  it("leaves a usable list after a failure and finishes into the same period", async () => {
    let fail = true;
    const d = deps({ addLine: vi.fn(async () => { if (fail) throw new Error("offline"); return {}; }) });
    const first = await runSave(plan, newSaveProgress(d.newId), d);
    expect(first).toMatchObject({ status: "partial", failed: ["Eggs"] });
    const requestId = first.progress.lineRequestIds.eggs;
    fail = false;
    const second = await runSave(plan, first.progress, d);
    expect(second.status).toBe("done");
    expect(d.accept).toHaveBeenCalledTimes(1);
    expect(d.rename).toHaveBeenCalledTimes(1);
    expect(d.addLine).toHaveBeenLastCalledWith("period-1", "Eggs", requestId);
  });

  it("retries a title whose answer was lost with the same request id", async () => {
    let lost = true;
    const d = deps({ rename: vi.fn(async (id: string) => { if (lost) throw new Error("timeout"); return { id, revision: 2 }; }) });
    const first = await runSave(plan, newSaveProgress(d.newId), d);
    expect(first).toMatchObject({ status: "partial", failed: ["title"] });
    lost = false;
    const second = await runSave(plan, first.progress, d);
    expect(second.status).toBe("done");
    const ids = (d.rename as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[3]);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);
  });

  it("refuses another plan under a request id whose first answer was lost", async () => {
    const d = deps();
    const foods = { draft: { ...draft, title: "Big shop" }, title: "Big shop", items: plan.items };
    // The foods-only create was sent and its answer lost; the planner then plans meals instead.
    const start = { ...newSaveProgress(d.newId), sentFor: saveTarget(foods) };
    await expect(runSave(plan, start, d)).rejects.toThrow(SAVE_TARGET_CHANGED);
    expect(d.accept).not.toHaveBeenCalled();
    expect(d.create).not.toHaveBeenCalled();
    // The same plan again is a plain retry.
    expect((await runSave(foods, start, d)).status).toBe("done");
  });

  it("writes nothing more when the accept fails", async () => {
    const d = deps({ accept: vi.fn(async () => { throw new Error("stale"); }) });
    await expect(runSave(plan, newSaveProgress(d.newId), d)).rejects.toThrow("stale");
    expect(d.rename).not.toHaveBeenCalled();
    expect(d.addLine).not.toHaveBeenCalled();
  });

  it("saves just the foods into one titled list with no rename, and a retry makes no second", async () => {
    let fail = true;
    const d = deps({ addLine: vi.fn(async () => { if (fail) throw new Error("offline"); return {}; }) });
    const foods = { draft: { ...draft, title: "Big shop" }, title: "Big shop", items: plan.items };
    const first = await runSave(foods, newSaveProgress(d.newId), d);
    expect(first.status).toBe("partial");
    expect(d.create).toHaveBeenCalledWith(foods.draft, first.progress.acceptRequestId);
    expect(d.accept).not.toHaveBeenCalled();
    expect(d.rename).not.toHaveBeenCalled();
    fail = false;
    const second = await runSave(foods, first.progress, d);
    expect(second.status).toBe("done");
    expect(d.create).toHaveBeenCalledTimes(1);
    expect(d.periods).toHaveLength(1);
    expect(d.addLine).toHaveBeenLastCalledWith("period-2", "Rice", expect.any(String));
  });

  it("builds its plan from the Yes foods only", () => {
    let state = atMeals(withDeck(["Eggs", "Milk"]), []);
    state = run(state, { type: "back" });
    expect(state.step).toBe("ingredients");
    state = run(state, { type: "back" }, { type: "back" }, { type: "answer", answer: "yes" }, { type: "answer", answer: "no" });
    expect(savePlan(state)?.items).toEqual([{ key: "eggs", name: "Eggs" }]);
  });
});

describe("the deck's AI order", () => {
  it("only reorders: an unsent id is ignored and a missing one keeps its place", async () => {
    const { applyRankOrder } = await import("@/lib/shopping/build-rank-client");
    const items = [{ id: "c1" }, { id: "c2" }, { id: "c3" }];
    expect(applyRankOrder(items, ["c3", "x9", "c1", "c3"]).map((item) => item.id)).toEqual(["c3", "c1", "c2"]);
  });
});
