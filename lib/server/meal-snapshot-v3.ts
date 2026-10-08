/**
 * `GET /api/foods/eligible?v=3` (Phase 18 D11, slice W8): an open food-world account's admitted
 * set, ranking data and freshness token in one body (contract: lib/meals/snapshot-v3.ts).
 *
 * A CLOSED account gets the v2 body byte for byte (`mealSnapshot`): the phone's closed path is
 * main's. A world that cannot be read (a DB error on that one check) answers `503`, never a silent
 * closed guess (Sol r3 BLOCK): that path carries no v3 token check, so guessing closed could let an
 * open account generate from a response D11's freshness guarantee never covered.
 *
 * For an open account, in one token window:
 *   1. read the admission token (t0);
 *   2. the v2 parts (Eats rows, occasion history, facets) and the D4 admission
 *      (lib/server/candidate-foods.ts) over the same eligible read;
 *   3. the account's settings (cuisines, country, sex, birth year, diet flags, taste dislikes) and its
 *      admitted taste evidence (lib/server/taste-history.ts + taste-admission.ts, lib/meals/taste.ts);
 *   4. read the token again: t0, the admission's own token and this one must be equal, else nothing
 *      is answered under the old revision (`409 rules_changed`).
 * Then `pref-2` (lib/meals/preference.ts) over the admitted pool, quantized once here; the phone
 * never recomputes it. A failed rule, Avoid or evidence read admits nothing (`503`); a failed
 * TASTE read only drops personal evidence (no food is added or removed by it), and is logged.
 *
 * No cohort key, sex, age band, country, race or ethnicity field enters the body: the prior is
 * applied here and only the quantized `z` leaves.
 */
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadAccountPrior, loadSubstituteGraph } from "@/lib/foods/universe/artifacts";
import { deriveItem, type UniverseItem } from "@/lib/foods/universe/derive";
import { UNIVERSE, UNIVERSE_HASH, UNIVERSE_VERSION } from "@/lib/foods/universe/manifest";
import type { AccountPrior } from "@/lib/foods/universe/prior";
import type { SubstituteGraph } from "@/lib/foods/universe/substitutes";
import { sameRulesToken, type RulesToken } from "@/lib/foods/world/freshness";
import { snapshotFoodsV3 } from "@/lib/foods/world/snapshot-foods";
import type { IdentityRefs } from "@/lib/foods/world/taste-inputs";
import type { Occasion } from "@/lib/meals/occasion";
import type { Part } from "@/lib/meals/parts";
import { PREFERENCE_VERSION } from "@/lib/meals/preference";
import { RANKING_VERSION } from "@/lib/meals/snapshot";
import {
  SNAPSHOT_V3, SNAPSHOT_V3_MAX_BYTES, type MealSnapshotV3, type PlateRuleKey,
} from "@/lib/meals/snapshot-v3";
import { tasteProfile, type TasteResult } from "@/lib/meals/taste";
import { cuisinesFrom } from "@/lib/profile/cuisines";
import { normalizePreferenceFlags } from "@/lib/profile/onboarding-state";
import { tasteFrom, type TasteDislike } from "@/lib/profile/taste";
import { HttpError } from "@/lib/server/auth";
import { recipeAccessEnabled } from "@/lib/server/recipe-access";
import { shoppingFocusActive } from "@/lib/shopping/focus";
import { candidateFoods, type CandidateFoods } from "@/lib/server/candidate-foods";
import { mealSnapshot, mealSnapshotParts, type MealSnapshotDeps, type SnapshotResponse } from "@/lib/server/meal-snapshot";
import { readRulesToken } from "@/lib/server/rules-clock";
import { admitHistory, DEFAULT_TASTE_PORTS } from "@/lib/server/taste-admission";
import { readTasteHistory } from "@/lib/server/taste-history";

export type MealSnapshotV3Response = MealSnapshotV3;

