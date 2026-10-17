/**
 * The meal snapshot contract, v3 (Phase 18 D11, slice W8): what `GET /api/foods/eligible?v=3`
 * returns for an OPEN food-world account, and the parse both sides trust.
 *
 *   { schemaVersion: 3, rankingVersion, universeVersion, universeHash, prefVersion, priorVersion,
 *     graphVersion, accountId, rulesVersion, evidenceVersion, computedAt, inputsHash, world: "open",
 *     focusUntil, plateRules, admittedUniverseIds, admittedRefIds,
 *     foods: { [foodId]: { userRefId, catalogRefId, universeId, source,
 *                          history?, facets?, z, reasons, plate? } },
 *     excluded: { id, verdict, reason }[], eligible }
 *
 * `parts` and `family` are never on the wire (Sol re-plan, 2026-10-06): `openWorldInputs`
 * (lib/meals/open-world.ts) never reads them off a snapshot entry — a pool food's own parts and
 * name family come from the phone's local `Food` row (own foods) or `universeFood` (universe
 * items), not from this body. Carrying them again here only cost bytes for no reader.
 *
 * A CLOSED account asks the same URL and gets the v2 body byte for byte (lib/meals/snapshot.ts):
 * the phone's closed path is main's. v1 and v2 are unchanged.
 *
 * - The admitted set is explicit and positive. `admittedUniverseIds` and `admittedRefIds` list every
 *   food the server admitted (D4, lib/server/candidate-foods.ts). On the phone a food whose universe
 *   id or ref is not listed is UNAVAILABLE, even when its data is in the bundle or the local store.
 *   Omission always means unavailable. `foods` carries ranking data for admitted foods only.
 * - `foodId` is the account's own food row (`user_foods.id`), `catalog:<id>` for an Eats catalog ref
 *   with no own row (as in v2), or `universe:<bundled id>` for a universe item. A universe item's
 *   nutrition comes from the bundled list, never from the snapshot.
 * - `z` is the food's quantized `pref-2` value (lib/meals/preference.ts `TasteEntry`: `base`, plus
 *   the occasions that differ). Every number is a multiple of 0.01 inside ±0.8: the server
 *   quantizes once and the phone never recomputes it, so phone and server rank with the same
 *   numbers. A value off the grid makes the whole body malformed.
 * - `history` / `facets` carry only the occasion evidence the phone cannot recompute (the curated
 *   prior is recomputed on the phone from its own table, as in v2).
 * - `plate` is present only under a meal-level rule (`plateRules`, today kosher meat with dairy,
 *   lib/policy/plate-rules.ts): the food's deterministic meat and dairy evidence. A food without it
 *   reads unknown, and a plate that cannot be proved apart is not generated.
 * - No cohort key, sex, age band, race or ethnicity field, or proxy for one, is ever part of this
 *   body (D11; tests/meals/snapshot-v3.test.ts checks the shape).
 *
 * Freshness: the body is stamped with the admission token `{ rulesVersion, evidenceVersion }`.
 * Before any new suggestion the phone reads the server's current token and uses a body only while
 * the token is the same (lib/foods/world/rules-version-client.ts `freshAdmission`); O2's 7-day limit
 * and the local rules epoch still apply on top.
 *
 * Pure. No I/O.
 */

import { OCCASIONS, type Occasion } from "@/lib/meals/occasion";
import {
  PREFERENCE_VERSION, PREFERENCE_WEIGHTS, type PreferenceReasonCode, type TasteEntry,
} from "@/lib/meals/preference";
import { RANKING_VERSION, SNAPSHOT_MAX_AGE_MS } from "@/lib/meals/snapshot";
import { UNIVERSE_HASH, UNIVERSE_VERSION } from "@/lib/foods/universe/manifest";
import type { RulesToken } from "@/lib/foods/world/freshness";

/**
 * The v1 eligible body carried beside the snapshot (lib/server/eligible-foods.ts `EligibleFoods`),
 * checked structurally here so this phone module never imports server code (its import graph
 * would reach the model transport, tests/server/ratelimit-call-sites.test.ts).
 */
