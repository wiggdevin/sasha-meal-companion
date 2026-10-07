"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence } from "motion/react";
import Sheet from "@/components/Sheet";
import Button from "@/components/ui/Button";
import Notice from "@/components/ui/Notice";
import { accountFetch, accountHandle, accountJson, assertCurrent, isCurrent,
  onAccountGone, onAccountReady } from "@/lib/device/account";
import { ASSISTANT_NAME } from "@/lib/brand";
import AvoidRules from "@/components/AvoidRules";
import { AvoidFoods } from "@/components/MyFoods";
import type { Food } from "@/lib/foods";
import { searchCatalogRecipes, getCatalogRecipe } from "@/lib/recipe-catalog-client";
import type { RecipeCandidate } from "@/lib/recipe-catalog/types";
import RecipePlanFlow from "@/components/RecipePlanFlow";
import { saveItemOverride } from "@/lib/plan-day-client";
import { SYNCED_EVENT, syncOnce } from "@/lib/sync/client";
import { allOps } from "@/lib/sync/idb";
import { loadStore } from "@/lib/store";
import type { SlotId } from "@/lib/types";
import { similarRecipeOptions } from "@/lib/foods/impact-ranking";
import { postTurn } from "@/lib/coach-client";
import { matchesRule, mayHaveSubingredients, type CustomRule } from "@/lib/policy/custom-rules";
import { sameBaseName } from "@/lib/foods/base-name";
import { avoidFoodDbIds } from "@/lib/recipe-catalog/avoid-food-db";

type Instance = { date: string; slot: string; title: string; source: "recipe" | "edited";
  matched: string; recipeId?: string };
type Impact = { instances: Instance[]; count: number; complete: boolean;
  scope: string; checkedFrom: string; q: string; kind: "ingredient" | "cuisine";
  catalogFoodId: number | null };
type Badge = { count: number; complete: boolean };

/** The most affected meals one request to the assistant may name — the shortcut's existing bound. */
export const ASK_SASHA_MAX_MEALS = 12;
/** The longest free-text question sent, well inside the coach turn's 2 000-character limit. */
export const ASK_SASHA_MAX_QUESTION = 500;

/** `coachTurnRequestSchema` accepts at most this many characters of text; never widen it here. */
export const ASK_SASHA_MAX_TEXT = 2000;

export type AskSashaPayload = { question: string; affectedIds: string[] };

type AskSashaMeal = { date: string; slot: string; title: string };
type AskSashaOptions = { date: string; slot: string; names: string[] };

/**
 * The coach text for one assistant request, inside the transport limit. The user's question and the
 * meal ids lead and are never cut. Verified options are dropped from the end first; only when they
 * are all gone do the meal titles shorten.
 */
export function askSashaText(input: { question?: string; items: AskSashaMeal[];
  options: AskSashaOptions[]; kind: "ingredient" | "cuisine"; excluded: string }): string {
  const ids = input.items.map((item) => `${item.date}:${item.slot}`).join(", ");
  const head = input.question
    ? `${input.question}\n\nThis is about these exact future plan instances (${ids}): `
    : "Suggest similar meal replacements for these exact future plan instances: ";
  const build = (titleMax: number, optionRows: number) => {
    const selection = input.items.map((item) => `${item.date} ${item.slot}${
      titleMax > 0 ? `: ${item.title.slice(0, titleMax)}` : ""}`).join("; ");
    const kept = input.options.slice(0, optionRows).map((row) => `${row.date} ${row.slot}: ${
      row.names.slice(0, 2).map((name) => name.slice(0, 80)).join(", ") || "none found"}`);
    const omitted = input.options.length - kept.length;
    const verified = [...kept, ...(omitted ? [`${omitted} more not listed`] : [])].join("; ");
    return `${head}${selection}. The excluded ${input.kind} is ${input.excluded.slice(0, 80)}. `
      + "Do not change the plan. Current policy-eligible catalog options, filtered for that "
      + `exclusion: ${verified || "none found"}. `
      + "Use my current food rules. If a replacement cannot be verified, say so.";
  };
  for (let rows = input.options.length; rows >= 0; rows -= 1) {
    const text = build(80, rows);
    if (text.length <= ASK_SASHA_MAX_TEXT) return text;
  }
  for (const titleMax of [40, 20, 0]) {
    const text = build(titleMax, 0);
    if (text.length <= ASK_SASHA_MAX_TEXT) return text;
  }
  // Unreachable with the UI's bounds (500-character question, 12 meals); the head still survives.
  return build(0, 0).slice(0, ASK_SASHA_MAX_TEXT);
}

