/**
 * "Have AI build my list" (UI makeover §7.3): the flow's state, as a pure reducer.
 *
 * Steps, each opened in place with Back: Budget → Ingredients → Meals → Stores → Save. Close
 * discards the whole state (the component drops it). Nothing is written before Save: the meals
 * step only previews (write-free), and the one write path is `runSave`, which the component calls
 * from the Save button with the real clients injected.
 *
 * - Ingredients: one Yes / No per card, "Yes to the rest", a "3 of 18" counter, at most 30 cards
 *   (lib/shopping/build-candidates.ts builds and caps them).
 * - Meals: the planner's preview, one card per planned meal. The No answers are excluded in one
 *   re-preview (`excludeRecipeIds`) and only the replacements are walked again; after
 *   `MAX_MEAL_ROUNDS` re-previews the only way on is "Keep these".
 * - Stores: optional, at most `MAX_STORES` picks.
 * - Save: `runSave` accepts the preview (which creates the list), titles it, then adds every Yes
 *   ingredient as its own line, each with its own request id; it can be run again with the same
 *   progress to finish a save that stopped part-way, never making a second list.
 */
import { candidateKey, type BuildCandidate } from "@/lib/shopping/build-candidates";
import type { PlaceStore, ShoppingDraft, ShoppingPreviewInput } from "@/lib/shopping/contracts";
import type { Provenance } from "@/lib/types";

export type BuildStep = "budget" | "ingredients" | "meals" | "stores" | "save";
export const BUILD_STEPS: readonly BuildStep[] = ["budget", "ingredients", "meals", "stores", "save"];
export const STEP_LABEL: Record<BuildStep, string> = {
  budget: "Budget", ingredients: "Foods", meals: "Meals", stores: "Stores", save: "Save",
};
export type Answer = "yes" | "no";

/** Re-previews the meals step may run before "Keep these" is the only way on. */
export const MAX_MEAL_ROUNDS = 2;
export const MAX_STORES = 5;
export const DEFAULT_TITLE = "Weekly shop";
export const TITLE_MAX = 60;

export type MealCard = {
  /** date|slot|recipe: one planned meal. */
  key: string;
  recipeId: string;
  name: string;
  date: string;
  slotId: string;
  kcal: number | null;
  proteinG: number | null;
};

type Deck<T> = { cards: T[]; index: number; answers: Record<string, Answer> };

export type BuildState = {
  step: BuildStep;
  draft: ShoppingDraft;
  ingredients: Deck<BuildCandidate> & {
    status: "loading" | "ready";
    leftOutByRules: number;
    total: number;
    provenance: Provenance;
  };
  meals: Deck<MealCard> & {
    status: "idle" | "loading" | "ready" | "error";
    error: string | null;
    previewId: string | null;
    excluded: string[];
    rounds: number;
    kept: boolean;
    /** Bumped for every preview the component should run. */
    request: number;
  };
  stores: PlaceStore[];
  title: string;
};

export type BuildAction =
  | { type: "budget"; amount: number | null; currency: string | null }
  | { type: "next" }
  | { type: "skip" }
  | { type: "back" }
  | { type: "deck-loaded"; cards: BuildCandidate[]; leftOutByRules: number; total: number; provenance: Provenance }
  | { type: "answer"; answer: Answer }
  | { type: "yes-to-rest" }
  | { type: "preview-loaded"; request: number; previewId: string; cards: MealCard[] }
  | { type: "preview-failed"; request: number; message: string }
  | { type: "retry-preview" }
  | { type: "swap-no-meals" }
  | { type: "keep-these" }
  | { type: "toggle-store"; store: PlaceStore }
  | { type: "title"; title: string }
  | { type: "edit-plan"; draft: ShoppingDraft };