export type EligibleWire = {
  eligibleRefIds: string[]; eligibleFoodIds: string[]; eligibleCatalogFoodIds: number[];
  rulesRevision?: number; preferenceFlags?: string[];
  excluded?: { refId: string; verdict: "blocked" | "unknown"; reason: string; name?: string; mark?: unknown }[];
};

export const SNAPSHOT_V3 = 3;

/** Where a snapshot food came from: the account's Favored (Eats) refs, or the universe. */
export type SnapshotFoodSource = "favored" | "universe";

export type FacetOutcome = "present" | "absent" | "unknown";
export type PlateEvidence = { meat: FacetOutcome; dairy: FacetOutcome };

/** The meal-level rules a v3 body may name (lib/policy/plate-rules.ts). */
export const PLATE_RULES = ["kosher_meat_dairy"] as const;
export type PlateRuleKey = (typeof PLATE_RULES)[number];

export type SnapshotFoodV3 = {
  userRefId: string | null;
  catalogRefId: string | null;
  universeId: string | null;
  source: SnapshotFoodSource;
  /** The account's own history score per occasion (O2), where it qualifies. */
  history?: Partial<Record<Occasion, number>>;
  /** A calibrated Jev v2 facet score per occasion (O3), only while its gate is open. */
  facets?: Partial<Record<Occasion, number>>;
  /** The quantized pref-2 value. */
  z: TasteEntry;
  /** Why it ranks where it does, strongest first (lib/meals/preference.ts reason codes). */
  reasons: PreferenceReasonCode[];
  plate?: PlateEvidence;
};

export type ExcludedCandidateWire = { id: string; verdict: "blocked" | "unverified"; reason: string };

export type MealSnapshotV3 = {
  schemaVersion: typeof SNAPSHOT_V3;
  rankingVersion: string;
  universeVersion: string;
  universeHash: string;
  prefVersion: string;
  priorVersion: string;
  graphVersion: string;
  accountId: string;
  rulesVersion: number;
  evidenceVersion: number;
  computedAt: string;
  inputsHash: string;
  world: "open";
  /** Shopping focus (W11); null until then. */
  focusUntil: string | null;
  plateRules: PlateRuleKey[];
  admittedUniverseIds: string[];
  admittedRefIds: string[];
  foods: Record<string, SnapshotFoodV3>;
  excluded: ExcludedCandidateWire[];
  /** The v1 eligible body, for the rule marks on saved lines (lib/foods/rule-marks.ts). */
  eligible: EligibleWire;
};

/** The largest body the server may send (D11): 250 KB of uncompressed JSON. */
export const SNAPSHOT_V3_MAX_BYTES = 250 * 1024;

/** The body's sections a size log names (W107). */
export const SNAPSHOT_V3_SECTIONS = ["foods", "admittedUniverseIds", "admittedRefIds", "excluded", "eligible"] as const;
export type SnapshotV3Section = (typeof SNAPSHOT_V3_SECTIONS)[number];

export type SnapshotV3Size = {
  /** The whole body as UTF-8 JSON bytes, the number the 250 KB ceiling reads. */
  bytes: number;
  /** Each section's own UTF-8 JSON bytes; the rest of the body is the header fields. */
  sections: Record<SnapshotV3Section, number>;
  /** Entry counts, never an id or a food name. */
  counts: { foods: number; favored: number; universe: number; excluded: number };
};

/**
 * The body's size by section (W107). Counts and byte lengths only, so a log line built from it
 * holds no food name, id or account data.
 */
export function snapshotV3Size(body: MealSnapshotV3): SnapshotV3Size {
  const bytesOf = (value: unknown) => utf8Bytes(JSON.stringify(value));
  const entries = Object.values(body.foods);
  return {
    bytes: bytesOf(body),
    sections: Object.fromEntries(SNAPSHOT_V3_SECTIONS.map((name) => [name, bytesOf(body[name])])) as
      Record<SnapshotV3Section, number>,
    counts: { foods: entries.length, favored: entries.filter((entry) => entry.source === "favored").length,
      universe: entries.filter((entry) => entry.source === "universe").length, excluded: body.excluded.length },
  };
}

/** UTF-8 byte length without `Buffer`, so the phone can read it too. */
function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