/** What the affected-meals chip says. A complete count is exact; an incomplete one is a lower bound
 *  ("3+ affected"); an incomplete zero is unknown, so it asks to check instead of reading "0+". */
export function affectedLabel(badge: { count: number; complete: boolean }, scope?: string): string {
  if (badge.count === 0) return badge.complete ? "No saved meals affected" : "Check affected meals";
  return `${badge.complete ? badge.count : `${badge.count}+`} affected${scope ? ` ${scope}` : ""}`;
}

/** The user's own wording and the affected-meal ids it is about; blank wording sends nothing. */
export function askSashaPayload(question: string, affectedIds: readonly string[]): AskSashaPayload | null {
  const text = question.trim();
  if (!text) return null;
  return { question: text.slice(0, ASK_SASHA_MAX_QUESTION),
    affectedIds: [...new Set(affectedIds)].slice(0, ASK_SASHA_MAX_MEALS) };
}

export function impactSwipe(dx: number, dy: number): "remove" | "remix" | null {
  if (Math.abs(dx) <= 60 || Math.abs(dx) <= Math.abs(dy)) return null;
  return dx < 0 ? "remove" : "remix";
}

function conflictsWithIntent(recipe: RecipeCandidate, impact: Pick<Impact, "kind" | "q" | "catalogFoodId">): boolean {
  const rule: CustomRule = { id: "impact", kind: impact.kind, text: impact.q };
  if (impact.kind === "cuisine") return !recipe.cuisine || matchesRule(recipe.cuisine, rule);
  const dbIds = new Set(avoidFoodDbIds([impact.q]));
  return recipe.ingredients.some((ingredient) =>
    sameBaseName(ingredient.name, impact.q) || matchesRule(ingredient.name, rule)
    || (typeof ingredient.foodDbId === "string" && dbIds.has(ingredient.foodDbId))
    || mayHaveSubingredients(ingredient.name));
}

export function impactRecipeOptions(
  current: Pick<RecipeCandidate, "name" | "cuisine" | "dishTags" | "totalMinutes">,
  options: readonly RecipeCandidate[], impact: Pick<Impact, "kind" | "q" | "catalogFoodId">,
  excludedRecipeId?: string,
): RecipeCandidate[] {
  return similarRecipeOptions(current,
    options.filter((recipe) => !conflictsWithIntent(recipe, impact)), excludedRecipeId);
}

