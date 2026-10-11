/**
 * Browser side of the Phase 1 catalog — phase-1-catalog.md "Client changes".
 *
 * Two tiers, never mixed. Online: GET /api/foods/search, the §4.1 ranking, their prefs and log
 * counts already folded into the score by the RPC. Offline (a failed fetch, or a 503 meaning no
 * catalog version is active): the bundled lib/food-db.json, labelled "offline results" by the UI.
 * An abort is not a failure — it propagates so a superseded keystroke does not paint stale rows.
 */
import { getRevision, putRevision, type CachedRevision } from "@/lib/db/catalog-cache";
import {
  accountFetch, accountHandle, accountJson, rethrowAccountChanged, type AccountHandle,
} from "@/lib/device/account";
import type { Food } from "@/lib/foods";
import { searchFoods as searchBundledFoods, type SearchHit } from "@/lib/food-db";
import type { Portion } from "@/lib/foods/portions";
import type { CatalogSource, FoodDetail, FoodSearchHit } from "@/lib/server/catalog";
import { foodDiscoveryTerms, type PrepState } from "@/lib/search/query";

/** phase-1-catalog.md, Client changes: "one AbortController per keystroke, 200 ms debounce". */
export const SEARCH_DEBOUNCE_MS = 200;

/**
 * Read through `process.env` on every call, never captured in a module const: Next inlines the
 * member expression at build time, and a function keeps the value readable in vitest too.
 */
export function catalogSearchEnabled(): boolean {
  return process.env.NEXT_PUBLIC_CATALOG_SEARCH === "1";
}

export type SearchOptions = {
  brand?: string;
  prep?: PrepState;
  limit?: number;
  mine?: Record<string, Food>;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** The account the search runs for (hits carry its policy verdicts). Default: the bound one. */
  account?: AccountHandle;
  /** Also search the foods a named policy category covers (`foodDiscoveryTerms`). */
  discover?: boolean;
};

export type SearchResult =
  | { kind: "empty" }
  | {
      kind: "online"; hits: FoodSearchHit[]; queryClass: "branded" | "generic";
      autoResolve: { revisionId: number; score: number; margin: number } | null;
      catalogVersion: string;
    }
  | { kind: "offline"; hits: SearchHit[]; reason: "no_catalog" | "network" | "no_match" };

export type CatalogRow = {
  key: string;
  catalogFoodId: number | null;
  revisionId: number | null;
  description: string;
  brand: string | null;
  sourceTile: "USDA" | "MINE" | "OFF";
  qualityFlags: string[];
  prefStatus: "eats" | "avoid" | null;
  score: number;
  offline: boolean;
  offPlan: string[];
  offlineFoodId?: string;
  offlineSource?: "db" | "mine";
  /**
   * Serving data (UI lane contract, lib/foods/portions.ts) — carried from the online hit or the
   * offline bundled row alike, so one row shape serves both tiers. Optional, not inherited from
   * `FoodSearchHit`/`SearchHit` as required fields: components/LogFoodSheet.tsx's favorites-strip
   * tap builds a `CatalogRow` by hand with none of this (out of this change's scope to touch),
   * and `toRows` below still always sets them for a row built from a real search or offline hit.
   */
  kcalPer100g?: number | null;
  per100g?: { kcal: number | null; protein: number | null; carbs: number | null; fat: number | null } | null;
  portions?: Portion[];
  defaultPortion?: Portion | null;
};

/**
 * Off-plan markers for a catalog description — a faithful port of `flags()` in
 * scripts/build-food-db.py (the DAIRY / DAIRY_OK / GLUTEN / GLUTEN_OK / APPLE classes), so a
 * catalog row and a bundled row mark the same food the same way. The `_OK` class excludes a match.
 * Marking, never hiding: an honest log is worth more than a tidy one.
 */
const DAIRY =
  /\b(milk|cheese|yogurt|butter|cream|whey|ghee|ice cream|cheesecake|latte|cappuccino|alfredo|ricotta|feta|brie|mozzarella|parmesan|cheddar|provolone|swiss|pudding|frozen yogurt|hot chocolate|chocolate milk)\b/i;
const DAIRY_OK =
  /\b(almond milk|oat milk|soy milk|coconut milk|coconut water|peanut butter|almond butter|cashew butter|sesame butter|sunflower seed butter|cocoa butter|butternut|buttercup)\b/i;
