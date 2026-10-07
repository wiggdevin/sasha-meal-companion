/**
 * Which eaten identities may count as personal evidence, and the `GET /api/foods/taste` answer
 * (Phase 18 D5, slice W3).
 *
 * History is always kept; personal evidence counts only for identities whose CURRENT verdict is
 * `allowed` (owner item 1). Decided by the existing deterministic policy, no Jev call (W2a/W2c):
 *
 * - Avoid: an Avoid mark on any member of a name family excludes the whole family (D4, the
 *   `set_food_membership` normalization), and an avoided ref excludes every row it stands for.
 * - Rules: each row is judged on EVERY ref it can stand for (an account food and the catalog food
 *   it was made from), with the same evidence and verdict as `eligibleFoods`
 *   (`loadSuggestionEvidence` + `suggestionItemsVerdict`); one that is not `allowed`, or cannot be
 *   read, holds the row out. A row with no ref of its own that names a universe item is judged by
 *   the W2b `universeVerdict`. A mixed dish's inputs count only while the dish itself does.
 * - Nothing to judge (a name-only family with no ref): not counted. Unknown never counts.
 * - A rule review pending: the same 409 as `GET /api/foods/eligible`.
 *
 * Removing the rule restores the evidence on the next read: nothing was deleted.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  loadSuggestionEvidence, suggestionItemsVerdict, type SuggestionEvidence, type SuggestionEvidencePort,
} from "@/lib/coach/suggest-policy";
import { dbFood } from "@/lib/food-db";
import { baseFoodName } from "@/lib/foods/base-name";
import { deriveItem } from "@/lib/foods/universe/derive";
import { avoidFamilies, universeVerdict } from "@/lib/foods/world/admission";
import { universeEntry } from "@/lib/foods/universe/manifest";
import { tasteProfile, TASTE_VERSION, TASTE_WINDOW_DAYS, type TasteProvenance } from "@/lib/meals/taste";
import { profileRuleFacets } from "@/lib/policy/profiles/account-rules";
import { HttpError } from "@/lib/server/auth";
import { readAvoidList, type AvoidList } from "@/lib/server/avoid-list";
import { getRuleReviewStatus } from "@/lib/server/constraints";
import { readPolicyProfile, type PolicyProfile } from "@/lib/server/policy-profile";
import { readMixedDishInputs } from "@/lib/server/mixed-dish-inputs";
import {
  readTasteHistory, type HistoryChoice, type HistoryItem, type IdentityReps,
  type MixedDishInputs, type TasteHistory,
} from "@/lib/server/taste-history";

export const TASTE_LIMIT = 50;
const REF_BATCH = 100;

export type TastePorts = {
  reviewRequired: (client: SupabaseClient, userId: string) => Promise<boolean>;
  policy: (client: SupabaseClient, userId: string, asOf: Date) => Promise<{ profile: PolicyProfile; rev: number }>;
  avoid: (client: SupabaseClient, userId: string) => Promise<AvoidList>;
  evidence: SuggestionEvidencePort;
  mixedDishInputs: MixedDishInputs;
};

export const DEFAULT_TASTE_PORTS: TastePorts = {
  reviewRequired: async (client, userId) => (await getRuleReviewStatus(client, userId)).required,
  policy: (client, userId, asOf) => readPolicyProfile(client, userId, asOf),
  avoid: readAvoidList,
  evidence: loadSuggestionEvidence,
  mixedDishInputs: readMixedDishInputs,
};

/** The evidence for every ref, read in batches; any unavailable batch makes the whole read so. */
async function refEvidence(ports: TastePorts, userId: string, refIds: string[],
  profile: PolicyProfile): Promise<SuggestionEvidence> {
  const options = { needsNoCook: false, facets: profileRuleFacets(profile.profileRules) };
  const merged: SuggestionEvidence = { status: "ready", preferenceFlags: [], byIdentity: {} };
  const batches = refIds.length ? Array.from({ length: Math.ceil(refIds.length / REF_BATCH) },
    (_, i) => refIds.slice(i * REF_BATCH, (i + 1) * REF_BATCH)) : [[]];
  for (const batch of batches) {
    const evidence = await ports.evidence(userId,
      batch.map((foodRefId) => ({ foodRefId, catalogFoodRevisionId: null })) as never, options);
    if (evidence.status !== "ready") return { status: "unavailable", preferenceFlags: [], byIdentity: {} };
    merged.preferenceFlags = evidence.preferenceFlags;
    Object.assign(merged.byIdentity, evidence.byIdentity);
  }
  return merged;
}