export default function AvoidImpact({ dietEditor }: { dietEditor?: ReactNode }) {
  const [query, setQuery] = useState("");
  const [selectedCatalogFoodId, setSelectedCatalogFoodId] = useState<number | null>(null);
  const [badges, setBadges] = useState<Record<string, Badge>>({});
  const [invalidBadgeIds, setInvalidBadgeIds] = useState<string[]>([]);
  const [badgeError, setBadgeError] = useState<string | null>(null);
  const [kind, setKind] = useState<"ingredient" | "cuisine">("ingredient");
  const [result, setResult] = useState<Impact | null>(null);
  const [open, setOpen] = useState(false);
  const [editRules, setEditRules] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [replacements, setReplacements] = useState<{ instance: Instance; recipes: RecipeCandidate[] } | null>(null);
  const [flow, setFlow] = useState<{ instance: Instance; recipe: RecipeCandidate } | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [coachIdeas, setCoachIdeas] = useState<{ keys: string[]; names: string[];
    reply: string } | null>(null);
  const [askText, setAskText] = useState("");
  const [verifiedOptions, setVerifiedOptions] = useState<{
    instance: Instance; recipes: RecipeCandidate[] }[] | null>(null);
  const touch = useRef<{ key: string; x: number; y: number } | null>(null);
  const badgeGeneration = useRef(0);
  const requestSequence = useRef(0);
  async function refreshBadges() {
    const generation = ++badgeGeneration.current;
    let h: ReturnType<typeof accountHandle>;
    try { h = accountHandle(); } catch { setBadges({}); return; }
    const allFoods = Object.values(loadStore().foods).filter((food) => food.status === "avoid");
    const valid = (food: Food) => food.id.length >= 1 && food.id.length <= 128
      && food.name.trim().length >= 2 && food.name.trim().length <= 80;
    const foods = allFoods.filter(valid);
    setInvalidBadgeIds(allFoods.filter((food) => !valid(food)).map((food) => food.id));
    if (!foods.length) { setBadges({}); setBadgeError(null); return; }
    try {
      const byId: Record<string, Badge> = {};
      for (let i = 0; i < foods.length; i += 100) {
        const res = await accountFetch(h, "/api/foods/avoid-impact", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ foods: foods.slice(i, i + 100).map((food) =>
            ({ id: food.id, name: food.name,
              ...(typeof food.catalogFoodId === "number" && food.catalogFoodId > 0
                ? { catalogFoodId: food.catalogFoodId } : {}) })) }),
        }, { budget: "search" });
        if (!res.ok) throw new Error("Could not check saved future meals.");
        Object.assign(byId, (await accountJson<{ byId: Record<string, Badge> }>(h, res)).byId);
      }
      assertCurrent(h);
      if (generation === badgeGeneration.current) { setBadges(byId); setBadgeError(null); }
    } catch {
      if (generation === badgeGeneration.current) {
        setBadges({}); setBadgeError("Could not check saved future meals. Retry below.");
      }
    }
  }
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const generationRef = badgeGeneration;
    const refresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void refreshBadges(); }, 150);
    };
    refresh();
    window.addEventListener(SYNCED_EVENT, refresh);
    const offReady = onAccountReady(refresh);
    const offGone = onAccountGone(() => { ++badgeGeneration.current; ++requestSequence.current;
      setBadges({}); setInvalidBadgeIds([]);
      setResult(null); setOpen(false); setBadgeError(null); setCoachIdeas(null); setVerifiedOptions(null);
      setSelectedKeys([]); setReplacements(null); setFlow(null); setNotice(null);
      setError(null); setQuery(""); setSelectedCatalogFoodId(null); setBusy(false); setAskText(""); });
    return () => { ++generationRef.current; if (timer) clearTimeout(timer);
      window.removeEventListener(SYNCED_EVENT, refresh);
      offReady(); offGone(); };
  }, []);
  async function readImpact(q = query, requestedKind = kind,
    h = accountHandle(), catalogFoodId = selectedCatalogFoodId): Promise<Impact> {
    const params = new URLSearchParams({ q: q.trim(), kind: requestedKind,
      ...(typeof catalogFoodId === "number" && catalogFoodId > 0
        ? { catalogFoodId: String(catalogFoodId) } : {}) });
    const res = await accountFetch(h, `/api/foods/avoid-impact?${params}`,
      { cache: "no-store" }, { budget: "search" });
    if (!res.ok) throw new Error("Could not check saved future meals. Try again.");
    const impact = await accountJson<Omit<Impact, "q" | "kind" | "catalogFoodId">>(h, res);
    return { ...impact, q: q.trim(), kind: requestedKind, catalogFoodId };
  }
  async function check() {
    if (query.trim().length < 2) return;
    const h = accountHandle();
    const request = ++requestSequence.current;
    setBusy(true); setError(null); setResult(null); setVerifiedOptions(null);
    try {
      const impact = await readImpact(query, kind, h);
      if (isCurrent(h) && request === requestSequence.current) setResult(impact);
    } catch (cause) { if (isCurrent(h) && request === requestSequence.current) setError(cause instanceof Error ? cause.message : "Could not check future meals."); }
    finally { if (isCurrent(h) && request === requestSequence.current) setBusy(false); }
  }
  async function onAvoidSaved(food: Food) {
    const h = accountHandle();
    await refreshBadges();
    if (!isCurrent(h)) return;
    if (food.status !== "avoid") return;
    const request = ++requestSequence.current;
    setQuery(food.name); setKind("ingredient");
    setSelectedCatalogFoodId(food.catalogFoodId ?? null); setError(null); setVerifiedOptions(null);
    try {
      const impact = await readImpact(food.name, "ingredient", h, food.catalogFoodId ?? null);
      if (!isCurrent(h) || request !== requestSequence.current) return;
      setResult(impact);
      if (impact.count || !impact.complete) {
        setSelectedKeys(impact.instances.map(keyOf)); setOpen(true);
      }
      else setNotice(`No matching saved future meal was found for ${food.name}.`);
    } catch { if (isCurrent(h) && request === requestSequence.current) setError("Could not check saved future meals. Try again."); }
  }
  function renderAvoidStatus(food: Food) {
    if (invalidBadgeIds.includes(food.id)) return <span className="text-caption text-alert">
      Cannot check this food’s impact. Edit its name to 2–80 characters.
    </span>;
    const badge = badges[food.id];
    if (!badge) return <span className="text-caption text-graphite">Impact check pending</span>;
    // A complete zero is good news in quiet words; an incomplete zero is unknown, never "0+".
    if (badge.count === 0 && badge.complete) return <span className="text-caption text-muted">No saved meals affected</span>;
    const label = affectedLabel(badge);
    return <button type="button" className="tap min-h-11 rounded-xl border border-alert/20 bg-alert/5 px-3 text-caption text-alert"
      aria-label={badge.count === 0 ? `Check affected saved future meals for ${food.name}`
        : `${badge.complete ? badge.count : `${badge.count} or more`} affected saved future meals for ${food.name}`}
      onClick={() => { const h = accountHandle(); const request = ++requestSequence.current;
        setQuery(food.name); setKind("ingredient");
        setSelectedCatalogFoodId(food.catalogFoodId ?? null); setError(null); setResult(null);
        setVerifiedOptions(null);
        void readImpact(food.name, "ingredient", h, food.catalogFoodId ?? null).then((impact) => {
          if (!isCurrent(h) || request !== requestSequence.current) return;
          setResult(impact); setSelectedKeys(impact.instances.map(keyOf)); setOpen(true);
        }).catch(() => { if (isCurrent(h) && request === requestSequence.current)
          setError("Could not check saved future meals. Try again."); }); }}>
      {label}
    </button>;
  }
  const keyOf = (item: Instance) => `${item.date}:${item.slot}`;
  async function loadReplacementOptions(items: Instance[], impact: Impact,
    h: ReturnType<typeof accountHandle>) {
    const found = await searchCatalogRecipes({ query: "", limit: 64 }, new AbortController().signal);
    assertCurrent(h);
    const ids = [...new Set(items.flatMap((item) => item.recipeId ? [item.recipeId] : []))];
    const details = await Promise.all(ids.map(async (id) => {
      try { return [id, await getCatalogRecipe(id)] as const; }
      catch { return null; }
    }));
    assertCurrent(h);
    const byId = new Map(details.filter((item): item is readonly [string, RecipeCandidate] => item !== null));
    return items.map((instance) => ({ instance,
      recipes: impactRecipeOptions(byId.get(instance.recipeId ?? "") ?? {
        name: instance.title, cuisine: null, dishTags: [], totalMinutes: null,
      }, found.recipes, impact, instance.recipeId),
    }));
  }
  /**
   * One coach path for the shortcut and the free-text question. Both re-check the selection against
   * the server and send only verified, exclusion-filtered options; `question` adds the user's own
   * wording and the exact affected ids ahead of that context. Nothing here changes the plan.
   */
  async function askSasha(items: Instance[], question?: string): Promise<boolean> {
    if (!items.length) return false;
    if (items.length > ASK_SASHA_MAX_MEALS) {
      setError(`Select up to ${ASK_SASHA_MAX_MEALS} future meals to ask ${ASSISTANT_NAME} about at once.`);
      return false;
    }
    const impact = result;
    if (!impact) return false;
    const h = accountHandle();
    setBusy(true); setError(null); setCoachIdeas(null); setVerifiedOptions(null);
    try {
      const current = await readImpact(impact.q, impact.kind, h, impact.catalogFoodId);
      assertCurrent(h);
      const keys = new Set(current.instances.map(keyOf));
      if (items.some((item) => !keys.has(keyOf(item)))) {
        throw new Error("A selected meal changed. Refresh the affected list first.");
      }
      const options = await loadReplacementOptions(items, impact, h);
      assertCurrent(h);
      setVerifiedOptions(options);
      const response = await postTurn({ threadId: null, messageId: crypto.randomUUID(),
        text: askSashaText({ question, items, kind: impact.kind, excluded: impact.q,
          options: options.map(({ instance, recipes }) => ({ date: instance.date,
            slot: instance.slot, names: recipes.map((recipe) => recipe.name) })) }) },
        { account: h });
      assertCurrent(h);
      const rule: CustomRule = { id: "impact", kind: impact.kind, text: impact.q };
      const names = response.suggestions.filter((suggestion) => suggestion.verdict === "allowed"
        && !matchesRule(suggestion.name, rule))
        .map((suggestion) => suggestion.name);
      setCoachIdeas({ keys: items.map(keyOf), names,
        reply: response.messages.findLast((message) => message.role === "assistant")?.content
          ?? "No response was available." });
      return true;
    } catch (cause) {
      if (isCurrent(h)) setError(cause instanceof Error ? cause.message : `Could not ask ${ASSISTANT_NAME}. Try again.`);
      return false;
    }
    finally { if (isCurrent(h)) setBusy(false); }
  }
  async function askInOwnWords(impact: Impact) {
    // The checked meals, or every listed one when none is checked, bounded to the request limit.
    const payload = askSashaPayload(askText, selectedKeys.length
      ? selectedKeys : impact.instances.map(keyOf));
    if (!payload) return;
    const items = payload.affectedIds.flatMap((id) =>
      impact.instances.filter((item) => keyOf(item) === id));
    if (await askSasha(items, payload.question)) setAskText("");
  }
  async function remove(item: Instance) {
    const impact = result;
    if (!impact) return;
    const h = accountHandle();
    setBusy(true); setError(null); setNotice(null);
    try {
      if (!/^meal-[1-6]$/.test(item.slot)) throw new Error("This meal slot cannot be edited here.");
      const before = await syncOnce(h);
      assertCurrent(h);
      if (before.push.failed) throw new Error("Sync your plans before changing this meal.");
      const current = await readImpact(impact.q, impact.kind, h, impact.catalogFoodId);
      assertCurrent(h);
      if (!current.instances.some((row) => keyOf(row) === keyOf(item))) {
        throw new Error("This meal changed. Refresh the affected list.");
      }
      const day = loadStore().days[item.date];
      if (day?.eaten?.[item.slot as SlotId] || day?.consumedSlots?.[item.slot as SlotId]) {
        throw new Error("This meal was already eaten and stays in your history.");
      }
      await saveItemOverride(item.date, item.slot as SlotId,
        { baseMealId: null, components: [], removed: true, cleared: true });
      assertCurrent(h);
      const after = await syncOnce(h);
      const pending = (await allOps(h)).some((op) => op.entity === "plan_days" && op.entity_id === item.date);
      assertCurrent(h);
      setNotice(after.push.failed || pending
        ? "Removed on this device; server sync is pending."
        : "Future meal removed. Eaten history is unchanged.");
      setConfirmRemove(null);
      try {
        const refreshed = await readImpact(impact.q, impact.kind, h, impact.catalogFoodId);
        if (isCurrent(h)) setResult(refreshed);
      } catch { if (isCurrent(h)) setNotice("Future meal removed. Refresh the affected list to check the latest count."); }
    } catch (cause) { if (isCurrent(h)) setError(cause instanceof Error ? cause.message : "Could not remove this meal."); }
    finally { if (isCurrent(h)) setBusy(false); }
  }
  async function remix(item: Instance) {
    const impact = result;
    if (!impact) return;
    const h = accountHandle();
    setBusy(true); setError(null); setNotice(null);
    try {
      const [{ recipes }] = await loadReplacementOptions([item], impact, h);
      assertCurrent(h);
      setReplacements({ instance: item, recipes });
      if (recipes.length === 0) setNotice("No verified replacement recipe is ready under your current rules.");
    } catch (cause) { if (isCurrent(h)) setError(cause instanceof Error ? cause.message : "Could not check replacement recipes."); }
    finally { if (isCurrent(h)) setBusy(false); }
  }
  async function edit(item: Instance) {
    const impact = result;
    if (!impact) return;
    if (!item.recipeId) { setNotice("This edited meal has no recipe to reopen. Choose a verified replacement instead."); return; }
    const h = accountHandle();
    setBusy(true); setError(null);
    try {
      const recipe = await getCatalogRecipe(item.recipeId);
      assertCurrent(h);
      if (recipe.eligibility.status !== "eligible" || conflictsWithIntent(recipe, impact)) {
        throw new Error("This recipe conflicts with the checked exclusion. Choose a replacement.");
      }
      setFlow({ instance: item, recipe });
    } catch (cause) { if (isCurrent(h)) setError(cause instanceof Error ? cause.message : "Could not edit this meal."); }
    finally { if (isCurrent(h)) setBusy(false); }
  }
  return <><AvoidFoods renderAvoidStatus={renderAvoidStatus} onAvoidSaved={(food) => {
    void onAvoidSaved(food);
  }} />
  {/* A card standing on the ground: E1 (U11). */}
  <div className="shell"><section className="surface flex flex-col gap-3 p-4" aria-label="Affected future meals">
    <h2 className="m-0 text-caption font-medium text-charcoal">Affected future meals</h2>
    <p className="m-0 text-caption text-graphite">Check a food or cuisine against saved future meals. Eaten meals stay as recorded.</p>
    {badgeError && <Notice tone="error" title={badgeError} />}
    <div role="group" aria-label="Impact type" className="flex gap-2">
      {(["ingredient", "cuisine"] as const).map((value) => <Button key={value} size="sm"
        variant={kind === value ? "primary" : "tertiary"}
        aria-pressed={kind === value} onClick={() => { ++requestSequence.current;
          setKind(value); setBusy(false); setSelectedCatalogFoodId(null); setResult(null); }}>
        {value === "ingredient" ? "Ingredient" : "Cuisine"}
      </Button>)}
    </div>
    <div className="flex gap-2">
      <input aria-label="Food or cuisine to check" className="well min-h-11 min-w-0 flex-1 px-3 text-caption"
        value={query} onChange={(event) => { ++requestSequence.current;
          setQuery(event.target.value); setBusy(false);
          setSelectedCatalogFoodId(null); setResult(null); }}
        onKeyDown={(event) => { if (event.key === "Enter") void check(); }} />
      <Button variant="secondary" disabled={query.trim().length < 2} status={busy ? "pending" : undefined}
        onClick={() => void check()}>Check</Button>
    </div>
    {!(open && result) && error && <Notice tone="error" title={error} />}
    {!(open && result) && notice && <Notice tone="attention" title={notice} />}
    {result && <>
      {result.count === 0 && result.complete
        ? <Notice tone="neutral" title={affectedLabel(result)} />
        : <Button variant="danger" className="self-start"
          onClick={() => { setSelectedKeys(result.instances.map(keyOf)); setOpen(true); }}>
          {affectedLabel(result, result.scope)}
        </Button>}
      {!result.complete && <Notice tone="attention"
        title="Some saved ingredients, swaps or edits could not be classified; this is a lower bound." />}
    </>}
    {/* The shared Sheet: top X, Escape, scrim tap and pull-down all close it (2026-10-01). */}
    <AnimatePresence>
    {open && result && <Sheet key="affected" title="Affected saved meals"
      subtitle="These are future saved instances. Existing intake history is unchanged."
      onClose={() => setOpen(false)}>
      <div className="flex min-w-0 flex-col">
      <p className="text-caption text-graphite">Select exact meals to ask {ASSISTANT_NAME} about. Suggestions do not change the plan.</p>
      {error && <Notice tone="error" title={error} />}
      {notice && <Notice tone="attention" title={notice} />}
      {result.instances.length === 0 && <Notice tone="neutral"
        title={result.complete ? "No saved future meal matched."
          : "No verified match found; some saved meals could not be checked."} />}
      {result.instances.map((item) => <div key={keyOf(item)}
        className="well my-2 flex flex-col gap-2 rounded-xl p-3 text-caption"
        onTouchStart={(event) => { const point = event.touches[0];
          touch.current = point ? { key: keyOf(item), x: point.clientX, y: point.clientY } : null; }}
        onTouchEnd={(event) => {
          const start = touch.current;
          touch.current = null;
          if (start?.key !== keyOf(item)) return;
          const point = event.changedTouches[0];
          if (!point) return;
          const action = impactSwipe(point.clientX - start.x, point.clientY - start.y);
          if (action === "remove") setConfirmRemove(keyOf(item));
          if (action === "remix") void remix(item);
        }} onTouchCancel={() => { touch.current = null; }}>
        <strong>{item.date} · {item.slot} · {item.title}</strong>
        <span>Matched {item.matched}</span>
        <label className="flex min-h-11 items-center gap-2">
          <input type="checkbox" checked={selectedKeys.includes(keyOf(item))}
            onChange={(event) => setSelectedKeys((keys) => event.target.checked
              ? [...new Set([...keys, keyOf(item)])] : keys.filter((key) => key !== keyOf(item)))} />
          Ask {ASSISTANT_NAME} about this meal
        </label>
        <div className="flex flex-wrap gap-2">
          <Button variant="tertiary" size="sm" disabled={busy}
            onClick={() => setConfirmRemove(keyOf(item))}>Remove</Button>
          <Button variant="tertiary" size="sm" disabled={busy}
            onClick={() => void remix(item)}>Remix</Button>
          <Button variant="tertiary" size="sm" disabled={busy}
            onClick={() => void edit(item)}>Edit</Button>
        </div>
        {confirmRemove === keyOf(item) && <div role="group" aria-label={`Confirm remove ${item.title}`}
          className="flex flex-wrap gap-2">
          <Button variant="danger" size="sm" data-armed="true" disabled={busy}
            onClick={() => void remove(item)}>Remove future instance</Button>
          <Button variant="tertiary" size="sm"
            onClick={() => setConfirmRemove(null)}>Cancel</Button>
        </div>}
      </div>)}
      <Button variant="secondary" disabled={selectedKeys.length === 0} status={busy ? "pending" : undefined}
        onClick={() => void askSasha(result.instances.filter((item) => selectedKeys.includes(keyOf(item))))}>
        {`Ask ${ASSISTANT_NAME} for selected replacements`}
      </Button>
      <div className="my-3 flex flex-col gap-2">
        <label className="flex flex-col gap-1.5 text-caption">
          <span>Ask {ASSISTANT_NAME} about these meals</span>
          <textarea value={askText} rows={3} maxLength={ASK_SASHA_MAX_QUESTION} disabled={busy}
            placeholder="In your own words"
            className="well min-h-11 px-3 py-2 text-caption outline-none disabled:opacity-40"
            onChange={(event) => setAskText(event.target.value)} />
        </label>
        <Button variant="secondary" className="self-start" disabled={busy || !askText.trim()}
          onClick={() => void askInOwnWords(result)}>
          Send to {ASSISTANT_NAME}
        </Button>
      </div>
      {verifiedOptions && <div className="well my-3 flex flex-col gap-3 rounded-xl p-3 text-caption"
        aria-label="Verified recipe options for selected meals">
        <strong>Verified recipe options</strong>
        {verifiedOptions.map(({ instance, recipes }) => <div key={keyOf(instance)}
          className="flex flex-col gap-2">
          <span>{instance.date} · {instance.slot} · {instance.title}</span>
          {recipes.length ? recipes.map((recipe) => <Button variant="tertiary" block
            key={recipe.revisionId} className="justify-start"
            onClick={() => setFlow({ instance, recipe })}>
            Review {recipe.name} for this meal
          </Button>) : <span>No verified catalog replacement found for this meal.</span>}
        </div>)}
        <p className="m-0">Review the portion and accept to change a future meal. No plan changed here.</p>
      </div>}
      {coachIdeas && <div className="well my-3 rounded-xl p-3 text-caption" role="status">
        <strong>{ASSISTANT_NAME} on {coachIdeas.keys.join(", ")}</strong>
        <p className="whitespace-pre-wrap">{coachIdeas.reply}</p>
        {coachIdeas.names.length > 0 && <p>Food ideas to review: {coachIdeas.names.join(", ")}.</p>}
        <p>These ideas are not verified against an unsaved exclusion. Save the rule and review any idea through Remix before changing a future meal. No plan changed here.</p>
      </div>}
      {replacements && <div className="my-3 flex flex-col gap-2" aria-label="Replacement recipes to review">
        <h4 className="m-0 text-caption">Similar options for {replacements.instance.date}, {replacements.instance.slot}</h4>
        {replacements.recipes.map((recipe) => <Button variant="tertiary" block key={recipe.revisionId}
          className="justify-start"
          onClick={() => {
            if (recipe.eligibility.status !== "eligible" || conflictsWithIntent(recipe, result)) {
              setError("This replacement conflicts with the checked exclusion. Refresh options."); return;
            }
            setFlow({ instance: replacements.instance, recipe }); setReplacements(null);
          }}>
          {recipe.name} · {recipe.totalMinutes ?? "time unknown"} min
        </Button>)}
      </div>}
      <p className="text-caption text-graphite">Save a new exclusion before accepting a replacement so the server can enforce it.</p>
      {flow && <RecipePlanFlow recipe={flow.recipe} initialDate={flow.instance.date}
        initialSlotId={flow.instance.slot} onClose={() => setFlow(null)}
        onPlanned={() => { setFlow(null); void check(); }} />}
      <Button variant="tertiary" aria-expanded={editRules}
        onClick={() => setEditRules((value) => !value)}>
        {editRules ? "Hide food settings" : "Edit food settings here"}
      </Button>
      {editRules && <div className="mt-3 flex flex-col gap-3">{dietEditor}<AvoidRules /></div>}
      </div>
    </Sheet>}
    </AnimatePresence>
  </section></div></>;
}