/**
 * The 250 KB wire ceiling (D11, acceptance 5): checked, logged, NEVER enforced by deleting a
 * `foods` entry (Sol re-plan, 2026-10-06, after 2 failed review rounds on an entry-dropping
 * design). Dropping any entry — even a universe one — can change what a plate search sees: an
 * omitted entry loses its `z`, reasons, history, facets and, under a meal-level rule, its plate
 * evidence, so `openWorldInputs` (lib/meals/open-world.ts) ranks or rules on that food differently
 * than the full admission would, and a kosher food with no plate evidence reads "unknown" and its
 * plates stop generating — a correctness change, not just a missing admission (Sol r1 BLOCK was
 * about admission; this is broader). Dropping a `favored` entry can also break admission outright
 * (Sol r2 BLOCK: it can be the only proof `admittedOwn`'s no-cached-ref fallback has).
 *
 * The body is always sent complete. When it would exceed the cap anyway, this logs the total and
 * each section's share so the overage can be diagnosed, and the orchestrator has accepted this as
 * a stated exception in the spec (§W8 acceptance 5): the cap is a hard guarantee for any realistic
 * account (the bounded ~124-item universe pool plus a normal Favored list) and a best-effort target
 * — losing to correctness and to "Favored never limits meals" (spec §1) — otherwise. A true
 * guarantee for an unbounded admitted set needs paging with a token pinned across every page
 * (D11's one-token-window freshness design), which is a larger protocol change than this slice.
 *
 * Followups #6 (2026-10-08, Sol: "keep complete admitted snapshots and measure overages"): still
 * no trimming, measurement unchanged; this now also bumps a process-lifetime overage counter
 * (`snapshotV3Overages`) so an overage is a countable signal, not only a line to grep for, while a
 * durable cross-invocation count (if this ever needs one) would be a server table, not this.
 */
let overageCount = 0;

export function checkByteBudget(body: MealSnapshotV3, maxBytes: number = SNAPSHOT_V3_MAX_BYTES): MealSnapshotV3 {
  const bytes = Buffer.byteLength(JSON.stringify(body), "utf8");
  if (bytes <= maxBytes) return body;
  overageCount += 1;
  console.error("meal snapshot v3: over the 250 KB target (stated exception, D11/acceptance 5); "
    + "the body is sent complete rather than risk ranking or admission correctness", {
    metric: "snapshot_v3_overage", count: overageCount,
    accountId: body.accountId, bytes, maxBytes,
    foods: Buffer.byteLength(JSON.stringify(body.foods), "utf8"),
    admittedRefIds: body.admittedRefIds.length, admittedUniverseIds: body.admittedUniverseIds.length,
    excluded: Buffer.byteLength(JSON.stringify(body.excluded), "utf8"),
    eligible: Buffer.byteLength(JSON.stringify(body.eligible), "utf8"),
  });
  return body;
}

/** The process-lifetime count of v3 snapshot overages (`checkByteBudget`). Each serverless
 *  invocation starts at 0 — a sampling signal alongside the structured log line, not a durable
 *  metric across invocations. */
export function snapshotV3Overages(): number {
  return overageCount;
}

/** Test-only: resets the process-lifetime overage counter. */
export function resetSnapshotV3Overages(): void {
  overageCount = 0;
}

/** The account's admitted taste evidence, as the preference inputs read it. */
export type TasteEvidence = {
  profile: Pick<TasteResult, "m" | "identities">;
  identities: IdentityRefs;
};

export type MealSnapshotV3Deps = MealSnapshotDeps & {
  taste?: (client: SupabaseClient, userId: string, today: string, now: Date) => Promise<TasteEvidence>;
  prior?: (account: { countryCode: string | null; sex: "female" | "male" | null; birthYear: number | null },
    today: string) => AccountPrior;
  graph?: () => SubstituteGraph | null;
};

const EMPTY_TASTE: TasteEvidence = { profile: { m: 0, identities: [] }, identities: new Map() };

/** The admitted eaten history (W3), with the same rules and Avoid admission as `GET /api/foods/taste`. */
export async function accountTasteEvidence(client: SupabaseClient, userId: string, today: string,
  now: Date): Promise<TasteEvidence> {
  const history = await readTasteHistory(client, userId, today, DEFAULT_TASTE_PORTS.mixedDishInputs);
  const admitted = await admitHistory(client, userId, history, now, DEFAULT_TASTE_PORTS);
  return { profile: tasteProfile({ today, items: admitted.items, choices: admitted.choices, admitted: admitted.admitted }),
    identities: history.reps };
}

