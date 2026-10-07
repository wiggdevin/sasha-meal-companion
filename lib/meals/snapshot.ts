/**
 * The meal snapshot contract, v2 (Phase 17 O2, D2): what `GET /api/foods/eligible?v=2` returns and
 * what the phone keeps, plus the projection both sides use to turn it into ranking evidence.
 *
 *   { schemaVersion: 2, rankingVersion, accountId, computedAt, inputsHash,
 *     foods: { [foodId]: { userRefId, catalogRefId, parts, occasion: { [o]: { score, source } },
 *                          family } } }
 *
 * `foodId` is the account's own food row (`user_foods.id`), or `catalog:<id>` for an Eats catalog
 * ref with no own row. The phone re-keys it to its local foods through their refs
 * (`mealEvidence`), so a local id the server never saw still finds its entry. `occasion` holds the
 * evidence ladder's answer per occasion: the account's history where it qualifies, else the curated
 * prior, else a calibrated Jev facet (O3, gate-controlled), else neutral. Only `source: "history"`
 * and `source: "facets"` rows add anything on
 * the phone: the curated prior is recomputed there from the same table, so an older snapshot can
 * never pin an older curated table.
 *
 * Offline: a new suggestion needs a snapshot for the current account no older than 7 days
 * (`snapshotUsable`); otherwise the slot says "Suggestions need a connection".
 *
 * Pure. No I/O.
 */

import type { Food } from "@/lib/foods";
import { OCCASIONS, type Occasion } from "@/lib/meals/occasion";
import { foodKey, type Part } from "@/lib/meals/parts";

export const SNAPSHOT_SCHEMA_VERSION = 2;
/** Bumped whenever the ranking contract (lib/meals) changes what a snapshot means. */
export const RANKING_VERSION = "o2.1";
export const SNAPSHOT_MAX_AGE_MS = 7 * 86_400_000;
export const SUGGESTIONS_NEED_CONNECTION = "Suggestions need a connection";

/**
 * "facets" (O3): a calibrated Jev v2 judgment the server placed where curated is neutral. The server
 * emits it only while the calibration gate is open (lib/foods/occasion-gate.ts); an O2-era phone,
 * whose parser does not know it, treats such a snapshot as malformed and asks for a connection, so
 * the gate opens only after O3 clients are out.
 */
export type OccasionSource = "history" | "curated" | "facets" | "neutral";
export type OccasionScore = { score: number; source: OccasionSource };

export type SnapshotFood = {
  userRefId: string | null;
  catalogRefId: string | null;
  parts: Part[];
  occasion: Record<Occasion, OccasionScore>;
  family: string | null;
};

export type MealSnapshotV2 = {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  rankingVersion: string;
  accountId: string;
  computedAt: string;
  inputsHash: string;
  foods: Record<string, SnapshotFood>;
};

/** What the ranking reads: history (and, O3, facet) scores by food name key, for one account. */
export type MealEvidence = {
  accountId: string;
  computedAt: string;
  history: Readonly<Record<string, Partial<Record<Occasion, number>>>>;
  /** Calibrated facet scores (O3), placed below curated by `affinity`. Absent or empty: none. */
  facets?: Readonly<Record<string, Partial<Record<Occasion, number>>>>;
};

const PARTS: readonly Part[] = ["anchor", "protein", "starch", "veg", "fruit", "fat"];
const SOURCES: readonly OccasionSource[] = ["history", "curated", "facets", "neutral"];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const optionalId = (value: unknown) => value === null || (typeof value === "string" && value.length > 0);

function parseFood(value: unknown): SnapshotFood | null {
  if (!isObject(value) || !optionalId(value.userRefId) || !optionalId(value.catalogRefId)) return null;
  if (!Array.isArray(value.parts) || !value.parts.every((part) => PARTS.includes(part as Part))) return null;
  if (!(value.family === null || typeof value.family === "string") || !isObject(value.occasion)) return null;
  const occasion = {} as Record<Occasion, OccasionScore>;
  for (const key of OCCASIONS) {
    const row = value.occasion[key];
    if (!isObject(row) || typeof row.score !== "number" || !Number.isFinite(row.score)
      || row.score < 0 || row.score > 1 || !SOURCES.includes(row.source as OccasionSource)) return null;
    occasion[key] = { score: row.score, source: row.source as OccasionSource };
  }
  return { userRefId: value.userRefId as string | null, catalogRefId: value.catalogRefId as string | null,
    parts: [...value.parts] as Part[], occasion, family: value.family as string | null };
}

