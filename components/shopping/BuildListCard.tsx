"use client";

/**
 * "Have AI build my list" on Shopping (UI makeover §7.3). Collapsed, it is one olive call-to-action
 * card: the title, one line and Start. Start opens the flow in place (components/shopping/build/
 * BuildFlow.tsx); Close drops the whole flow, and nothing is written before Save list.
 *
 * The deck's foods come from this account only, read when the flow opens:
 * - Favored foods and Avoid marks: the phone store (`loadStore().foods`);
 * - starred foods: `listFavorites()` (the `favorites_foods` star);
 * - Eaten often: `loadTaste()` (`GET /api/foods/taste`, admitted rows only);
 * - saved recipes (`listRecipes()`) and saved meals (`favorites_meals`): their ingredients, named
 *   through this account's foods and the ref cache;
 * - left out: the pantry (`listPantry()`). Lines on the list open below are not: the build saves a
 *   list of its own, so that list's lines say nothing about this one.
 * A saved recipe's line with no name of its own is named through those foods, then the catalog
 * revision cached on this phone; one that still has no name is counted on the Foods step, never
 * dropped silently.
 * Each food's rule mark is judged against the verified eligible set (`loadEligibleLocalFoodIds`,
 * `componentRuleMark`); a failed read leaves the marks unknown, never clear. Jev may then reorder
 * the deck (lib/shopping/build-rank-client.ts), and only reorder it.
 */
import { useEffect, useMemo, useState } from "react";
import Button from "@/components/ui/Button";
import CardFrame from "@/components/ui/CardFrame";
import BuildFlow, { type BuildFlowPorts, type DeckLoad } from "@/components/shopping/build/BuildFlow";
import { getRevision } from "@/lib/db/catalog-cache";
import { AccountChanged, currentAccountOrNull, onAccountGone, onAccountReady,
  type AccountHandle } from "@/lib/device/account";
import { listFavorites } from "@/lib/favorites-client";
import type { Food } from "@/lib/foods";
import { loadEligibleLocalFoodIds } from "@/lib/foods/eligible-client";
import { readPrefRefCache } from "@/lib/foods/prefs-client";
import { componentRuleMark, currentEligibleView, type EligibleView } from "@/lib/foods/rule-marks";
import { loadTaste } from "@/lib/foods/taste-client";
import { listRecipes } from "@/lib/recipes-client";
import { acceptShopping, addManualShoppingLine, createShoppingPeriod, listPantry,
  previewShopping } from "@/lib/shopping-client";
import { buildCandidates, type CandidateInput } from "@/lib/shopping/build-candidates";
import type { MealCard } from "@/lib/shopping/build-flow";
import { rankCandidates } from "@/lib/shopping/build-rank-client";
import { defaultShoppingDraft, type ShoppingDraft } from "@/lib/shopping/contracts";
import { renameShoppingPeriod } from "@/lib/shopping/list-client";
import type { ShoppingPreviewResult } from "@/lib/shopping/preview-contract";
import { loadStore } from "@/lib/store";
import { allRows } from "@/lib/sync/idb";
import { cookingEffortFromDietPrefs } from "@/lib/sync/user-settings";
import type { Settings } from "@/lib/types";

