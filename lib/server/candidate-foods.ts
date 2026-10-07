/**
 * The D4 admission order on the server (Phase 18 W2b): the one place that decides which foods any
 * generating surface may use for this account, before any score exists.
 *
 *   1. Read the account's stated rules, confirmed profile hard rules, diet flags, Avoid families,
 *      the verified Eats set and the freshness token. Any failed read admits nothing and throws
 *      (`503 admission_unavailable`); a pending rule or condition review throws
 *      `409 rule_review_required`, the gate that already pauses every surface.
 *   2. Apply family Avoid and `evaluatePolicy` (lib/foods/world/admission.ts). Only `allowed`
 *      foods with usable nutrition are admitted. A closed world admits the verified Eats only;
 *      an open one adds the universe (eaten, shopping and pantry foods join in W3, W11, W12).
 *   3. Stamp the answer with the token. If a rule or evidence write committed while this ran, the
 *      token moved: nothing is admitted under the old revision (`409 rules_changed`).
 *
 * Nothing reads this on a closed account yet: v1 and v2 of `/api/foods/eligible` are unchanged,
 * and W8's snapshot v3 is its first caller.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  admitRefs, admitUniverse, avoidFamilies, type ExcludedCandidate, type RefFacts,
} from "@/lib/foods/world/admission";
import { sameRulesToken, type RulesToken } from "@/lib/foods/world/freshness";
import { deriveItem, type UniverseItem } from "@/lib/foods/universe/derive";
import { UNIVERSE } from "@/lib/foods/universe/manifest";
import { normalizePreferenceFlags } from "@/lib/profile/onboarding-state";
import { HttpError } from "@/lib/server/auth";
import { readAvoidList } from "@/lib/server/avoid-list";
import { EVIDENCE_UNAVAILABLE, eligibleFoods, type EligibleFoods } from "@/lib/server/eligible-foods";
import { fetchAllChunked, fetchAllRows } from "@/lib/server/paged-read";
import { readPolicyProfile } from "@/lib/server/policy-profile";
import { readRulesToken } from "@/lib/server/rules-clock";

export type FoodWorld = "closed" | "open";

export type CandidateFoods = {
  world: FoodWorld;
  /** The freshness token every admitted id was decided under. */
  token: RulesToken;
  admittedRefIds: string[];
  admittedUniverseIds: string[];
  excluded: ExcludedCandidate[];
};

export type CandidateFoodsDeps = {
  universe?: readonly UniverseItem[];
  eligible?: (client: SupabaseClient, userId: string) => Promise<EligibleFoods>;
  now?: () => Date;
};

let universeCache: UniverseItem[] | null = null;
function universeItems(): UniverseItem[] {
  universeCache ??= UNIVERSE.map(deriveItem).filter((item): item is UniverseItem => item !== null);
  return universeCache;
}

type SettingsRow = { food_world?: unknown; diet_prefs?: { flags?: unknown } | null };
type OwnRow = { id: string; user_id: string; name: string | null; per_100g: Record<string, unknown> | null };
type RefRow = { id: string; kind: string; catalog_food_id: number | null; user_food_id: string | null;
  user_foods: OwnRow | OwnRow[] | null };
type RevisionRow = { catalog_food_id: number; description: string | null;
  catalog_food_nutrients: { nutrient_code: string; amount_per_100g: number | null }[] | null };

/** Per-100 g macros from a row's own values, or null when any is missing (never read as 0). */
function macros(values: Record<string, unknown> | null | undefined): RefFacts["nutrition"] {
  const pick = (key: string) => (typeof values?.[key] === "number" ? values[key] as number : null);
  const [protein, carbs, fat] = [pick("protein"), pick("carbohydrate"), pick("fat_total")];
  return protein === null || carbs === null || fat === null ? null : { protein, carbs, fat };
}

async function readSettings(client: SupabaseClient, userId: string) {
  const { data, error } = await client.from("user_settings").select("food_world,diet_prefs")
    .eq("user_id", userId).maybeSingle();
  if (error) throw error;
  const row = (data ?? null) as SettingsRow | null;
  const flags = row?.diet_prefs?.flags;
  return {
    world: (row?.food_world === "open" ? "open" : "closed") as FoodWorld,
    flags: normalizePreferenceFlags(Array.isArray(flags) ? flags.filter((f): f is string => typeof f === "string") : []),
  };
}

