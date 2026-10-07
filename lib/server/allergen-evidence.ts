/**
 * Phase 13 §5 and §9 R2 (slice 2): reading and writing stored allergen evidence
 * (food_allergen_evidence) and the user's per-product label checks (user_allergen_checks).
 *
 * The evidence itself is decided by one pure function (lib/policy/allergens.ts deriveEvidence).
 * This module stores its result per food revision and allergen when a food is warmed, so readers
 * that have no ingredient text (suggestions, search) still get it. Every read DEGRADES to "no
 * evidence": a failed read can only make a verdict more cautious (unverified), never allow more.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllChunked } from "@/lib/server/paged-read";
import {
  allergenKey, EVIDENCE_KEYS, evidenceFromInputs, mergeEvidence, withCrustaceanAllowance, type AllergenLevel, type StoredAllergenEvidence,
} from "@/lib/policy/allergens";
import { JEV_EVIDENCE_SOURCE, storedEvidenceFromRow } from "@/lib/policy/allergen-holds";

if (typeof window !== "undefined") {
  throw new Error("lib/server/allergen-evidence.ts is server-only.");
}

export type EvidenceByFood = Map<string, Record<string, StoredAllergenEvidence>>;

type EvidenceRow = {
  food_key: string; allergen: string; level: AllergenLevel; label_complete: boolean;
  source: string | null;
};

const unique = (keys: readonly string[]) => [...new Set(keys)].filter(Boolean);

/** The raw select, thrown on any error rather than swallowed — callers decide what to do. */
async function fetchEvidenceRows(
  client: SupabaseClient, keys: readonly string[],
): Promise<EvidenceByFood> {
  const out: EvidenceByFood = new Map();
  if (keys.length === 0) return out;
  // t18: one food holds a row per allergen, so a few hundred keys pass the API row cap. Paged
  // and chunked by primary key; any failed page throws (never a partial map read as "no evidence").
  const rows = await fetchAllChunked<string, EvidenceRow>(keys, (batch, from, to) =>
    client.from("food_allergen_evidence").select("food_key,allergen,level,label_complete,source")
      .in("food_key", batch).order("food_key").order("allergen").range(from, to));
  for (const row of rows) {
    const current = out.get(row.food_key) ?? {};
    const key = allergenKey(row.allergen);
    // Phase 18 W2a: a `listed` row whose source is Jev is a hold, not a block (lib/policy/allergens.ts).
    const value = storedEvidenceFromRow({ level: row.level, labelComplete: row.label_complete,
      source: row.source });
    // sol FIX (review round 2): two stored rows can normalize to the SAME key here — a raw,
    // un-normalized spelling (e.g. 'tree nut') beside its canonical row ('tree-nut'), the exact
    // duplicate a legacy backfill could still write for a spelling this migration does not (yet)
    // carry an alias for. `mergeEvidence` (the same monotonic listed > not_listed > no_evidence
    // merge every other evidence join in this codebase already uses) keeps the stronger of the
    // two regardless of which one this unordered select happens to return last, instead of the
    // plain overwrite silently picking a random winner.
    current[key] = mergeEvidence(current[key], value) ?? value;
    out.set(row.food_key, current);
  }
  return out;
}

/**
 * Stored evidence per food key, for a READER (search, detail, a barcode scan). A read error is
 * NOT read as "no evidence": that fallback was only ever safe on the premise that a reader can
 * merely make a verdict MORE cautious on a miss, never less — a premise r3 FIX broke (sol BLOCK,
 * review round 2) once a live, complete ingredient list could independently derive `not_listed`
 * for a major allergen on its own. An empty map after a failed read then let a genuinely stored
 * `listed` (an earlier label, a legacy tag, Jev) disappear behind that fresh live-only read,
 * reversing a stored block instead of only ever adding to it. The caller fails the request
 * instead, the same posture `loadUserProfile` (lib/server/catalog.ts) already takes.
 */
export async function readAllergenEvidence(
  client: SupabaseClient, foodKeys: readonly string[],
): Promise<EvidenceByFood> {
  return fetchEvidenceRows(client, unique(foodKeys));
}

/**
 * The allergens this user marked checked, per food key, with an explicit failure signal.
 * `failed` is true when the read failed: the map is then empty, which a VERDICT may still read as
 * "not checked" (a check only ever relaxes a finding, so that is the cautious side), but a caller
 * that stores a proof or a rules fingerprint, or decides an allow list, must treat the rules as
 * unread (lib/server/recipe-candidates.ts, lib/coach/suggest-policy.ts).
 */
export type AllergenChecks = Map<string, string[]> & { readonly failed: boolean };

function withFailed(map: Map<string, string[]>, failed: boolean): AllergenChecks {
  return Object.assign(map, { failed });
}

