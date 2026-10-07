// @vitest-environment jsdom
/**
 * Recipe marks after a rule change (2026-10-05, round 3; lib/recipes/recipe-freshness.ts). A mark
 * counts only while the server judged it under the phone's own rules key (`ruleFlags`); otherwise,
 * and while a re-read the phone asked for runs, the card says "Check: Checking against your updated
 * food rules", never clear. Each surface has one read generation: a new read aborts the one before
 * it and only the newest applies. Rule signals coalesce over 600 ms into one re-read, which waits
 * for a read in flight; a stale-judged or failed re-read retries after 30 s, then every 2 min.
 */
import { Profiler } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Food } from "@/lib/foods";
import { bindAccount, markAccountReady, unbindAccount } from "@/lib/device/account";
import type { RecipeCandidate } from "@/lib/recipe-catalog/types";
import type { RuleMark } from "@/lib/types";

const search = vi.hoisted(() => vi.fn());
const detail = vi.hoisted(() => vi.fn());
const plan = vi.hoisted(() => ({ preview: vi.fn(), accept: vi.fn() }));
vi.mock("@/lib/recipe-catalog-client", async (original) => ({
  ...(await original<typeof import("@/lib/recipe-catalog-client")>()), searchCatalogRecipes: search,
  getCatalogRecipe: detail, getCatalogFavorite: vi.fn(async () => ({ favorite: false, revision: 0 })),
}));
vi.mock("@/lib/recipe-plan-client", () => ({ previewRecipePlan: plan.preview, acceptRecipePlan: plan.accept }));
vi.mock("@/lib/recipe-access-client", async (original) => ({
  ...(await original<typeof import("@/lib/recipe-access-client")>()),
  useRecipeAccess: () => ({ enabled: true, loading: false }),
}));
const seeded = vi.hoisted(() => ({ foods: {} as Record<string, Food> }));
vi.mock("@/lib/store", async (original) => {
  const actual = await original<typeof import("@/lib/store")>();
  return { ...actual, loadStore: () => ({ ...actual.defaultStore(), foods: seeded.foods }) };
});

import RecipeCarousel from "@/components/recipes-hub/RecipeCarousel";
import RecipeDiscovery from "@/components/RecipeDiscovery";
import RecipePlanFlow from "@/components/RecipePlanFlow";
import { PutInMealPicker } from "@/components/recipes-hub/PutInMeal";
import RecipeResultsBlock from "@/components/coach/blocks/recipe_results";
import { resetFlightsForTests } from "@/components/single-flight";
import { noteFoodRulesChanged } from "@/lib/foods/rules-epoch";
import { MAX_RECIPE_RETRIES, phoneRulesKey, RECIPE_AVOID_CHANGED, RECIPE_RETRY_MS, RULE_SIGNAL_DEBOUNCE_MS,
  useRecipeReader } from "@/lib/recipes/recipe-freshness";
import { foodRulesKey, RECIPE_RECHECK } from "@/lib/foods/rule-marks";
import { SYNCED_EVENT } from "@/lib/foods/rules-epoch";