let universeParts: Record<string, readonly Part[]> | null = null;
/** Parts of every universe item: the prior's centring group, independent of any account's rules. */
function allUniverseParts(): Record<string, readonly Part[]> {
  universeParts ??= Object.fromEntries(UNIVERSE.map((entry) => deriveItem(entry))
    .filter((item): item is UniverseItem => item !== null).map((item) => [item.entry.id, item.parts]));
  return universeParts;
}

let graphCache: { graph: SubstituteGraph | null } | null = null;
const defaultGraph = () => (graphCache ??= { graph: loadSubstituteGraph() }).graph;

type SettingsRow = { cuisines?: unknown; country_code?: unknown; sex?: unknown; birth_year?: unknown;
  diet_prefs?: { flags?: unknown; taste?: unknown } | null; shopping_focus_until?: unknown };

async function readOpenSettings(client: SupabaseClient, userId: string) {
  const { data, error } = await client.from("user_settings")
    .select("cuisines,country_code,sex,birth_year,diet_prefs,shopping_focus_until").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  const row = (data ?? {}) as SettingsRow;
  const flags = row.diet_prefs?.flags;
  return {
    cuisines: cuisinesFrom(row.cuisines),
    countryCode: typeof row.country_code === "string" ? row.country_code : null,
    sex: (row.sex === "female" || row.sex === "male" ? row.sex : null) as "female" | "male" | null,
    birthYear: typeof row.birth_year === "number" && Number.isInteger(row.birth_year) ? row.birth_year : null,
    flags: normalizePreferenceFlags(Array.isArray(flags) ? flags.filter((f): f is string => typeof f === "string") : []),
    dislikes: (tasteFrom(row.diet_prefs?.taste)?.dislikes ?? []) as TasteDislike[],
    focusUntil: typeof row.shopping_focus_until === "string" ? row.shopping_focus_until : null,
  };
}

async function readWorld(client: SupabaseClient, userId: string): Promise<"open" | "closed"> {
  const { data, error } = await client.from("user_settings").select("food_world").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return (data as { food_world?: unknown } | null)?.food_world === "open" ? "open" : "closed";
}

function unavailable(cause: unknown): never {
  if (cause instanceof HttpError) throw cause;
  throw new HttpError(503, "admission_unavailable", "Your food rules could not be checked right now.", { cause });
}

/**
 * The v3 body for an open account, or the v2 body for a closed one (see the module comment).
 */
