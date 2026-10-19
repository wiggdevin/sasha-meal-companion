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
 * - left out: the pantry (`listPantry()`) and lines already on the open list (`getShoppingPeriod`).
 * Each food's rule mark is judged against the verified eligible set (`loadEligibleLocalFoodIds`,
 * `componentRuleMark`); a failed read leaves the marks unknown, never clear. Jev may then reorder
 * the deck (lib/shopping/build-rank-client.ts), and only reorder it.
 */
import { useEffect, useMemo, useState } from "react";
import Button from "@/components/ui/Button";
import CardFrame from "@/components/ui/CardFrame";
import BuildFlow, { type BuildFlowPorts, type DeckLoad } from "@/components/shopping/build/BuildFlow";
import { savedArea } from "@/components/shopping/build/StepStores";
import { AccountChanged, currentAccountOrNull, onAccountGone, onAccountReady,
  type AccountHandle } from "@/lib/device/account";
import { listFavorites } from "@/lib/favorites-client";
import type { Food } from "@/lib/foods";
import { loadEligibleLocalFoodIds } from "@/lib/foods/eligible-client";
import { readPrefRefCache } from "@/lib/foods/prefs-client";
import { componentRuleMark, currentEligibleView, type EligibleView } from "@/lib/foods/rule-marks";
import { loadTaste } from "@/lib/foods/taste-client";
import { listRecipes } from "@/lib/recipes-client";
import { acceptShopping, addManualShoppingLine, getShoppingPeriod, listPantry,
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

/** The next 7 days and every one of the account's own meals. */
export function buildDraft(settings: Settings, accountId: string): ShoppingDraft {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const draft = defaultShoppingDraft(dateInZone(timezone), timezone);
  const effort = cookingEffortFromDietPrefs(settings.dietPrefs);
  const meals = Array.from({ length: mealCountOf(settings) }, (_, index) => `meal-${index + 1}`);
  return { ...draft, mealCoverage: meals, locale: savedArea(accountId) || null,
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
function itemNames(items: unknown, byRef: Map<string, string>): string[] {
  if (!Array.isArray(items)) return [];
  return items.flatMap((item: Record<string, unknown>) => {
    if (typeof item?.name === "string" && item.name.trim()) return [item.name];
    const ref = typeof item?.food_ref_id === "string" ? byRef.get(item.food_ref_id) : undefined;
    return ref ? [ref] : [];
  });
}

async function settle<T>(work: Promise<T>, fallback: T): Promise<T> {
  try { return await work; } catch (error) {
    if (error instanceof AccountChanged) throw error;
    return fallback;
  }
}

export async function loadDeck(account: AccountHandle, periodId: string | null | undefined): Promise<DeckLoad> {
  const store = loadStore();
  const foods = store.foods;
  const all = Object.values(foods);
  const [favorites, taste, recipes, meals, pantry, period, eligible] = await Promise.all([
    settle(listFavorites(), []),
    loadTaste({ account }),
    settle(listRecipes(), []),
    settle(allRows(account, "favorites_meals"), []),
    settle(listPantry(), []),
    periodId ? settle(getShoppingPeriod(periodId), { period: null, lines: [] }) : Promise.resolve({ period: null, lines: [] }),
    settle(loadEligibleLocalFoodIds(account, foods).then((set) => set as ReadonlySet<string> | undefined), undefined),
  ]);
  const view: EligibleView | undefined = currentEligibleView(foods, store.settings, eligible);
  const mark = (name: string) => componentRuleMark({ name }, foods, view);
  const byRef = namesByRef(foods, account.userId);

  const sources: CandidateInput[] = [
    ...all.filter((food) => food.status === "eats")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((food) => ({ name: food.name, source: "favored" as const, ruleMark: mark(food.name) })),
    ...favorites.filter((row) => row.kind === "food")
      .map((row) => ({ name: row.name, source: "starred" as const, ruleMark: mark(row.name) })),
    // Taste rows are the server's admitted set under the current rules; Avoid still decides below.
    ...(taste.status === "ok" ? taste.items : [])
      .map((row) => ({ name: row.name, source: "eaten" as const, ruleMark: null })),
    ...(meals as Record<string, unknown>[]).filter((row) => !row.deleted_at)
      .flatMap((row) => itemNames(row.items, byRef))
      .map((name) => ({ name, source: "meal" as const, ruleMark: mark(name) })),
    ...recipes.flatMap((row) => itemNames(row.items, byRef))
      .map((name) => ({ name, source: "recipe" as const, ruleMark: mark(name) })),
  ];
  const built = buildCandidates({ sources,
    avoid: all.filter((food) => food.status === "avoid").map((food) => food.name),
    pantry: pantry.map((item) => item.name),
    listed: period.lines.map((line) => line.name) });
  const ranked = await rankCandidates(built.candidates, { account });
  return { cards: ranked.items, leftOutByRules: built.leftOutByRules, total: built.total,
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

function portsFor(account: AccountHandle, periodId: string | null | undefined): BuildFlowPorts {
  return {
    loadDeck: () => loadDeck(account, periodId),
    preview: async (input) => {
      const answer = await previewShopping(input, null);
      if (answer.blockingIssues.length) throw new Error(answer.blockingIssues[0]);
      return { previewId: answer.previewId, cards: mealCards(answer) };
    },
    save: {
      accept: async (previewId, requestId) => {
        const snapshot = await acceptShopping(previewId, requestId);
        return { period: snapshot.period, lines: snapshot.lines };
      },
      rename: (id, title, revision, requestId) => renameShoppingPeriod(id, title, revision, requestId),
      addLine: (id, name, requestId) => addManualShoppingLine(id, name, requestId, account),
      newId: () => crypto.randomUUID(),
    },
  };
}

export default function BuildListCard({ periodId }: { periodId?: string | null }) {
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
  const ports = useMemo(() => account ? portsFor(account, periodId) : null, [account, periodId]);
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