const BLOCKED: RuleMark = { verdict: "blocked", reason: "Peanut sauce has peanut, which your rules exclude." };
const OLD = foodRulesKey({ dietPrefs: { flags: ["vegan"] } });
const known = (value: number) => ({ value, status: "known" as const, sourceRevisionId: 1 });
function recipe(name: string, ruleMark: RuleMark | null, key = phoneRulesKey()): RecipeCandidate {
  return {
    sourceKind: "shared", recipeId: `id-${name}`, revisionId: `rev-${name}`, publicationState: "published",
    withdrawalReason: null, name, cuisine: "Thai", dishTags: [], activeMinutes: 20, totalMinutes: 30,
    effort: "standard", servings: 2, yieldGrams: null, yieldStatus: "unknown", minServingFraction: 0.5,
    maxServingFraction: 2,
    ingredients: [{ seq: 1, name: "Noodles", foodRefId: "f1", catalogFoodRevisionId: 1, quantity: 200, unit: "g",
      grams: 200, state: "raw", required: true, purchaseGrams: 200, purchaseConversionStatus: "known",
      nutrition: { kcal: known(700), protein: known(25), carbs: known(140), fat: known(5) }, allergenEvidence: {} }],
    steps: [{ seq: 1, text: "Boil the noodles." }],
    nutritionPerServing: { kcal: known(350), protein: known(12), carbs: known(70), fat: known(3) },
    source: { author: "Sasha kitchen", sourceUrl: null, rightsKind: "original", rightsRecord: "o",
      sourceRevision: "1", kitchenTested: false },
    eligibility: { status: "eligible", reasons: [] }, ruleMark, ruleMarkRulesKey: key,
  };
}
const list = (...recipes: RecipeCandidate[]) => ({ count: recipes.length, limitations: [], recipes });
function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}
const marks = (root: ParentNode = document) => [...root.querySelectorAll("[data-rule-mark]")]
  .map((node) => node.getAttribute("data-rule-mark"));
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const carousel = () => screen.getByRole("region", { name: "Recipe catalog" });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  // The top of the retry's jitter band (lib/jitter.ts) is the planned step, so the exact times hold.
  vi.spyOn(Math, "random").mockReturnValue(1);
  unbindAccount(); bindAccount("11111111-1111-4111-8111-111111111111");
  seeded.foods = {};
  search.mockReset(); detail.mockReset(); plan.preview.mockReset(); plan.accept.mockReset();
  resetFlightsForTests();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("trust by the server's judgement", () => {
  it("keeps a recipe judged under old flags on Checking, and re-reads after 30 s, then 2 min", async () => {
    search.mockResolvedValue(list(recipe("Satay", null, OLD)));
    render(<RecipeCarousel remaining={null} date="2026-10-05" />);
    await settle();
    // Judged clear, but under other flags: never shown as clear.
    expect(marks(carousel())).toEqual(["unknown"]);
    expect(carousel().textContent).toContain(RECIPE_RECHECK);
    await tick(RECIPE_RETRY_MS[0] - 1);
    expect(search).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(search).toHaveBeenCalledTimes(2);
    expect(marks(carousel())).toEqual(["unknown"]);
    search.mockResolvedValue(list(recipe("Satay", BLOCKED)));
    await tick(RECIPE_RETRY_MS[0]);
    expect(search).toHaveBeenCalledTimes(2);
    await tick(RECIPE_RETRY_MS[1] - RECIPE_RETRY_MS[0]);
    expect(search).toHaveBeenCalledTimes(3);
    expect(marks(carousel())).toEqual(["blocked"]);
    // Judged under the phone's rules: the retries stop.
    await tick(10 * RECIPE_RETRY_MS[1]);
    expect(search).toHaveBeenCalledTimes(3);
  });
});