export async function mealSnapshotV3(client: SupabaseClient, userId: string, now: Date = new Date(),
  deps: MealSnapshotV3Deps = {}): Promise<MealSnapshotV3Response | SnapshotResponse> {
  // A failed world read must fail the request, never fall back to the v2/closed path: that path
  // carries no v3 token check (lib/foods/eligible-client.ts `readEligibleOnce`), so an open account
  // could otherwise generate from a response W8's freshness guarantee never covered (Sol r3 BLOCK).
  const world = await readWorld(client, userId).catch(unavailable);
  if (world !== "open") return mealSnapshot(client, userId, now, deps);

  const t0 = await readRulesToken(client, userId).catch(unavailable);
  let parts: Awaited<ReturnType<typeof mealSnapshotParts>>;
  let candidate: CandidateFoods;
  let settings: Awaited<ReturnType<typeof readOpenSettings>>;
  try {
    parts = await mealSnapshotParts(client, userId, now, deps);
    candidate = await candidateFoods(client, userId, { eligible: async () => parts.eligible, now: () => now });
    settings = await readOpenSettings(client, userId);
  } catch (error) {
    unavailable(error);
  }
  // The world closed while this ran: the closed answer, read afresh.
  if (candidate.world !== "open") return mealSnapshot(client, userId, now, deps);
  const taste = await (deps.taste ?? accountTasteEvidence)(client, userId, parts.today, now)
    .catch((error: unknown) => {
      if (error instanceof HttpError && error.status === 409) throw error;
      console.error("meal snapshot v3: taste unavailable", { error: error instanceof Error ? error.message : "unknown" });
      return EMPTY_TASTE;
    });
  const t1 = await readRulesToken(client, userId).catch(unavailable);
  if (!sameRulesToken(t0, candidate.token) || !sameRulesToken(t0, t1)) {
    throw new HttpError(409, "rules_changed", "Your food rules just changed. Try again.");
  }
  const token: RulesToken = t1;

  const prior = (deps.prior ?? ((account, today) => loadAccountPrior(account, today)))(
    { countryCode: settings.countryCode, sex: settings.sex, birthYear: settings.birthYear }, parts.today);
  const graph = (deps.graph ?? defaultGraph)();
  const plateRules: PlateRuleKey[] = settings.flags.includes("kosher") ? ["kosher_meat_dairy"] : [];
  const scoresOf = (occasion: Record<string, { score: number; source: string }>, source: string) =>
    Object.fromEntries(Object.entries(occasion).filter(([, score]) => score.source === source)
      .map(([name, score]) => [name, score.score])) as Partial<Record<Occasion, number>>;
  const foods = snapshotFoodsV3({
    own: parts.rows.map((row) => ({ id: row.id, food: row.food, parts: parts.foods[row.id].parts,
      family: parts.foods[row.id].family, userRefId: row.refs.userRefId, catalogRefId: row.refs.catalogRefId,
      history: scoresOf(parts.foods[row.id].occasion, "history"), facets: scoresOf(parts.foods[row.id].occasion, "facets") })),
    admittedRefIds: candidate.admittedRefIds, admittedUniverseIds: candidate.admittedUniverseIds,
    context: { profile: taste.profile, identities: taste.identities, dislikes: settings.dislikes,
      cuisines: settings.cuisines, prior, universeParts: allUniverseParts(), graph },
    plateRules,
  });
  // Which table applied, never which cohort: the cohort stays on the server (D11).
  const priorVersion = prior.prior.status === "loaded" ? "population" : "neutral";
  const graphVersion = graph?.version ?? "none";
  const inputsHash = createHash("sha256").update(JSON.stringify({
    ranking: RANKING_VERSION, pref: PREFERENCE_VERSION, universe: [UNIVERSE_VERSION, UNIVERSE_HASH],
    // The cohort itself never leaves the server, but a cohort change moves the hash.
    prior: [priorVersion, prior.cohort], graph: graphVersion, token, plateRules,
    admittedUniverseIds: candidate.admittedUniverseIds, admittedRefIds: candidate.admittedRefIds,
    excluded: candidate.excluded.map((row) => `${row.id}:${row.verdict}:${row.reason}`).sort(),
    eats: [...parts.eligible.eligibleRefIds].sort(), facets: parts.facets.hashPart, history: parts.history.watermark,
    taste: [taste.profile.m, taste.profile.identities.map((row) => [row.key, row.h, row.q])],
    settings: [settings.cuisines, settings.dislikes, settings.flags],
    today: parts.today, foods: Object.keys(foods).sort().map((id) => [id, foods[id]]),
    schedule: { ...parts.schedule, slotTimes: Object.keys(parts.schedule.slotTimes).sort()
      .map((slot) => [slot, parts.schedule.slotTimes[slot]]) },
  })).digest("hex").slice(0, 32);
  return checkByteBudget({
    schemaVersion: SNAPSHOT_V3, rankingVersion: RANKING_VERSION, universeVersion: UNIVERSE_VERSION,
    universeHash: UNIVERSE_HASH, prefVersion: PREFERENCE_VERSION, priorVersion, graphVersion,
    accountId: userId, rulesVersion: token.rulesVersion, evidenceVersion: token.evidenceVersion,
    computedAt: now.toISOString(), inputsHash, world: "open",
    // W11 (D7): the active focus end, for an account with Shopping access; the phone ranks by the
    // dated keys GET /api/shopping/focus answers (lib/shopping/focus-client.ts).
    focusUntil: recipeAccessEnabled(userId) && shoppingFocusActive(settings.focusUntil, now)
      ? settings.focusUntil : null,
    plateRules,
    admittedUniverseIds: [...candidate.admittedUniverseIds], admittedRefIds: [...candidate.admittedRefIds],
    foods, excluded: candidate.excluded.map((row) => ({ id: row.id, verdict: row.verdict, reason: row.reason })),
    eligible: parts.eligible,
  });
}