const GLUTEN =
  /\b(bread|bagel|muffin|croissant|bun|roll|pita|naan|flour tortilla|pancake|waffle|french toast|spaghetti|pasta|noodle|couscous|barley|farro|spelt|wheat|rye|semolina|malt|bulgur|cracker|pretzel|cookie|brownie|cake|donut|pie|cinnamon|pop-tart|ramen|lo mein|dumpling|pierogi|sandwich|burger|pizza|burrito|quesadilla|enchilada|egg roll|spring roll|corn dog|mac|macaroni|lasagna|ziti|gnocchi|biscuit|cornbread|granola|cheerios|corn flakes|cream of wheat|beer|soy sauce|teriyaki|fish sticks|breaded|fried chicken|chicken nuggets|chicken tenders|onion rings|mozzarella sticks|crab cake|meatball|meatloaf|pot pie|gyro|sub |toast|graham|goldfish|rice krispies|oatmeal cookie|oreo|kit kat|falafel|shepherd)\b/i;
const GLUTEN_OK = /\b(rice noodles|corn tortilla|rice cake|buckwheat|quinoa|gluten-free)\b/i;
const APPLE = /\bapple/i;

export function offPlanFlags(name: string): string[] {
  const out: string[] = [];
  if (GLUTEN.test(name) && !GLUTEN_OK.test(name)) out.push("gluten");
  if (DAIRY.test(name) && !DAIRY_OK.test(name)) out.push("dairy");
  if (APPLE.test(name)) out.push("apple");
  return out;
}

/** `evaluatePolicy`'s reason string (`allergen:X`, `category:X`, or the bare `avoid_list`) → the
 *  short tag `offPlan` renders. Every blocked reason gets a tag — not only allergens — so a
 *  banned category or a personal avoid-list match reaches the row the same way. */
function tagForBlockedReason(reason: string): string {
  if (reason.startsWith("allergen:")) return reason.slice("allergen:".length);
  if (reason.startsWith("category:")) return reason.slice("category:".length);
  return reason;
}

/**
 * A search hit's off-plan markers: the name-only regex, plus whatever the server's real
 * policy verdict (`evaluatePolicy`) already found blocked — allergen, banned category, or them
 * own avoid list. The server verdict is the more trustworthy signal — it reads actual ingredients
 * and their real preferences, not just the product name — so a hit it blocked on anything the name
 * never mentions still has to show up here, never silently dropped.
 */
export function offPlanFor(item: {
  description: string; brand?: string | null;
  policy?: { verdict: string; reason?: string } | null;
}): string[] {
  const nameFlags = offPlanFlags(`${item.description} ${item.brand ?? ""}`);
  const reason = item.policy?.verdict === "blocked" ? item.policy.reason : undefined;
  const verdictTag = reason ? tagForBlockedReason(reason) : null;
  return verdictTag && !nameFlags.includes(verdictTag) ? [...nameFlags, verdictTag] : nameFlags;
}

const offPlanForHit = (h: FoodSearchHit): string[] => offPlanFor(h);

function searchUrl(q: string, opts: SearchOptions): string {
  const params = new URLSearchParams({ q, limit: String(opts.limit ?? 25) });
  if (opts.brand) params.set("brand", opts.brand);
  if (opts.prep) params.set("prep", opts.prep);
  return `/api/foods/search?${params.toString()}`;
}

function offline(q: string, reason: "no_catalog" | "network" | "no_match", mine: Record<string, Food>): SearchResult {
  return { kind: "offline", reason, hits: searchBundledFoods(q, mine) };
}