describe("one read generation per surface", () => {
  it("re-reads once after the read in flight settles when the rules change during it", async () => {
    search.mockResolvedValueOnce(list(recipe("Satay", null)));
    render(<RecipeCarousel remaining={null} date="2026-10-05" />);
    await settle();
    expect(marks(carousel())).toEqual([]);
    const second = deferred<ReturnType<typeof list>>();
    search.mockImplementationOnce(() => second.promise);
    act(() => { window.dispatchEvent(new CustomEvent(RECIPE_AVOID_CHANGED, { detail: "Noodles" })); });
    // Checking at once, while the signals coalesce.
    expect(marks(carousel())).toEqual(["unknown"]);
    await tick(RULE_SIGNAL_DEBOUNCE_MS);
    expect(search).toHaveBeenCalledTimes(2);
    act(() => { window.dispatchEvent(new CustomEvent(RECIPE_AVOID_CHANGED, { detail: "Lime" })); });
    await tick(RULE_SIGNAL_DEBOUNCE_MS);
    // Not two at once: it waits for the read in flight.
    expect(search).toHaveBeenCalledTimes(2);
    search.mockResolvedValueOnce(list(recipe("Satay", BLOCKED)));
    await act(async () => { second.resolve(list(recipe("Satay", null))); await vi.advanceTimersByTimeAsync(0); });
    expect(search).toHaveBeenCalledTimes(3);
    await settle();
    expect(marks(carousel())).toEqual(["blocked"]);
  });

  it("applies only the newest of two overlapping searches", async () => {
    const first = deferred<ReturnType<typeof list>>();
    const second = deferred<ReturnType<typeof list>>();
    const signals: AbortSignal[] = [];
    search.mockImplementationOnce((_query: unknown, signal: AbortSignal) => { signals.push(signal); return first.promise; })
      .mockImplementationOnce((_query: unknown, signal: AbortSignal) => { signals.push(signal); return second.promise; });
    render(<RecipeDiscovery />);
    const field = screen.getByRole("searchbox", { name: "Recipe dish or ingredient" });
    fireEvent.change(field, { target: { value: "satay" } });
    fireEvent.submit(field.closest("form")!);
    fireEvent.change(field, { target: { value: "rice" } });
    fireEvent.submit(field.closest("form")!);
    expect(signals[0].aborted).toBe(true);
    await act(async () => { second.resolve(list(recipe("Rice", null))); await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { first.resolve(list(recipe("Satay", BLOCKED))); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByRole("button", { name: /Rice/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Satay/ })).toBeNull();
    expect(marks()).toEqual([]);
  });
});

describe("re-reads in order", () => {
  it("lands the newest re-read last, whatever order the answers come back in", async () => {
    const answers: { mark: RuleMark | null; done: ReturnType<typeof deferred<ReturnType<typeof list>>>; settled: boolean }[] = [];
    search.mockImplementation(() => {
      // Each read answers with its own mark, so the one on screen names the read it came from.
      const entry = { mark: { verdict: "blocked" as const, reason: `Answer ${answers.length}.` },
        done: deferred<ReturnType<typeof list>>(), settled: false };
      answers.push(entry);
      return entry.done.promise;
    });
    render(<RecipeDiscovery />);
    const field = screen.getByRole("searchbox", { name: "Recipe dish or ingredient" });
    fireEvent.change(field, { target: { value: "satay" } });
    fireEvent.submit(field.closest("form")!);
    await act(async () => { answers[0].settled = true; answers[0].done.resolve(list(recipe("Satay", null)));
      await vi.advanceTimersByTimeAsync(0); });
    expect(marks()).toEqual([]);
    // Two rule changes a second apart: two re-reads asked for.
    act(() => { window.dispatchEvent(new CustomEvent(RECIPE_AVOID_CHANGED, { detail: "Lime" })); });
    await tick(1_000);
    act(() => { window.dispatchEvent(new CustomEvent(RECIPE_AVOID_CHANGED, { detail: "Peanut" })); });
    await tick(1_000);
    // Answer the newest open read first, every time, until none is left.
    for (let open = answers.filter((entry) => !entry.settled); open.length > 0;
      open = answers.filter((entry) => !entry.settled)) {
      for (const entry of [...open].reverse()) {
        entry.settled = true;
        await act(async () => { entry.done.resolve(list(recipe("Satay", entry.mark))); await vi.advanceTimersByTimeAsync(0); });
      }
      await tick(RULE_SIGNAL_DEBOUNCE_MS);
    }
    expect(answers.length).toBeGreaterThan(1);
    // What shows is the newest read's answer, not an older one that came back later.
    expect(marks()).toEqual(["blocked"]);
    expect(document.body.textContent).toContain(answers.at(-1)!.mark!.reason);
    for (const older of answers.slice(1, -1)) expect(document.body.textContent).not.toContain(older.mark!.reason);
  });
});

describe("coalescing", () => {
  it("makes one Avoid edit one read, however many signals it sends", async () => {
    search.mockResolvedValue(list(recipe("Satay", null)));
    render(<RecipeCarousel remaining={null} date="2026-10-05" />);
    await settle();
    expect(search).toHaveBeenCalledTimes(1);
    act(() => { window.dispatchEvent(new CustomEvent(RECIPE_AVOID_CHANGED, { detail: "Peanut" })); });
    await tick(200);
    act(() => {
      // 200 ms later the membership write lands in the store and sync passes report it.
      seeded.foods = { peanut: { id: "peanut", name: "Peanut", role: "fat", unit: "g",
        perUnit: { protein: 0.25, carbs: 0.16, fat: 0.49 }, status: "avoid", updatedAt: "2026-10-05T00:00:00Z" } as Food };
      window.dispatchEvent(new Event(SYNCED_EVENT));
      window.dispatchEvent(new Event(SYNCED_EVENT));
    });
    await tick(RULE_SIGNAL_DEBOUNCE_MS);
    await settle();
    expect(search).toHaveBeenCalledTimes(2);
    // A later sync pass with the same inputs is not a rule change.
    act(() => { window.dispatchEvent(new Event(SYNCED_EVENT)); });
    await tick(RULE_SIGNAL_DEBOUNCE_MS);
    expect(search).toHaveBeenCalledTimes(2);
    expect(marks(carousel())).toEqual([]);
  });
});

describe("the open carousel card", () => {
  it("says the mark once while open", async () => {
    search.mockResolvedValue(list(recipe("Satay", BLOCKED)));
    render(<RecipeCarousel remaining={null} date="2026-10-05" />);
    await settle();
    const closed = within(carousel()).getByRole("button", { name: /Satay/, expanded: false });
    const card = closed.closest("[data-recipe-card]") as HTMLElement;
    expect(marks(card)).toEqual(["blocked"]);
    await act(async () => { fireEvent.click(closed); await vi.advanceTimersByTimeAsync(1000); });
    const open = carousel().querySelector("[data-recipe-card][data-open]") as HTMLElement;
    expect(marks(open)).toEqual(["blocked"]);
    expect(open.textContent?.split(BLOCKED.reason).length).toBe(2);
  });
});

describe("a read the rules moved under", () => {
  it("does not clear Checking with an answer read before the change, however it was judged", async () => {
    search.mockResolvedValueOnce(list(recipe("Satay", null)));
    render(<RecipeCarousel remaining={null} date="2026-10-05" />);
    await settle();
    const inFlight = deferred<ReturnType<typeof list>>();
    search.mockImplementationOnce(() => inFlight.promise);
    act(() => { window.dispatchEvent(new CustomEvent(RECIPE_AVOID_CHANGED, { detail: "Lime" })); });
    await tick(RULE_SIGNAL_DEBOUNCE_MS);
    expect(search).toHaveBeenCalledTimes(2);
    // The rules move again while that read is out; its answer is judged under the phone's flags.
    const last = deferred<ReturnType<typeof list>>();
    search.mockImplementationOnce(() => last.promise);
    act(() => { noteFoodRulesChanged(); });
    await act(async () => { inFlight.resolve(list(recipe("Satay", null))); await vi.advanceTimersByTimeAsync(0); });
    expect(marks(carousel())).toEqual(["unknown"]);
    await tick(RULE_SIGNAL_DEBOUNCE_MS);
    expect(search).toHaveBeenCalledTimes(3);
    await act(async () => { last.resolve(list(recipe("Satay", null))); await vi.advanceTimersByTimeAsync(0); });
    expect(marks(carousel())).toEqual([]);
  });
});

describe("preview, plan and placement verdicts", () => {
  const preview = (ruleMark: RuleMark | null) => ({ previewId: "p", recipe: recipe("Satay", null), servingFraction: 1,
    ingredientSnapshot: [], nutritionSnapshot: { kcal: known(350), protein: known(12), carbs: known(70), fat: known(3) },
    gap: { kcal: 0, protein: 0, carbs: 0, fat: 0 }, mealTarget: null, exactFitAvailable: true,
    approximateFitAvailable: true, evidenceIssues: [], authority: {}, ruleMark, ruleFlags: [] });

  it("re-runs an open preview once after a rule change, and marks a saved plan Checking without redoing it", async () => {
    plan.preview.mockResolvedValueOnce(preview(BLOCKED));
    render(<RecipePlanFlow recipe={recipe("Satay", null)} onClose={vi.fn()} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Preview portion" }));
      await vi.advanceTimersByTimeAsync(0); });
    const portion = () => screen.getByLabelText("Portion preview");
    expect(marks(portion())).toEqual(["blocked"]);
    plan.preview.mockResolvedValueOnce(preview(null));
    act(() => { noteFoodRulesChanged(); noteFoodRulesChanged(); });
    expect(marks(portion())).toEqual(["unknown"]);
    expect(portion().textContent).toContain(RECIPE_RECHECK);
    await tick(RULE_SIGNAL_DEBOUNCE_MS);
    expect(plan.preview).toHaveBeenCalledTimes(2);
    expect(marks(portion())).toEqual([]);
    plan.accept.mockResolvedValue({ id: "s", ruleMark: BLOCKED });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add to plan" }));
      await vi.advanceTimersByTimeAsync(0); });
    expect(marks()).toEqual(["blocked"]);
    act(() => { noteFoodRulesChanged(); });
    expect(marks()).toEqual(["unknown"]);
    await tick(10 * RECIPE_RETRY_MS[1]);
    expect(plan.preview).toHaveBeenCalledTimes(2);
    expect(plan.accept).toHaveBeenCalledTimes(1);
  });

  it("marks a placed meal Checking after a rule change and never places it again", async () => {
    plan.preview.mockResolvedValue({ previewId: "p", recipe: recipe("Satay", null), servingFraction: 1,
      exactFitAvailable: true, approximateFitAvailable: true });
    plan.accept.mockResolvedValue({ id: "s", ruleMark: BLOCKED });
    render(<PutInMealPicker recipe={recipe("Satay", null)}
      readSlots={() => [{ slotId: "meal-3", label: "Meal 3", time: "18:00", planned: null, eaten: false }]} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Put in Meal 3, today" }));
      await vi.advanceTimersByTimeAsync(0); });
    expect(marks()).toEqual(["blocked"]);
    act(() => { window.dispatchEvent(new CustomEvent(RECIPE_AVOID_CHANGED, { detail: "Lime" })); });
    expect(marks()).toEqual(["unknown"]);
    await tick(10 * RECIPE_RETRY_MS[1]);
    expect(plan.preview).toHaveBeenCalledTimes(1);
    expect(plan.accept).toHaveBeenCalledTimes(1);
  });
});