function familiesOf(key: string, reps: IdentityReps | undefined): string[] {
  const names = [...(reps?.names ?? [])];
  if (key.startsWith("f:")) names.push(key.slice(2));
  if (reps?.universeId) names.push(dbFood(reps.universeId)?.name ?? "");
  return names.map(baseFoodName).filter(Boolean);
}

export type AdmittedHistory = {
  items: HistoryItem[]; choices: HistoryChoice[]; admitted: Set<string>; rulesRevision: number;
};

/** The refs an identity is judged on with no resolved row of its own: its history refs, else its Favored refs. */
export const judgedRefs = (reps: IdentityReps | undefined): string[] =>
  [...((reps?.refIds.size ? reps.refIds : reps?.favoredRefIds) ?? [])];

/**
 * The refs a taste key stands for, as `POST /api/foods/favor` resolves it (lib/server/taste-favor.ts)
 * and as `favorable` reports it: the identity's `judgedRefs`, sorted and unique. Empty means the
 * Favor route answers 404 for that key.
 */
export const favorKeyRefs = (history: TasteHistory, key: string): string[] =>
  [...new Set(judgedRefs(history.reps.get(key)))].sort();

/**
 * The current verdicts admission reads, over `refIds` (Phase 18 W3; shared with the Favor write,
 * lib/server/taste-favor.ts, so both judge one food the same way). A pending rule review throws the
 * same 409 as `GET /api/foods/eligible`.
 */
export type TasteJudge = {
  /** The ref is `allowed` under the `eligibleFoods` evidence and verdict, and not on Avoid. */
  refAllowed: (foodRefId: string) => boolean;
  /** The ref itself is on Avoid. */
  refAvoided: (foodRefId: string) => boolean;
  /** A ref-free universe item passes the W2b `universeVerdict`. */
  universeOk: (id: string) => boolean;
  /** No family of this identity is avoided. */
  familyOk: (key: string) => boolean;
  /** Normalized family keys of every avoided ref's names. */
  avoidFamilies: ReadonlySet<string>;
  evidenceReady: boolean;
  rulesRevision: number;
};

export async function tasteJudge(
  client: SupabaseClient, userId: string, history: TasteHistory, refIds: string[], now: Date, ports: TastePorts,
): Promise<TasteJudge> {
  if (await ports.reviewRequired(client, userId)) {
    throw new HttpError(409, "rule_review_required",
      "Review your existing food rules in Settings before getting meal suggestions.");
  }
  const [{ profile, rev }, avoid] = await Promise.all([ports.policy(client, userId, now), ports.avoid(client, userId)]);
  const families = avoidFamilies(avoid.names);
  const avoidRefs = new Set(avoid.refIds);
  const evidence = await refEvidence(ports, userId, [...new Set(refIds)].sort(), profile);
  const refOk = new Map<string, boolean>();
  const refAllowed = (foodRefId: string) => {
    let ok = refOk.get(foodRefId);
    if (ok === undefined) {
      ok = !avoidRefs.has(foodRefId) && evidence.status === "ready"
        && suggestionItemsVerdict([{ foodRefId, catalogFoodRevisionId: null, verdict: "allowed" }], evidence,
          profile, false).outcome === "allowed";
      refOk.set(foodRefId, ok);
    }
    return ok;
  };
  const rules = { profile, preferenceFlags: evidence.preferenceFlags, avoidFamilies: families };
  const universeOk = (id: string) => {
    const entry = universeEntry(id);
    const item = entry ? deriveItem(entry) : null;
    return evidence.status === "ready" && item !== null && universeVerdict(rules, item).verdict === "allowed";
  };
  const familyOk = (key: string) => !familiesOf(key, history.reps.get(key)).some((family) => families.has(family));
  return { refAllowed, refAvoided: (foodRefId) => avoidRefs.has(foodRefId), universeOk, familyOk,
    avoidFamilies: families, evidenceReady: evidence.status === "ready", rulesRevision: rev };
}

/**
 * The rows that may count. A row counts only when its identity's family is not avoided, every
 * gate identity's family is not avoided, and every ref the row stands for (taste-history.ts
 * `Vouched`) is `allowed` and not on Avoid. An unreadable row never reaches here (taste-resolve.ts).
 */