export async function searchFoods(q: string, opts: SearchOptions = {}): Promise<SearchResult> {
  const query = q.trim();
  if (!query) return { kind: "empty" };
  const h = opts.account ?? accountHandle();
  let res: Response;
  try {
    res = await accountFetch(h, searchUrl(query, opts),
      { signal: opts.signal, headers: { accept: "application/json" } },
      { budget: "search", fetchImpl: opts.fetchImpl });
  } catch (e) {
    rethrowAccountChanged(e);
    // A deadline is not a DOMException, so it falls through to the offline tier below — which is
    // exactly what a search that never answered should do.
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    return offline(query, "network", opts.mine ?? {});
  }
  if (res.status === 503) return offline(query, "no_catalog", opts.mine ?? {});
  if (!res.ok) return offline(query, "network", opts.mine ?? {});
  type Body = {
    hits: FoodSearchHit[]; queryClass: "branded" | "generic";
    autoResolve: { revisionId: number; score: number; margin: number } | null;
    catalogVersion: string;
  };
  let body: Body;
  try {
    body = await accountJson<Body>(h, res);
  } catch (e) {
    rethrowAccountChanged(e);
    // The budget covers the body, so a search can run out of it here just as easily as on the
    // request — and the answer is the same one: the foods on this phone (Grok pass 26, HIGH 2).
    return offline(query, "network", opts.mine ?? {});
  }
  // A zero-hit catalog search (including a stale synonym index) must still expose the
  // independently sourced bundled food identities. The row stays visibly marked offline.
  if (!body.hits?.length && searchBundledFoods(query, opts.mine ?? {}).length) {
    return offline(query, "no_match", opts.mine ?? {});
  }
  return {
    kind: "online", hits: body.hits ?? [], queryClass: body.queryClass,
    autoResolve: body.autoResolve ?? null, catalogVersion: body.catalogVersion,
  };
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** The first row for each identity, in order: the raw phrase's rows lead, alias rows follow. */
function uniqueBy<T>(rows: T[], key: (row: T) => string | number): T[] {
  const seen = new Set<string | number>();
  return rows.filter((row) => {
    const k = key(row);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * One tier per list, never mixed: the raw phrase decides it, except that a healthy catalog with no
 * hit for the phrase itself defers to catalog hits its category aliases found. Rows merge by the
 * same stable identity `toRows` keys them on. Only the raw phrase's own answer may auto-resolve.
 */
function mergeDiscovery(primary: SearchResult, extra: SearchResult[], limit: number): SearchResult {
  if (primary.kind === "empty") return primary;
  const online = extra.filter((r): r is Extract<SearchResult, { kind: "online" }> =>
    r.kind === "online");
  const base = primary.kind === "online" ? primary
    : primary.reason === "no_match" ? online.find((r) => r.hits.length > 0) : undefined;
  if (base) {
    const hits = uniqueBy([base, ...online].flatMap((r) => r.hits), (h) => h.revisionId);
    return { ...base, hits: hits.slice(0, limit),
      autoResolve: base === primary ? base.autoResolve : null };
  }
  if (primary.kind !== "offline") return primary;
  const hits = uniqueBy([primary, ...extra].flatMap((r) => r.kind === "offline" ? r.hits : []),
    (h) => `${h.source}:${h.id}`);
  return { ...primary, hits: hits.slice(0, limit) };
}

/**
 * `searchFoods` for every bounded discovery term, in parallel on the caller's one signal and each
 * under the search deadline. The raw phrase is sent exactly as typed, so brand and prep parsing
 * are unchanged; an alias that fails costs its rows only, while an abort or an account change
 * still ends the whole search.
 */
export async function searchFoodDiscovery(q: string, opts: SearchOptions = {}): Promise<SearchResult> {
  const query = q.trim();
  const aliases = foodDiscoveryTerms(query).slice(1);
  if (aliases.length === 0) return searchFoods(query, opts);
  const [primary, ...rest] = await Promise.allSettled(
    [query, ...aliases].map((term) => searchFoods(term, opts)));
  if (primary.status === "rejected") throw primary.reason;
  for (const r of rest) {
    if (r.status !== "rejected") continue;
    rethrowAccountChanged(r.reason);
    if (isAbort(r.reason)) throw r.reason;
  }
  return mergeDiscovery(primary.value,
    rest.flatMap((r) => r.status === "fulfilled" ? [r.value] : []), opts.limit ?? 25);
}

function tileFor(source: CatalogSource): "USDA" | "OFF" {
  return source === "off" ? "OFF" : "USDA";
}

/** One row shape for both tiers, so CatalogSearch renders a single list. Order is never changed. */
export function toRows(result: SearchResult): CatalogRow[] {
  if (result.kind === "empty") return [];
  if (result.kind === "offline") {
    return result.hits.map((h) => ({
      key: `offline:${h.source}:${h.id}`,
      catalogFoodId: null, revisionId: null, description: h.name, brand: null,
      sourceTile: h.source === "mine" ? "MINE" : "USDA",
      qualityFlags: h.flags, prefStatus: null, score: h.score,
      offPlan: h.flags,
      offline: true, offlineFoodId: h.id, offlineSource: h.source,
      kcalPer100g: h.kcalPer100g, per100g: h.per100g, portions: h.portions, defaultPortion: h.defaultPortion,
    }));
  }
  return result.hits.map((h) => ({
    key: `catalog:${h.revisionId}`,
    catalogFoodId: h.catalogFoodId, revisionId: h.revisionId, description: h.description,
    brand: h.brand, sourceTile: tileFor(h.source), qualityFlags: h.qualityFlags,
    prefStatus: h.prefStatus, score: h.score, offline: false,
    offPlan: offPlanForHit(h),
    kcalPer100g: h.kcalPer100g, per100g: h.per100g, portions: h.portions, defaultPortion: h.defaultPortion,
  }));
}

export type SearchController = {
  search(q: string, opts?: SearchOptions): Promise<SearchResult | null>;
  cancel(): void;
};

/**
 * One controller per open sheet. Each keystroke supersedes the one before it: the pending timer is
 * cleared, the in-flight request is aborted, and the superseded promise resolves `null` so the
 * caller can `if (r === null) return;` instead of racing setState calls.
 */
export function createSearchController(opts: { debounceMs?: number } = {}): SearchController {
  const wait = opts.debounceMs ?? SEARCH_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: AbortController | null = null;
  let generation = 0;
  /**
   * The still-unsettled promise's `resolve`, so `stop()` can settle it to `null` when it is
   * superseded. Without this, clearing the debounce timer for a pending keystroke also cancels the
   * callback that would have resolved its promise, and it hangs forever.
   */
  let pending: ((r: SearchResult | null) => void) | null = null;

  function stop(): void {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    inFlight?.abort();
    inFlight = null;
    if (pending) { const resolve = pending; pending = null; resolve(null); }
  }

  return {
    cancel(): void { generation += 1; stop(); },
    search(q, searchOpts = {}): Promise<SearchResult | null> {
      generation += 1;
      const mine = generation;
      stop();
      return new Promise<SearchResult | null>((resolve, reject) => {
        pending = resolve;
        timer = setTimeout(() => {
          timer = null;
          if (mine !== generation) { resolve(null); return; }
          const ac = new AbortController();
          inFlight = ac;
          (searchOpts.discover ? searchFoodDiscovery : searchFoods)(q, { ...searchOpts, signal: ac.signal }).then(
            (r) => {
              if (pending === resolve) pending = null;
              resolve(mine === generation ? r : null);
            },
            (e) => {
              if (pending === resolve) pending = null;
              if (mine !== generation) { resolve(null); return; }
              if (e instanceof DOMException && e.name === "AbortError") { resolve(null); return; }
              reject(e);
            }
          );
        }, wait);
      });
    },
  };
}

export type DetailResult =
  | { kind: "ok"; detail: FoodDetail }
  | { kind: "cached"; revision: CachedRevision }
  | { kind: "blocked" }
  | { kind: "not_found" };

/** The wire detail, flattened to what an offline snapshot needs. `null` stays `null`; `0` stays `0`. */
export function toCachedRevision(detail: FoodDetail, now: number = Date.now()): CachedRevision {
  const per100g: Record<string, number | null> = {};
  for (const [code, value] of Object.entries(detail.per100g)) per100g[code] = value.amount;
  return {
    revision_id: detail.revisionId,
    catalog_food_id: detail.catalogFoodId,
    description: detail.description,
    brand: detail.brand,
    source: detail.source,
    version_label: detail.catalogVersion,
    per_100g: per100g,
    portions: detail.portions.map((p) => ({
      id: p.id, description: p.description, gramWeight: p.gramWeight, isDefault: p.isDefault,
    })),
    // UI lane contract (lib/foods/portions.ts) — carried into the offline cache under distinct
    // names so an offline repeat read still shows serving data, without reshaping the legacy
    // `portions`/`per_100g` fields above (components/LogFoodSheet.tsx and others read those by
    // their existing name and shape).
    kcalPer100g: detail.kcalPer100g,
    per100g: detail.simplePer100g,
    servingPortions: detail.servingPortions,
    defaultPortion: detail.defaultPortion,
    cached_at: new Date(now).toISOString(),
  };
}

export async function cacheDetail(
  detail: FoodDetail, now?: number, h: AccountHandle = accountHandle(),
): Promise<CachedRevision> {
  const row = toCachedRevision(detail, now);
  await putRevision(row, h);
  return row;
}

/**
 * phase-2-real-logging.md, Offline: "A cache miss with no network blocks that food and says so,
 * never a zeroed item." That is the `blocked` arm — the sheet refuses the food rather than logging
 * an entry whose every nutrient would read 0.
 */
export async function getFoodDetail(
  catalogFoodId: number,
  opts: {
    revisionId?: number; signal?: AbortSignal; fetchImpl?: typeof fetch; account?: AccountHandle;
  } = {}
): Promise<DetailResult> {
  const h = opts.account ?? accountHandle();
  try {
    const res = await accountFetch(h, `/api/foods/${catalogFoodId}`, {
      signal: opts.signal, headers: { accept: "application/json" },
    }, { budget: "search", fetchImpl: opts.fetchImpl });
    if (res.status === 404) return { kind: "not_found" };
    if (res.ok) {
      const detail = await accountJson<FoodDetail>(h, res);
      await cacheDetail(detail, undefined, h);
      return { kind: "ok", detail };
    }
  } catch (e) {
    rethrowAccountChanged(e);
    if (e instanceof DOMException && e.name === "AbortError") throw e;
  }
  const cached = opts.revisionId === undefined ? undefined : await getRevision(opts.revisionId, h);
  return cached ? { kind: "cached", revision: cached } : { kind: "blocked" };
}