describe("the coach's recipe block", () => {
  const stored = [recipe("Satay", null), recipe("Rice", null)];
  const fresh = (name: string) => stored.find((item) => item.name === name)!;
  const byId = (id: string) => fresh(id.replace(/^id-/, ""));
  const cards = () => screen.queryAllByRole("button", { expanded: false })
    .filter((button) => /Satay|Rice/.test(button.textContent ?? ""));

  it("keeps its cards, marked Checking, through a read with a transient failure, and retries", async () => {
    detail.mockImplementation(async (id: string) => byId(id));
    render(<RecipeResultsBlock blockId="b" recipes={stored} />);
    await settle(); await settle();
    expect(cards()).toHaveLength(2);
    detail.mockImplementation(async (id: string) => {
      if (id === "id-Rice") throw new TypeError("Failed to fetch");
      return byId(id);
    });
    act(() => { noteFoodRulesChanged(); });
    await tick(RULE_SIGNAL_DEBOUNCE_MS); await settle();
    // Never a shorter list from a failed read: both cards stay, still Checking.
    expect(cards()).toHaveLength(2);
    expect(marks()).toEqual(["unknown", "unknown"]);
    expect(document.body.textContent).not.toContain("could not be confirmed");
    detail.mockImplementation(async (id: string) => byId(id));
    await tick(RECIPE_RETRY_MS[0]); await settle();
    expect(cards()).toHaveLength(2);
    expect(marks()).toEqual([]);
  });

  it("retries a first read that failed entirely instead of showing an empty list", async () => {
    detail.mockRejectedValue(new TypeError("Failed to fetch"));
    render(<RecipeResultsBlock blockId="b" recipes={stored} />);
    await settle(); await settle();
    expect(screen.getByRole("status").textContent).toContain("Checking current recipe access");
    expect(document.body.textContent).not.toContain("Saved recipe details are unavailable");
    detail.mockImplementation(async (id: string) => byId(id));
    await tick(RECIPE_RETRY_MS[0]); await settle();
    expect(cards()).toHaveLength(2);
  });

  it("stops its timers when the account goes", async () => {
    // Judged under nothing the phone can trust: a retry is due in 30 s.
    detail.mockImplementation(async (id: string) => ({ ...byId(id), ruleMarkRulesKey: OLD }));
    render(<RecipeResultsBlock blockId="b" recipes={stored} />);
    await settle(); await settle();
    const calls = detail.mock.calls.length;
    act(() => { unbindAccount(); });
    await tick(10 * RECIPE_RETRY_MS[1]);
    expect(detail.mock.calls.length).toBe(calls);
  });
});