function dateInZone(timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric",
    month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const value = (key: string) => parts.find((part) => part.type === key)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

/** The account's own meal count (Settings), else 3, the fewest a derived schedule has. */
export function mealCountOf(settings: Pick<Settings, "mealsPerDay">): number {
  const count = settings.mealsPerDay;
  return typeof count === "number" && Number.isInteger(count) ? Math.min(6, Math.max(1, count)) : 3;
}

/** A list's `locale` is at most this long on the server (lib/shopping/validation.ts `periodFields`). */
const LOCALE_MAX = 80;

/**
 * The area Shopping's planner keeps as a list's locale (components/ShoppingRoot.tsx,
 * `shopping-location:<id>`), cut to the server's limit. Never the store search's own area
 * (`shopping-build-area:<id>`, StepStores), which stays on the phone.
 */
export function listLocale(accountId: string): string | null {
  let raw: string | null = null;
  try { raw = window.localStorage.getItem(`shopping-location:${accountId}`); } catch { /* storage blocked */ }
  const value = raw?.trim().slice(0, LOCALE_MAX).trim();
  return value || null;
}

/** The next 7 days and every one of the account's own meals. */
export function buildDraft(settings: Settings, accountId: string): ShoppingDraft {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const draft = defaultShoppingDraft(dateInZone(timezone), timezone);
  const effort = cookingEffortFromDietPrefs(settings.dietPrefs);
  const meals = Array.from({ length: mealCountOf(settings) }, (_, index) => `meal-${index + 1}`);
  return { ...draft, mealCoverage: meals, locale: listLocale(accountId),
    effort: effort === "none" || effort === "minimal" ? effort : "standard" };
}

/** Food names by every ref this account's foods carry, so a saved recipe's lines can be named. */
function namesByRef(foods: Record<string, Food>, accountId: string): Map<string, string> {
  const refs = readPrefRefCache(accountId);
  const out = new Map<string, string>();
  for (const food of Object.values(foods)) {
    const saved = refs[food.id];
    if (saved?.userRefId) out.set(saved.userRefId, food.name);
    if (saved?.catalogRefId) out.set(saved.catalogRefId, food.name);
  }
  return out;
}
/** A saved line's name: its own, then this account's foods by ref, then the cached catalog revision. */
async function itemNames(items: unknown, byRef: Map<string, string>,
  account: AccountHandle): Promise<{ names: string[]; unnamed: number }> {
  if (!Array.isArray(items)) return { names: [], unnamed: 0 };
  const names: string[] = [];
  let unnamed = 0;
  for (const item of items as Record<string, unknown>[]) {
    if (typeof item?.name === "string" && item.name.trim()) { names.push(item.name); continue; }
    const ref = typeof item?.food_ref_id === "string" ? byRef.get(item.food_ref_id) : undefined;
    if (ref) { names.push(ref); continue; }
    const revision = typeof item?.food_revision_id === "number"
      ? await settle(getRevision(item.food_revision_id, account), undefined) : undefined;
    if (revision?.description) names.push(revision.description);
    else unnamed += 1;
  }
  return { names, unnamed };
}

async function settle<T>(work: Promise<T>, fallback: T): Promise<T> {
  try { return await work; } catch (error) {
    if (error instanceof AccountChanged) throw error;
    return fallback;
  }
}

export async function loadDeck(account: AccountHandle): Promise<DeckLoad> {
  const store = loadStore();
  const foods = store.foods;
  const all = Object.values(foods);
  const [favorites, taste, recipes, meals, pantry, eligible] = await Promise.all([
    settle(listFavorites(), []),
    loadTaste({ account }),
    settle(listRecipes(), []),
    settle(allRows(account, "favorites_meals"), []),
    settle(listPantry(), []),
    settle(loadEligibleLocalFoodIds(account, foods).then((set) => set as ReadonlySet<string> | undefined), undefined),
  ]);
  const view: EligibleView | undefined = currentEligibleView(foods, store.settings, eligible);
  const mark = (name: string) => componentRuleMark({ name }, foods, view);
  const byRef = namesByRef(foods, account.userId);
  const mealNames = await Promise.all((meals as Record<string, unknown>[]).filter((row) => !row.deleted_at)
    .map((row) => itemNames(row.items, byRef, account)));
  const recipeNames = await Promise.all(recipes.map((row) => itemNames(row.items, byRef, account)));

  const sources: CandidateInput[] = [
    ...all.filter((food) => food.status === "eats")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((food) => ({ name: food.name, source: "favored" as const, ruleMark: mark(food.name) })),
    ...favorites.filter((row) => row.kind === "food")
      .map((row) => ({ name: row.name, source: "starred" as const, ruleMark: mark(row.name) })),
    // Taste rows are the server's admitted set under the current rules; Avoid still decides below.
    ...(taste.status === "ok" ? taste.items : [])
      .map((row) => ({ name: row.name, source: "eaten" as const, ruleMark: null })),
    ...mealNames.flatMap((row) => row.names)
      .map((name) => ({ name, source: "meal" as const, ruleMark: mark(name) })),
    ...recipeNames.flatMap((row) => row.names)
      .map((name) => ({ name, source: "recipe" as const, ruleMark: mark(name) })),
  ];
  const built = buildCandidates({ sources,
    avoid: all.filter((food) => food.status === "avoid").map((food) => food.name),
    pantry: pantry.map((item) => item.name),
    listed: [] });
  const ranked = await rankCandidates(built.candidates, { account });
  const unnamed = [...mealNames, ...recipeNames].reduce((sum, row) => sum + row.unnamed, 0);
  return { cards: ranked.items, leftOutByRules: built.leftOutByRules, total: built.total, unnamed,
    provenance: ranked.provenance };
}

export function mealCards(preview: ShoppingPreviewResult): MealCard[] {
  return preview.choices.map((choice) => {
    const value = (key: string) => {
      const row = choice.nutritionSnapshot?.[key];
      return row && row.status !== "unknown" && typeof row.value === "number" && Number.isFinite(row.value)
        ? row.value : null;
    };
    return { key: `${choice.localDate}|${choice.slotId}|${choice.recipeId}`, recipeId: choice.recipeId,
      name: choice.recipeName, date: choice.localDate, slotId: choice.slotId,
      kcal: value("kcal"), proteinG: value("protein") };
  }).sort((a, b) => a.date.localeCompare(b.date) || a.slotId.localeCompare(b.slotId));
}

/** Every read and write runs as the account the card was opened under: a switch part-way throws
 *  `AccountChanged`, never a list started as one account and finished as another. */
export function portsFor(account: AccountHandle): BuildFlowPorts {
  return {
    loadDeck: () => loadDeck(account),
    preview: async (input) => {
      const answer = await previewShopping(input, null, account);
      if (answer.blockingIssues.length) throw new Error(answer.blockingIssues[0]);
      return { previewId: answer.previewId, cards: mealCards(answer) };
    },
    save: {
      accept: async (previewId, requestId) => {
        const snapshot = await acceptShopping(previewId, requestId, account);
        return { period: snapshot.period, lines: snapshot.lines };
      },
      create: (draft, requestId) => createShoppingPeriod(draft, requestId, account),
      rename: (id, title, revision, requestId) => renameShoppingPeriod(id, title, revision, requestId, account),
      addLine: (id, name, requestId) => addManualShoppingLine(id, name, requestId, account),
      newId: () => crypto.randomUUID(),
    },
  };
}

export default function BuildListCard() {
  const [account, setAccount] = useState<AccountHandle | null>(() => currentAccountOrNull());
  const [open, setOpen] = useState(false);
  const [run, setRun] = useState(0);
  const [savedNote, setSavedNote] = useState(false);

  useEffect(() => {
    const ready = onAccountReady((next) => { setAccount(next); setOpen(false); setSavedNote(false); });
    const gone = onAccountGone(() => { setAccount(null); setOpen(false); setSavedNote(false); });
    return () => { ready(); gone(); };
  }, []);

  const settings = loadStore().settings;
  const ports = useMemo(() => account ? portsFor(account) : null, [account]);
  if (!account || !ports) return null;

  if (!open) {
    return (
      <CardFrame as="section" tone="olive" size="md" title="Have AI build my list"
        meta={savedNote ? "List saved. It's open below." : "Pick foods and meals, yes or no."}
        footer={<Button variant="tertiary" onClick={() => { setSavedNote(false); setRun((value) => value + 1); setOpen(true); }}>
          Start</Button>} />
    );
  }
  return (
    <CardFrame as="section" size="md" title="Have AI build my list">
      <BuildFlow key={run} accountId={account.userId} countryCode={settings.countryCode ?? null}
          mealCount={mealCountOf(settings)} initialDraft={buildDraft(settings, account.userId)} ports={ports}
          onClose={() => setOpen(false)}
          onSaved={() => { setOpen(false); setSavedNote(true); }} />
    </CardFrame>
  );
}