export async function admitHistory(
  client: SupabaseClient, userId: string, history: TasteHistory, now: Date, ports: TastePorts,
): Promise<AdmittedHistory> {
  const allRefs = [...history.items, ...history.choices].flatMap((row) => [...row.refIds,
    ...(row.dishRefIds ?? [])]).concat([...history.reps.values()].flatMap(judgedRefs));
  const { refAllowed, universeOk, familyOk, rulesRevision } = await tasteJudge(client, userId, history, allRefs,
    now, ports);
  /**
   * Branch on how the row resolved (taste-resolve.ts), never on whether `refIds` is empty:
   * resolved → every ref it stands for; ref-free universe item → the W2b `universeVerdict`;
   * ref-free family (a legacy name) → every ref the history holds for that identity, else its
   * Favored refs, and none means it does not count. A mixed-dish input also needs the dish's refs.
   */
  const rowOk = (row: HistoryItem | HistoryChoice) => {
    const gates = row.gates ?? [];
    if (!familyOk(row.identity.key) || !gates.every(familyOk)) return false;
    if (!(row.dishRefIds ?? []).every(refAllowed)) return false;
    switch (row.resolution) {
      case "resolved":
        return row.refIds.length > 0 && row.refIds.every(refAllowed);
      case "ref_free": {
        if (row.identity.match === "universe") return universeOk(row.identity.key.slice(2));
        const refs = judgedRefs(history.reps.get(row.identity.key));
        return refs.length > 0 && refs.every(refAllowed);
      }
      default:
        return false;
    }
  };
  const items = history.items.filter(rowOk);
  const choices = history.choices.filter(rowOk);
  const admitted = new Set([...items, ...choices].map((row) => row.identity.key));
  return { items, choices, admitted, rulesRevision };
}

/** One "Eaten often" row (§7.1): admitted foods only. */
export type TasteItem = {
  key: string; name: string; days180: number; lastOn: string; favored: boolean;
  /**
   * A Favor would succeed under this read (the shared Favor plan, lib/server/taste-favor.ts): at
   * least one family of the item's refs can hold `eats`. May be true while `favored` is true.
   */
  favorable: boolean;
  /** H and Q (D5), four decimals. */
  h: number; q: number;
  provenance: TasteProvenance;
};

export type TasteResponse = {
  version: typeof TASTE_VERSION;
  asOf: string;
  windowDays: number;
  /** M: weighted independent choice episodes (the D8 prior fade). */
  m: number;
  episodes: number;
  rulesRevision: number;
  /** Up to 50, highest H first. */
  items: TasteItem[];
};

/**
 * Which listed keys a Favor would succeed for, from the shared Favor plan (lib/server/taste-favor.ts
 * `favorableResolver`). Injected, so this module never reaches the Favor write path.
 */
export type FavorableKeys = (history: TasteHistory, keys: string[]) => Promise<Set<string>>;
export const NONE_FAVORABLE: FavorableKeys = async () => new Set();

/** The taste answer and the history it was computed from (shared with the Favor write). */
export async function computeTaste(
  client: SupabaseClient, userId: string, today: string,
  ports: TastePorts = DEFAULT_TASTE_PORTS, now: Date = new Date(), favorable: FavorableKeys = NONE_FAVORABLE,
): Promise<{ history: TasteHistory; response: TasteResponse }> {
  const history = await readTasteHistory(client, userId, today, ports.mixedDishInputs);
  const { items: counted, choices, admitted, rulesRevision } = await admitHistory(client, userId, history, now, ports);
  const profile = tasteProfile({ today, items: counted, choices, admitted });
  const rows = profile.identities.filter((row) => row.days180 > 0 && row.lastOn !== null).slice(0, TASTE_LIMIT);
  const offered = await favorable(history, rows.map((row) => row.key));
  const items = rows.map((row): TasteItem => ({
    key: row.key, name: row.name, days180: row.days180, lastOn: row.lastOn as string,
    favored: history.favored.has(row.key), favorable: offered.has(row.key),
    h: row.h, q: row.q, provenance: row.provenance,
  }));
  return { history, response: { version: TASTE_VERSION, asOf: today, windowDays: TASTE_WINDOW_DAYS, m: profile.m,
    episodes: profile.episodes, rulesRevision, items } };
}

/** The account's taste history on `today`, for `GET /api/foods/taste`. */
export async function accountTaste(
  client: SupabaseClient, userId: string, today: string,
  ports: TastePorts = DEFAULT_TASTE_PORTS, now: Date = new Date(), favorable: FavorableKeys = NONE_FAVORABLE,
): Promise<TasteResponse> {
  return (await computeTaste(client, userId, today, ports, now, favorable)).response;
}