const REASONS: readonly PreferenceReasonCode[] = ["favored", "disliked", "eaten", "chosen", "not_this",
  "on_list", "in_pantry", "like_liked", "like_disliked", "cuisine", "popular", "less_common", "soft_rule"];
const OUTCOMES: readonly FacetOutcome[] = ["present", "absent", "unknown"];
const GRID = Math.round(1 / PREFERENCE_WEIGHTS.quantum);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const optionalId = (value: unknown) => value === null || (typeof value === "string" && value.length > 0);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const ids = (value: unknown): value is string[] => Array.isArray(value) && value.every(text)
  && new Set(value).size === value.length;
const counter = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** A z value exactly on the 0.01 grid inside ±0.8, as the server's `quantizeZ` produces it. */
export function onZGrid(value: unknown): value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > PREFERENCE_WEIGHTS.zCap) return false;
  const steps = value * GRID;
  return Math.abs(steps - Math.round(steps)) < 1e-9 && Math.round(steps) / GRID === value;
}

function scores(value: unknown): Partial<Record<Occasion, number>> | null | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) return null;
  const out: Partial<Record<Occasion, number>> = {};
  for (const [key, score] of Object.entries(value)) {
    if (!OCCASIONS.includes(key as Occasion) || typeof score !== "number" || !Number.isFinite(score)
      || score < 0 || score > 1) return null;
    out[key as Occasion] = score;
  }
  return out;
}

function parseZ(value: unknown): TasteEntry | null {
  if (!isObject(value) || !onZGrid(value.base)) return null;
  if (value.occasion === undefined) return { base: value.base };
  if (!isObject(value.occasion)) return null;
  const occasion: Partial<Record<Occasion, number>> = {};
  for (const [key, z] of Object.entries(value.occasion)) {
    if (!OCCASIONS.includes(key as Occasion) || !onZGrid(z)) return null;
    occasion[key as Occasion] = z;
  }
  return { base: value.base, occasion };
}

function parsePlate(value: unknown): PlateEvidence | null | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value) || !OUTCOMES.includes(value.meat as FacetOutcome)
    || !OUTCOMES.includes(value.dairy as FacetOutcome)) return null;
  return { meat: value.meat as FacetOutcome, dairy: value.dairy as FacetOutcome };
}

function parseFood(value: unknown): SnapshotFoodV3 | null {
  if (!isObject(value) || !optionalId(value.userRefId) || !optionalId(value.catalogRefId)
    || !optionalId(value.universeId)) return null;
  if (value.source !== "favored" && value.source !== "universe") return null;
  const history = scores(value.history);
  const facets = scores(value.facets);
  const z = parseZ(value.z);
  const plate = parsePlate(value.plate);
  if (history === null || facets === null || z === null || plate === null) return null;
  if (!Array.isArray(value.reasons) || !value.reasons.every((code) => REASONS.includes(code as PreferenceReasonCode))) {
    return null;
  }
  return {
    userRefId: value.userRefId as string | null, catalogRefId: value.catalogRefId as string | null,
    universeId: value.universeId as string | null, source: value.source,
    ...(history ? { history } : {}), ...(facets ? { facets } : {}),
    z, reasons: [...value.reasons] as PreferenceReasonCode[], ...(plate ? { plate } : {}),
  };
}

function validEligible(body: unknown): body is EligibleWire {
  return isObject(body) && Array.isArray(body.eligibleRefIds) && Array.isArray(body.eligibleFoodIds)
    && Array.isArray(body.eligibleCatalogFoodIds);
}

function parseExcluded(value: unknown): ExcludedCandidateWire[] | null {
  if (!Array.isArray(value)) return null;
  const out: ExcludedCandidateWire[] = [];
  for (const row of value) {
    if (!isObject(row) || !text(row.id) || (row.verdict !== "blocked" && row.verdict !== "unverified")
      || typeof row.reason !== "string") return null;
    out.push({ id: row.id, verdict: row.verdict, reason: row.reason });
  }
  return out;
}

/**
 * The boundary check for a v3 body: anything malformed is no snapshot at all. A food entry whose
 * ref or universe id the admitted sets do not list makes the body malformed too: the ranking data
 * may never describe a food the server did not admit.
 */