/** Every Avoid family: the names of avoided refs and every family-level Avoid mark. */
async function readAvoidNames(client: SupabaseClient, userId: string): Promise<string[]> {
  const [list, marks] = await Promise.all([
    readAvoidList(client, userId),
    fetchAllRows<{ name_norm: string }>((from, to) => client.from("food_membership_revisions")
      .select("name_norm").eq("user_id", userId).eq("status", "avoid").order("name_norm").range(from, to)),
  ]);
  return [...list.names, ...marks.map((row) => row.name_norm)];
}

/**
 * Each verified ref's name and nutrition: this account's own food, or the catalog's active
 * revision. A ref that maps to neither (another account's food, no active revision) reads as
 * name null, and admitRefs keeps it out.
 */
async function readRefFacts(client: SupabaseClient, userId: string, refIds: readonly string[]): Promise<RefFacts[]> {
  const refs = await fetchAllChunked<string, RefRow>(refIds, (ids, from, to) => client.from("food_refs")
    .select("id,kind,catalog_food_id,user_food_id,user_foods(id,user_id,name,per_100g)").in("id", ids)
    .order("id").range(from, to));
  const catalogIds = refs.filter((ref) => ref.kind === "catalog" && ref.catalog_food_id !== null)
    .map((ref) => ref.catalog_food_id as number);
  const revisions = await fetchAllChunked<number, RevisionRow>(catalogIds, (ids, from, to) =>
    client.from("catalog_food_revisions")
      .select("catalog_food_id,description,catalog_food_nutrients(nutrient_code,amount_per_100g)")
      .in("catalog_food_id", ids).eq("is_active", true).order("id").range(from, to));
  const byCatalog = new Map(revisions.map((row) => [row.catalog_food_id, row]));
  return refIds.map((refId): RefFacts => {
    const ref = refs.find((row) => row.id === refId);
    if (ref?.kind === "user") {
      const own = Array.isArray(ref.user_foods) ? ref.user_foods[0] : ref.user_foods;
      const mine = own && own.user_id === userId && own.id === ref.user_food_id ? own : null;
      return { refId, name: mine?.name ?? null, nutrition: macros(mine?.per_100g) };
    }
    const revision = ref?.kind === "catalog" && ref.catalog_food_id !== null ? byCatalog.get(ref.catalog_food_id) : undefined;
    return { refId, name: revision?.description ?? null, nutrition: macros(revision ? Object.fromEntries(
      (revision.catalog_food_nutrients ?? []).map((n) => [n.nutrient_code, n.amount_per_100g])) : null) };
  });
}

function unavailable(cause: unknown): never {
  if (cause instanceof HttpError && cause.status === 409) throw cause;
  throw new HttpError(503, "admission_unavailable", "Your food rules could not be checked right now.", { cause });
}

export async function candidateFoods(client: SupabaseClient, userId: string,
  deps: CandidateFoodsDeps = {}): Promise<CandidateFoods> {
  const before = await readRulesToken(client, userId).catch(unavailable);
  let read: { settings: Awaited<ReturnType<typeof readSettings>>; eligible: EligibleFoods;
    policy: Awaited<ReturnType<typeof readPolicyProfile>>; avoidNames: string[] };
  try {
    const [settings, eligible, policy, avoidNames] = await Promise.all([
      readSettings(client, userId), (deps.eligible ?? eligibleFoods)(client, userId),
      readPolicyProfile(client, userId, deps.now?.() ?? new Date()), readAvoidNames(client, userId),
    ]);
    read = { settings, eligible, policy, avoidNames };
  } catch (error) {
    unavailable(error);
  }
  // A failed Eats evidence read comes back as "unchecked" exclusions, not a throw: it admits nothing.
  if (read.eligible.excluded.some((ref) => ref.reason === EVIDENCE_UNAVAILABLE)) {
    unavailable(new Error("eats evidence unavailable"));
  }
  const families = avoidFamilies(read.avoidNames);
  const refFacts = await readRefFacts(client, userId, read.eligible.eligibleRefIds).catch(unavailable);
  const refs = admitRefs(refFacts, new Set(read.eligible.eligibleRefIds), families);
  const universe = read.settings.world === "open"
    ? admitUniverse(deps.universe ?? universeItems(), {
      profile: read.policy.profile, preferenceFlags: read.settings.flags, avoidFamilies: families })
    : { admitted: [], excluded: [] };
  const after = await readRulesToken(client, userId).catch(unavailable);
  if (!sameRulesToken(before, after)) {
    throw new HttpError(409, "rules_changed", "Your food rules just changed. Try again.");
  }
  return { world: read.settings.world, token: after, admittedRefIds: refs.admitted,
    admittedUniverseIds: universe.admitted, excluded: [...refs.excluded, ...universe.excluded] };
}