describe("no surface can loop (CI heap crash, 2026-10-05)", () => {
  it("gives a surface the same reader on every render", () => {
    const { result, rerender } = renderHook(() => useRecipeReader<number>({ apply: () => {}, judged: () => true }));
    const first = result.current.reader;
    rerender(); rerender();
    expect(result.current.reader).toBe(first);
    expect(result.current.reader.read).toBe(first.read);
    expect(result.current.reader.clear).toBe(first.clear);
  });

  it("mounts once and reads once with an account that is already ready", async () => {
    // onAccountReady fires at once for a ready account: an effect that depended on a fresh reader
    // object re-ran on every render and set state again, without end.
    markAccountReady(bindAccount("11111111-1111-4111-8111-111111111111"));
    search.mockResolvedValue(list(recipe("Satay", null)));
    let commits = 0;
    render(<Profiler id="carousel" onRender={() => {
      commits += 1;
      if (commits > 100) throw new Error("render loop");
    }}><RecipeCarousel remaining={null} date="2026-10-05" /></Profiler>);
    await settle(); await settle();
    expect(commits).toBeLessThan(20);
    expect(search).toHaveBeenCalledTimes(1);
    expect(carousel()).toBeTruthy();
  });

  it("bounds the retries of an answer that never matches the phone's rules", async () => {
    search.mockResolvedValue(list(recipe("Satay", null, OLD)));
    render(<RecipeCarousel remaining={null} date="2026-10-05" />);
    await settle();
    for (let minute = 0; minute < 120; minute += 1) await tick(60_000);
    expect(search).toHaveBeenCalledTimes(1 + MAX_RECIPE_RETRIES);
    // Nothing left scheduled, and the cards stay Checking rather than clear.
    expect(vi.getTimerCount()).toBe(0);
    expect(marks(carousel())).toEqual(["unknown"]);
    // A rule change starts the reads again.
    search.mockResolvedValue(list(recipe("Satay", null)));
    act(() => { window.dispatchEvent(new CustomEvent(RECIPE_AVOID_CHANGED, { detail: "Lime" })); });
    await tick(RULE_SIGNAL_DEBOUNCE_MS);
    expect(search).toHaveBeenCalledTimes(2 + MAX_RECIPE_RETRIES);
    expect(marks(carousel())).toEqual([]);
  });
});