export function initialBuildState(draft: ShoppingDraft): BuildState {
  return {
    step: "budget",
    draft,
    ingredients: { status: "loading", cards: [], index: 0, answers: {}, leftOutByRules: 0, total: 0,
      provenance: { ai: false, source: "app" } },
    meals: { status: "idle", error: null, previewId: null, cards: [], index: 0, answers: {}, excluded: [],
      rounds: 0, kept: false, request: 0 },
    stores: [],
    title: DEFAULT_TITLE,
  };
}

// ------------------------------------------------------------------ selectors

export function deckDone<T>(deck: Deck<T>): boolean {
  return deck.index >= deck.cards.length;
}
/** Answers are keyed by a food card's id and a meal card's date|slot|recipe key. */
function keyOf(card: BuildCandidate | MealCard): string {
  return "sources" in card ? card.id : card.key;
}

/** "3 of 18": the card on screen, counted from one. */
export function deckCounter<T>(deck: Deck<T>): string {
  return `${Math.min(deck.index + 1, deck.cards.length)} of ${deck.cards.length}`;
}
export function yesIngredients(state: BuildState): BuildCandidate[] {
  return state.ingredients.cards.filter((card) => state.ingredients.answers[card.id] === "yes");
}
export function noMeals(state: BuildState): MealCard[] {
  return state.meals.cards.filter((card) => state.meals.answers[card.key] === "no");
}
export function canSwapMeals(state: BuildState): boolean {
  return state.meals.status === "ready" && deckDone(state.meals) && noMeals(state).length > 0
    && state.meals.rounds < MAX_MEAL_ROUNDS;
}
/** The meals step may move on: every card answered and either all Yes or "Keep these" chosen. */
export function mealsSettled(state: BuildState): boolean {
  return state.meals.status === "ready" && deckDone(state.meals)
    && (noMeals(state).length === 0 || state.meals.kept);
}
export function previewInput(state: BuildState): ShoppingPreviewInput {
  return { draft: state.draft, basket: [],
    ...(state.meals.excluded.length ? { excludeRecipeIds: [...state.meals.excluded] } : {}) };
}
export function cleanTitle(title: string): string | null {
  const value = title.trim().replace(/\s+/g, " ").slice(0, TITLE_MAX).trim();
  return value || null;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}
/** "18 items · 9 meals · 2 stores": what Save will write. */
export function saveSummary(state: BuildState): string {
  const parts = [plural(yesIngredients(state).length, "item", "items"),
    plural(state.meals.cards.length, "meal", "meals")];
  if (state.stores.length) parts.push(plural(state.stores.length, "store", "stores"));
  return parts.join(" · ");
}

// ------------------------------------------------------------------ reducer

function answer<T extends BuildCandidate | MealCard>(deck: Deck<T>, value: Answer): Deck<T> {
  const card = deck.cards[deck.index];
  if (!card) return deck;
  return { ...deck, answers: { ...deck.answers, [keyOf(card)]: value }, index: deck.index + 1 };
}
function yesToRest<T extends BuildCandidate | MealCard>(deck: Deck<T>): Deck<T> {
  const answers = { ...deck.answers };
  for (const card of deck.cards.slice(deck.index)) answers[keyOf(card)] = "yes";
  return { ...deck, answers, index: deck.cards.length };
}
/** One card back: the previous card shows again, unanswered. */
function backOne<T extends BuildCandidate | MealCard>(deck: Deck<T>): Deck<T> {
  const index = deck.index - 1;
  const answers = { ...deck.answers };
  delete answers[keyOf(deck.cards[index])];
  return { ...deck, index, answers };
}

function previous(step: BuildStep): BuildStep {
  return BUILD_STEPS[Math.max(0, BUILD_STEPS.indexOf(step) - 1)];
}

function startPreview(state: BuildState, patch: Partial<BuildState["meals"]> = {}): BuildState {
  return { ...state, meals: { ...state.meals, ...patch, status: "loading", error: null,
    request: state.meals.request + 1 } };
}