export async function readAllergenChecks(
  client: SupabaseClient, userId: string | null, foodKeys: readonly string[],
): Promise<AllergenChecks> {
  const out = new Map<string, string[]>();
  const keys = unique(foodKeys);
  if (keys.length === 0) return withFailed(out, false);
  try {
    // A null user id means the caller's own RLS-scoped client; the service role always filters.
    // t18: paged and chunked (one row per checked allergen); a failed page is `failed`, never a
    // shorter list. Ordered by the primary key's (food_key, allergen) within the one account.
    const rows = await fetchAllChunked<string, { food_key: string; allergen: string }>(keys,
      (batch, from, to) => {
        const base = client.from("user_allergen_checks").select("food_key,allergen");
        return (userId === null ? base : base.eq("user_id", userId))
          .in("food_key", batch).order("food_key").order("allergen").range(from, to);
      });
    for (const row of rows) {
      out.set(row.food_key, [...(out.get(row.food_key) ?? []), allergenKey(row.allergen)]);
    }
  } catch (error) {
    console.warn("[allergen-evidence] check read failed; treating as unchecked", {
      error: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
    return withFailed(new Map(), true);
  }
  return withFailed(out, false);
}

/**
 * finding #11: an account's own avoided allergens, deduped and normalized, for scoping the
 * coverage metric in lib/foods/facet-warm.ts to what the account actually needs evidenced, not
 * "any of the ten". A read failure degrades to `[]` — vacuously "fully covered" — rather than
 * skipping the scope: this feeds a metric ("a signal, not an alarm"), so a transient read trouble
 * should not manufacture a false low-coverage reading.
 *
 * finding #4 (round 10): this used to filter down to the fixed vocabulary here, before
 * `recordAllergenEvidence` ever saw the result — so an account that avoids ONLY a custom allergen
 * outside that vocabulary (e.g. "mustard") reached `recordAllergenEvidence` as `[]`, indistinguish-
 * able from an account that avoids nothing at all, and got the same vacuous 100% coverage. The
 * FULL avoided list goes through unfiltered now; `recordAllergenEvidence` does its own
 * fixed-vocabulary narrowing (it already did, redundantly) and can tell the two cases apart.
 */
export async function avoidedAllergensFor(
  client: SupabaseClient, userId: string,
): Promise<string[]> {
  try {
    const { data, error } = await client.from("constraint_profiles")
      .select("avoid_allergens").eq("user_id", userId);
    if (error) return [];
    const row = (data as { avoid_allergens?: string[] }[] | null)?.[0];
    return [...new Set((row?.avoid_allergens ?? []).map(allergenKey))];
  } catch {
    return [];
  }
}

export type EvidenceFood = {
  foodKey: string;
  /** The owner for a user food; null for a catalog revision. */
  userId: string | null;
  ingredientsText: string | null | undefined;
  labelComplete: boolean;
  tags?: readonly string[] | null;
  /** The food's own name: a name that names an allergen is deterministic `listed` evidence. */
  foodName?: string | null;
  foodBrand?: string | null;
};

/**
 * Derives and upserts evidence for every stored allergen key of each food. A stored `listed`
 * (a legacy tag, an earlier label) is never downgraded; a new complete list can only move
 * no_evidence to not_listed. Phase 18 W2a: no Jev facet is read, so this never writes a new
 * `source = 'jev'` row, and a stored hold is written back unchanged (`source = 'jev'`).
 * Returns what it wrote and the foods that now have evidence.
 *
 * `withEvidence` (finding #11) counts a food covered when EVERY allergen in `avoidedFixed` — the
 * caller's own active, fixed-vocabulary allergen rules — has evidence beyond no_evidence. Without
 * a scope (the default, `undefined`), it falls back to "any fixed key has evidence", which is what
 * a caller with no single account in view (a catalog-wide warm) can still report. The coverage
 * metric this feeds is meant to measure false exclusions against the ACCOUNT'S OWN rules (§5): "any
 * evidence for any of the ten fixed keys" cannot do that — a food fully evidenced for dairy tells a
 * peanut-allergic account nothing about whether ITS rule could be silently excluding a food. An
 * account that avoids nothing in the fixed vocabulary is vacuously covered (`avoidedFixed: []`).
 */
export async function recordAllergenEvidence(
  writer: SupabaseClient, foods: readonly EvidenceFood[],
  avoidedFixed?: readonly string[],
): Promise<{ written: number; errors: number; withEvidence: number }> {
  if (foods.length === 0) return { written: 0, errors: 0, withEvidence: 0 };
  let existing: EvidenceByFood;
  try {
    existing = await fetchEvidenceRows(writer, unique(foods.map((food) => food.foodKey)));
  } catch (error) {
    // A read failure here is not "nothing stored" — it is "unknown", and treating it as the
    // former would let this write downgrade a stored `listed` this call never actually saw
    // (the same risk a genuinely concurrent warmer's stale read carries). Skip the write.
    console.warn("[allergen-evidence] pre-write read failed; skipping this warm rather than " +
      "risking a downgrade of evidence it could not see", {
      error: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
    return { written: 0, errors: foods.length, withEvidence: 0 };
  }
  const requireKeys = avoidedFixed === undefined ? null
    : [...new Set(avoidedFixed.map(allergenKey))].filter((key) => EVIDENCE_KEYS.includes(key));
  const rows: Record<string, unknown>[] = [];
  let withEvidence = 0;
  for (const food of foods) {
    const derived = evidenceFromInputs({ ingredientsText: food.ingredientsText,
      labelComplete: food.labelComplete, tags: food.tags, foodName: food.foodName });
    const stored = existing.get(food.foodKey) ?? {};
    const mergedByKey: Record<string, StoredAllergenEvidence> = {};
    for (const key of EVIDENCE_KEYS) {
      // A stored hold is written back as a hold, even when this food's own inputs now name the
      // allergen: turning it into a deterministic block is a logged review (scripts/
      // allergen-jev-holds.ts --rederive), never a silent rewrite here. The database enforces the
      // same (migration 20261212090000). Readers with the name still block it meanwhile.
      const merged = stored[key]?.held ? stored[key]
        : mergeEvidence(stored[key], derived[key]) ?? derived[key];
      mergedByKey[key] = merged;
      rows.push({
        food_key: food.foodKey, allergen: key, level: merged.level,
        label_complete: merged.labelComplete,
        source: merged.held ? JEV_EVIDENCE_SOURCE : food.labelComplete ? "label" : "ingredients",
        user_id: food.userId, updated_at: new Date().toISOString(),
      });
    }
    // A hold is not evidence: it neither blocks nor clears, so it never counts as covered.
    const covered = (key: string) => mergedByKey[key].level !== "no_evidence" && !mergedByKey[key].held;
    // finding #4 (round 10): `requireKeys` can be empty for two different reasons — the account
    // avoids nothing at all (vacuously covered, correct), or it avoids only allergen(s) outside
    // the fixed vocabulary this store can ever evidence (e.g. "mustard") — and those must not
    // read the same way. `avoidedFixed` (unfiltered, see avoidedAllergensFor) still carries that
    // distinction even after `requireKeys` has filtered it away: covered only when the account
    // truly avoids nothing, "n/a" (not covered) when it avoids something this metric can never
    // track — never a false 100%.
    const informative = requireKeys === null ? EVIDENCE_KEYS.some(covered)
      : requireKeys.length === 0 ? (avoidedFixed as readonly string[]).length === 0
      : requireKeys.every(covered);
    if (informative) withEvidence += 1;
  }
  const { error } = await writer.from("food_allergen_evidence")
    .upsert(rows, { onConflict: "food_key,allergen" });
  if (error) {
    console.warn("[allergen-evidence] write failed", { error: error.message.slice(0, 200) });
    // sol FIX (review round 1, finding #8): `withEvidence` was computed above BEFORE this upsert
    // ever ran — reporting it here when the write itself failed claimed evidence for foods that
    // were never actually persisted, defeating §5's own coverage metric (a caller logging this
    // result cannot tell "nothing needed writing" from "the write failed" from the count alone).
    return { written: 0, errors: 1, withEvidence: 0 };
  }
  return { written: rows.length, errors: 0, withEvidence };
}

/**
 * Phase 13 §9 R1: the user marks the exact product(s) behind these food refs as label-checked for
 * every allergen their account avoids (or clears that mark). Runs on the caller's own RLS client:
 * food_refs, catalog revisions and user_allergen_checks are all read or written as the user.
 * A catalog ref is resolved to its ACTIVE revision, a user ref to the user food's current rev,
 * so a later revision needs a fresh check.
 *
 * `expectedRevisions` (finding #6, and r4 BLOCK #7 for the user-food half) is the revision — a
 * catalog food's active revision id, OR a user food's own `rev` — the CALLER actually looked at,
 * keyed by food ref id: `match.revisionId` off the barcode card the "I checked the label" button
 * sits on, for a catalog ref. A background refresh (lib/server/barcode.ts refreshBarcode) can move
 * a catalog food's active revision between the moment the user reads a label and the moment they
 * tap the button, and an edit can advance a user food's own `rev` the same way; without this
 * check, "whatever is current on arrival" silently marks a product they never actually inspected.
 * A ref with no expectation given (an older client, or a caller with no natural "revision I looked
 * at" — lib/foods/label-check-client.ts's Foods-list flow) keeps the prior, unchecked behavior. A
 * mismatched ref is skipped and reported in `stale`, never marked.
 */
export async function markLabelChecked(
  client: SupabaseClient, userId: string, foodRefIds: readonly string[],
  avoided: readonly string[], checked: boolean,
  expectedRevisions: Readonly<Record<string, number>> = {},
): Promise<{ foodKeys: string[]; allergens: string[]; stale: string[] }> {
  // finding (r5): avoiding the combined `shellfish` setting also means the FALCPA-major
  // crustacean key needs its own check — every other JUDGE/RECORD caller expands via
  // withCrustaceanAllowance (constraints.ts, capture.ts, barcode-policy.ts); this write path is
  // the one that RECORDS a label check and had been the sole holdout, so a shellfish-avoiding
  // account tapping "I checked the label" could never actually clear the crustacean finding.
  const allergens = withCrustaceanAllowance(avoided).filter(Boolean);
  const refs = await client.from("food_refs").select("id,kind,catalog_food_id,user_food_id")
    .in("id", [...new Set(foodRefIds)]);
  if (refs.error) throw new Error(refs.error.message);
  const rows = (refs.data ?? []) as { id: string; kind: "catalog" | "user";
    catalog_food_id: number | null; user_food_id: string | null }[];
  const catalogRefs = rows.filter((ref) => ref.kind === "catalog" && ref.catalog_food_id !== null);
  const catalogIds = catalogRefs.map((ref) => ref.catalog_food_id as number);
  const userFoodIds = rows.flatMap((ref) => ref.kind === "user" && ref.user_food_id
    ? [ref.user_food_id] : []);
  const [revisions, userFoods] = await Promise.all([
    catalogIds.length === 0 ? { data: [], error: null }
      : client.from("catalog_food_revisions").select("id,catalog_food_id")
        .in("catalog_food_id", catalogIds).eq("is_active", true),
    userFoodIds.length === 0 ? { data: [], error: null }
      : client.from("user_foods").select("id,rev").in("id", userFoodIds).eq("user_id", userId),
  ]);
  if (revisions.error || userFoods.error) throw new Error("food lookup failed");
  const activeRevisionByFood = new Map(((revisions.data ?? []) as
    { id: number; catalog_food_id: number }[]).map((row) => [row.catalog_food_id, row.id]));
  const stale: string[] = [];
  const catalogKeys: string[] = [];
  for (const ref of catalogRefs) {
    const activeId = activeRevisionByFood.get(ref.catalog_food_id as number);
    if (activeId === undefined) continue;
    const expected = expectedRevisions[ref.id];
    if (expected !== undefined && expected !== activeId) { stale.push(ref.id); continue; }
    catalogKeys.push(`catalog_revision:${activeId}`);
  }
  // r4 BLOCK #7: a user-food ref carries the same staleness risk as a catalog one — its `rev`
  // can advance (an edit) between the caller's read and this write — so an expectation given for
  // it must be honored the same way, not only checked for catalog refs.
  const revByUserFoodId = new Map(((userFoods.data ?? []) as
    { id: string; rev: number }[]).map((row) => [row.id, row.rev]));
  const userKeys: string[] = [];
  for (const ref of rows.filter((r) => r.kind === "user" && r.user_food_id !== null)) {
    const rev = revByUserFoodId.get(ref.user_food_id as string);
    if (rev === undefined) continue;
    const expected = expectedRevisions[ref.id];
    if (expected !== undefined && expected !== rev) { stale.push(ref.id); continue; }
    userKeys.push(`user_food:${ref.user_food_id}:${rev}`);
  }
  const foodKeys = [
    ...new Set(catalogKeys),
    ...new Set(userKeys),
  ];
  if (foodKeys.length === 0 || allergens.length === 0) return { foodKeys, allergens, stale };
  if (checked) {
    const { error } = await client.from("user_allergen_checks").upsert(
      foodKeys.flatMap((foodKey) => allergens.map((allergen) => ({ user_id: userId, food_key: foodKey,
        allergen }))),
      { onConflict: "user_id,food_key,allergen", ignoreDuplicates: true });
    if (error) throw new Error(error.message);
  } else {
    // sol FIX (review round 1, finding #5): scoped to the exact allergens being cleared, not the
    // food key alone — this only ever applies to the account's currently avoided allergens, and a
    // previously recorded check for a DIFFERENT, still-active allergen on the same food must
    // survive clearing this one.
    const { error } = await client.from("user_allergen_checks").delete()
      .eq("user_id", userId).in("food_key", foodKeys).in("allergen", allergens);
    if (error) throw new Error(error.message);
  }
  return { foodKeys, allergens, stale };
}