export function parseMealSnapshotV3(body: unknown): MealSnapshotV3 | null {
  if (!isObject(body) || body.schemaVersion !== SNAPSHOT_V3 || body.world !== "open") return null;
  for (const key of ["rankingVersion", "universeVersion", "universeHash", "prefVersion", "priorVersion",
    "graphVersion", "accountId", "computedAt", "inputsHash"] as const) {
    if (!text(body[key])) return null;
  }
  if (!Number.isFinite(Date.parse(body.computedAt as string))) return null;
  if (!counter(body.rulesVersion) || !counter(body.evidenceVersion)) return null;
  if (!(body.focusUntil === null || (text(body.focusUntil) && Number.isFinite(Date.parse(body.focusUntil))))) return null;
  if (!Array.isArray(body.plateRules) || !body.plateRules.every((rule) => PLATE_RULES.includes(rule as PlateRuleKey))) {
    return null;
  }
  if (!ids(body.admittedUniverseIds) || !ids(body.admittedRefIds) || !isObject(body.foods)) return null;
  if (!validEligible(body.eligible)) return null;
  const excluded = parseExcluded(body.excluded);
  if (!excluded) return null;
  const universe = new Set(body.admittedUniverseIds);
  const refs = new Set(body.admittedRefIds);
  const foods: Record<string, SnapshotFoodV3> = {};
  for (const [id, value] of Object.entries(body.foods)) {
    const food = parseFood(value);
    if (!food) return null;
    const admitted = food.source === "universe"
      ? food.universeId !== null && universe.has(food.universeId) && id === `universe:${food.universeId}`
      : [food.userRefId, food.catalogRefId].some((ref) => ref !== null && refs.has(ref))
        && [food.userRefId, food.catalogRefId].every((ref) => ref === null || refs.has(ref));
    if (!admitted) return null;
    foods[id] = food;
  }
  return {
    schemaVersion: SNAPSHOT_V3, rankingVersion: body.rankingVersion as string,
    universeVersion: body.universeVersion as string, universeHash: body.universeHash as string,
    prefVersion: body.prefVersion as string, priorVersion: body.priorVersion as string,
    graphVersion: body.graphVersion as string, accountId: body.accountId as string,
    rulesVersion: body.rulesVersion, evidenceVersion: body.evidenceVersion,
    computedAt: body.computedAt as string, inputsHash: body.inputsHash as string, world: "open",
    focusUntil: body.focusUntil as string | null, plateRules: [...body.plateRules] as PlateRuleKey[],
    admittedUniverseIds: [...body.admittedUniverseIds], admittedRefIds: [...body.admittedRefIds],
    foods, excluded, eligible: body.eligible,
  };
}

/** The token a v3 body was admitted under. */
export function snapshotToken(snapshot: Pick<MealSnapshotV3, "rulesVersion" | "evidenceVersion">): RulesToken {
  return { rulesVersion: snapshot.rulesVersion, evidenceVersion: snapshot.evidenceVersion };
}

/**
 * Whether a v3 body may seed a new suggestion at all: this account's, this ranking, preference AND
 * bundled-universe contract's (a held body naming ids from a universe build this phone no longer
 * carries, or whose nutrition moved under the same id, is never used — Sol r1 BLOCK), computed no
 * more than 7 days ago (and not in the future beyond clock skew). The token check against the
 * server's CURRENT token is separate (`freshAdmission`): this is the offline floor, never a
 * substitute for it.
 */
export function snapshotV3Usable(snapshot: MealSnapshotV3 | null | undefined, accountId: string,
  now: number = Date.now()): snapshot is MealSnapshotV3 {
  if (!snapshot || snapshot.accountId !== accountId || snapshot.rankingVersion !== RANKING_VERSION
    || snapshot.prefVersion !== PREFERENCE_VERSION || snapshot.universeVersion !== UNIVERSE_VERSION
    || snapshot.universeHash !== UNIVERSE_HASH) return false;
  const at = Date.parse(snapshot.computedAt);
  return Number.isFinite(at) && now - at <= SNAPSHOT_MAX_AGE_MS && at - now <= 5 * 60_000;
}