export function buildReducer(state: BuildState, action: BuildAction): BuildState {
  switch (action.type) {
    case "budget":
      return { ...state, draft: { ...state.draft, budgetAmount: action.amount,
        currency: action.amount === null ? null : action.currency } };
    case "next": {
      if (state.step === "budget") return { ...state, step: "ingredients" };
      if (state.step === "ingredients") {
        if (!deckDone(state.ingredients) || state.ingredients.status !== "ready") return state;
        const moved = { ...state, step: "meals" as const };
        return state.meals.status === "idle" ? startPreview(moved) : moved;
      }
      if (state.step === "meals") return mealsSettled(state) ? { ...state, step: "stores" } : state;
      if (state.step === "stores") return { ...state, step: "save" };
      return state;
    }
    case "skip":
      if (state.step === "budget") {
        return { ...state, step: "ingredients", draft: { ...state.draft, budgetAmount: null, currency: null } };
      }
      if (state.step === "stores") return { ...state, step: "save", stores: [] };
      return state;
    case "back": {
      if (state.step === "ingredients" && state.ingredients.index > 0) {
        return { ...state, ingredients: { ...state.ingredients, ...backOne(state.ingredients) } };
      }
      if (state.step === "meals" && state.meals.status === "ready" && state.meals.index > 0) {
        return { ...state, meals: { ...state.meals, ...backOne(state.meals), kept: false } };
      }
      return { ...state, step: previous(state.step) };
    }
    case "deck-loaded":
      return { ...state, ingredients: { status: "ready", cards: action.cards.slice(0, 30), index: 0,
        answers: {}, leftOutByRules: action.leftOutByRules, total: action.total, provenance: action.provenance } };
    case "answer":
      if (state.step === "ingredients") return { ...state, ingredients: { ...state.ingredients, ...answer(state.ingredients, action.answer) } };
      if (state.step === "meals" && state.meals.status === "ready") {
        return { ...state, meals: { ...state.meals, ...answer(state.meals, action.answer) } };
      }
      return state;
    case "yes-to-rest":
      if (state.step === "ingredients") return { ...state, ingredients: { ...state.ingredients, ...yesToRest(state.ingredients) } };
      if (state.step === "meals" && state.meals.status === "ready") {
        return { ...state, meals: { ...state.meals, ...yesToRest(state.meals) } };
      }
      return state;
    case "preview-loaded": {
      if (action.request !== state.meals.request) return state;
      // A meal said Yes before stays Yes; the replacements are walked, after the kept ones.
      const carried = action.cards.filter((card) => state.meals.answers[card.key] === "yes");
      const fresh = action.cards.filter((card) => state.meals.answers[card.key] !== "yes");
      const answers: Record<string, Answer> = {};
      for (const card of carried) answers[card.key] = "yes";
      return { ...state, meals: { ...state.meals, status: "ready", error: null, previewId: action.previewId,
        cards: [...carried, ...fresh], index: carried.length, answers, kept: false } };
    }
    case "preview-failed":
      if (action.request !== state.meals.request) return state;
      return { ...state, meals: { ...state.meals, status: "error", error: action.message } };
    case "retry-preview":
      return state.meals.status === "error" ? startPreview(state) : state;
    case "swap-no-meals": {
      if (!canSwapMeals(state)) return state;
      const excluded = [...new Set([...state.meals.excluded, ...noMeals(state).map((card) => card.recipeId)])];
      return startPreview(state, { excluded, rounds: state.meals.rounds + 1 });
    }
    case "keep-these":
      if (state.meals.status !== "ready" || !deckDone(state.meals)) return state;
      return { ...state, step: "stores", meals: { ...state.meals, kept: true } };
    case "toggle-store": {
      const on = state.stores.some((store) => store.id === action.store.id);
      if (on) return { ...state, stores: state.stores.filter((store) => store.id !== action.store.id) };
      if (state.stores.length >= MAX_STORES) return state;
      return { ...state, stores: [...state.stores, action.store] };
    }
    case "title":
      return { ...state, title: action.title.slice(0, TITLE_MAX) };
    case "edit-plan":
      return startPreview({ ...state, step: "meals", draft: action.draft },
        { previewId: null, cards: [], index: 0, answers: {}, excluded: [], rounds: 0, kept: false });
  }
}