/** The boundary check for a v2 body: anything malformed is no snapshot at all. */
export function parseMealSnapshot(body: unknown): MealSnapshotV2 | null {
  if (!isObject(body) || body.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) return null;
  if (typeof body.rankingVersion !== "string" || typeof body.accountId !== "string" || !body.accountId
    || typeof body.computedAt !== "string" || !Number.isFinite(Date.parse(body.computedAt))
    || typeof body.inputsHash !== "string" || !isObject(body.foods)) return null;
  const foods: Record<string, SnapshotFood> = {};
  for (const [id, value] of Object.entries(body.foods)) {
    const food = parseFood(value);
    if (!food) return null;
    foods[id] = food;
  }
  return { schemaVersion: SNAPSHOT_SCHEMA_VERSION, rankingVersion: body.rankingVersion,
    accountId: body.accountId, computedAt: body.computedAt, inputsHash: body.inputsHash, foods };
}

/**
 * Whether a snapshot may seed a new suggestion: this account's, this ranking contract's, computed
 * no more than 7 days ago (and not in the future beyond a little clock skew).
 */
export function snapshotUsable(snapshot: MealSnapshotV2 | null | undefined, accountId: string,
  now: number = Date.now()): snapshot is MealSnapshotV2 {
  if (!snapshot || snapshot.accountId !== accountId || snapshot.rankingVersion !== RANKING_VERSION) return false;
  const at = Date.parse(snapshot.computedAt);
  return Number.isFinite(at) && now - at <= SNAPSHOT_MAX_AGE_MS && at - now <= 5 * 60_000;
}

/** A local food's refs, as the phone's ref cache holds them. */
export type LocalRefs = Readonly<Record<string, { userRefId?: string; catalogRefId?: string } | undefined>>;

function entryFor(food: Food, refs: LocalRefs, snapshot: MealSnapshotV2,
  byRef: Map<string, SnapshotFood>): SnapshotFood | undefined {
  const own = refs[food.id];
  return (own?.userRefId ? byRef.get(own.userRefId) : undefined)
    ?? (own?.catalogRefId ? byRef.get(own.catalogRefId) : undefined)
    ?? snapshot.foods[food.id]
    ?? (food.catalogFoodId !== undefined ? snapshot.foods[`catalog:${food.catalogFoodId}`] : undefined);
}

/**
 * The ranking evidence for this account's foods: each local Eats food's history scores, keyed by
 * its name key (the generator keeps one row per name). Identical inputs give identical evidence on
 * the phone and the server.
 */
export function mealEvidence(snapshot: MealSnapshotV2, foods: Readonly<Record<string, Food>> | readonly Food[],
  refs: LocalRefs = {}): MealEvidence {
  const byRef = new Map<string, SnapshotFood>();
  for (const id of Object.keys(snapshot.foods).sort()) {
    const entry = snapshot.foods[id];
    if (entry.userRefId && !byRef.has(entry.userRefId)) byRef.set(entry.userRefId, entry);
    if (entry.catalogRefId && !byRef.has(entry.catalogRefId)) byRef.set(entry.catalogRefId, entry);
  }
  const list = (Array.isArray(foods) ? [...foods] : Object.values(foods)) as Food[];
  const history: Record<string, Partial<Record<Occasion, number>>> = {};
  const facets: Record<string, Partial<Record<Occasion, number>>> = {};
  for (const food of [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (food.status !== "eats") continue;
    const entry = entryFor(food, refs, snapshot, byRef);
    if (!entry) continue;
    for (const occasion of OCCASIONS) {
      const row = entry.occasion[occasion];
      if (row.source !== "history" && row.source !== "facets") continue;
      const key = foodKey(food);
      const own = ((row.source === "history" ? history : facets)[key] ??= {});
      own[occasion] = Math.max(own[occasion] ?? 0, row.score);
    }
  }
  // Facets only when present, so a gate-shut snapshot gives exactly the O2 evidence (and key).
  return { accountId: snapshot.accountId, computedAt: snapshot.computedAt, history,
    ...(Object.keys(facets).length ? { facets } : {}) };
}

/** A stable key for memoizing a plan on its evidence. */
export function evidenceKey(evidence: MealEvidence | null | undefined): string {
  if (evidence === undefined) return "curated";
  if (evidence === null) return "none";
  const facets = evidence.facets ?? {};
  return JSON.stringify([evidence.accountId, evidence.computedAt,
    Object.keys(evidence.history).sort().map((key) => [key, evidence.history[key]]),
    ...(Object.keys(facets).length ? [Object.keys(facets).sort().map((key) => [key, facets[key]])] : [])]);
}