// ------------------------------------------------------------------ the one write

export type SavedPeriod = { id: string; revision: number };
export type SaveDeps = {
  accept: (previewId: string, requestId: string) => Promise<{ period: SavedPeriod | null; lines: { name: string }[] }>;
  rename: (id: string, title: string | null, expectedRevision: number, requestId: string) => Promise<SavedPeriod>;
  addLine: (periodId: string, name: string, requestId: string) => Promise<unknown>;
  newId: () => string;
};
export type SaveProgress = {
  acceptRequestId: string;
  renameRequestId: string;
  /** Per ingredient key: the request id its line is (re)sent with. */
  lineRequestIds: Record<string, string>;
  period: SavedPeriod | null;
  titled: boolean;
  /** Ingredient keys saved, or already on the list the accept made. */
  added: string[];
};
export type SavePlan = { previewId: string; title: string | null; items: { key: string; name: string }[] };
export type SaveResult =
  | { status: "done"; progress: SaveProgress }
  | { status: "partial"; progress: SaveProgress; failed: string[] };

export function savePlan(state: BuildState): SavePlan | null {
  if (!state.meals.previewId) return null;
  return { previewId: state.meals.previewId, title: cleanTitle(state.title),
    items: yesIngredients(state).map((card) => ({ key: card.key, name: card.name })) };
}
export function newSaveProgress(newId: () => string): SaveProgress {
  return { acceptRequestId: newId(), renameRequestId: newId(), lineRequestIds: {}, period: null,
    titled: false, added: [] };
}

/**
 * Save list. The accept makes the one list (a retry sends the same request id, so a lost answer
 * never makes a second); a failure there throws and nothing was written. Every step after it is
 * best effort: the list is already usable, and the result says what is left for "Finish saving".
 */
export async function runSave(plan: SavePlan, start: SaveProgress, deps: SaveDeps): Promise<SaveResult> {
  const progress: SaveProgress = { ...start, lineRequestIds: { ...start.lineRequestIds }, added: [...start.added] };
  if (!progress.period) {
    const accepted = await deps.accept(plan.previewId, progress.acceptRequestId);
    if (!accepted.period) throw new Error("The list did not save. Try again.");
    progress.period = { id: accepted.period.id, revision: accepted.period.revision };
    const onList = new Set(accepted.lines.map((line) => candidateKey(line.name)));
    progress.added.push(...plan.items.filter((item) => onList.has(item.key)).map((item) => item.key));
  }
  const period = progress.period;
  const failed: string[] = [];
  if (!progress.titled) {
    if (!plan.title) progress.titled = true;
    else {
      try {
        const renamed = await deps.rename(period.id, plan.title, period.revision, progress.renameRequestId);
        progress.period = { id: period.id, revision: renamed.revision };
        progress.titled = true;
      } catch {
        // The same request id on "Finish saving": a rename that landed but lost its answer replays.
        failed.push("title");
      }
    }
  }
  for (const item of plan.items) {
    if (progress.added.includes(item.key)) continue;
    const requestId = progress.lineRequestIds[item.key] ?? deps.newId();
    progress.lineRequestIds[item.key] = requestId;
    let saved = false;
    // One immediate retry with the same id: a lost answer returns the row it already made.
    for (let attempt = 0; attempt < 2 && !saved; attempt += 1) {
      try { await deps.addLine(period.id, item.name, requestId); saved = true; } catch { /* retried below */ }
    }
    if (saved) progress.added.push(item.key);
    else failed.push(item.name);
  }
  return failed.length ? { status: "partial", progress, failed } : { status: "done", progress };
}
