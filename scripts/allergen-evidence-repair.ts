/**
 * RETIRED for writes by Phase 18 W2a (see REPAIR_RETIRED below); the report still runs.
 *
 * Report for the 2026-10-03 incident (the write guard, since removed): finds stored
 * `food_allergen_evidence` rows that are `listed`, `source: 'jev'`, and contradict the curated
 * check this repo now applies at write time — every Jev facet behind the row scored BELOW
 * `JEV_ALLERGEN_EVIDENCE_MIN_P`, and no ingredient text, allergen tag or name on file names the
 * allergen either. `recordAllergenEvidence` never downgrades a stored `listed` (§5: Jev is a
 * warning signal, never clearance), so this used to delete the
 * contradicting row. Under W2a that would release a hold, so it now only reports.
 *
 *   (no flag)              read-only report, any project
 *   --fix, --branch-check  retired by Phase 18 W2a: refused (the delete path is removed)
 *
 * Modeled on scripts/food-membership-audit.ts: --fix refuses production unless --production is
 * passed, and refuses outright when the project cannot be identified from SUPABASE_URL.
 */
import { fileURLToPath } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import { allergenKey, allergenRule, textNames } from "@/lib/policy/allergens";
import { adminClient } from "@/lib/server/admin";
import { fetchAllChunked, fetchAllRows } from "@/lib/server/paged-read";

const PRODUCTION_REF = "fivatgdpuenszxxnijpc";

/**
 * The confidence floor the retired write-path guard (lib/policy/allergen-write-guard.ts, removed
 * by Phase 18 W2a) used. Kept here for the read-only report only.
 */
export const JEV_ALLERGEN_EVIDENCE_MIN_P = 0.5;

/**
 * Phase 18 W2a: a stored `listed, source = 'jev'` row is now a HOLD (lib/policy/allergens.ts).
 * Deleting one would turn it into no_evidence, which the whole-food class can clear — a hold
 * released by automation. So --fix and --branch-check are retired; the report stays. A hold is
 * lifted only by a logged review: scripts/allergen-jev-holds.ts --review.
 */
export const REPAIR_RETIRED = "allergen-evidence-repair --fix is retired by Phase 18 W2a: a Jev "
  + "row is a hold, and deleting it could release it. Use scripts/allergen-jev-holds.ts --review.";

export type EvidenceRow = {
  food_key: string; allergen: string; level: string; label_complete: boolean; source: string;
  user_id: string | null; updated_at: string;
};

export type FoodInfo = {
  /** The food's real name, read for the text/tag veto only — see `findContradictions`' own
   * privacy note on what reaches `Contradiction.foodName` (what this script may print). */
  foodName: string | null;
  foodBrand?: string | null;
  ingredientsText?: string | null;
  tags?: readonly string[] | null;
};

export type Contradiction = {
  foodKey: string;
  allergen: string;
  maxP: number | null;
  /** The catalog description, when this is a catalog row — never a user food's own name. */
  foodName: string | null;
  /** Carried from the evidence row so the delete can re-assert it (TOCTOU guard, below). */
  userId: string | null;
  /** Carried from the evidence row so the delete can re-assert it (TOCTOU guard, below). */
  updatedAt: string;
};

/**
 * Pages past PostgREST's 1000-row cap (Grok audit 2026-10-03, BLOCKER): the loop, its hard stop
 * and the `.in()` chunking live in lib/server/paged-read.ts, shared with the app's food-safety
 * reads. Every caller below supplies a total, unique `.order()`.
 */
export { fetchAllRows, PAGE_SIZE } from "@/lib/server/paged-read";

/**
 * The Supabase project ref from SUPABASE_URL's hostname, "local" for a loopback stack, or null
 * when it cannot be derived. Identical to scripts/food-membership-audit.ts's own helper.
 */
export function projectRef(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    if (host === "127.0.0.1" || host === "localhost" || host === "[::1]") return "local";
    const ref = host.split(".")[0];
    return /^[a-z0-9]{15,30}$/.test(ref) ? ref : null;
  } catch {
    return null;
  }
}

/** Throws when the flags would write somewhere they should not. Pure; reads only its inputs. */
export function assertWriteTarget(argv: readonly string[], url: string | undefined): void {
  const ref = projectRef(url);
  const production = ref === PRODUCTION_REF;
  const fix = argv.includes("--fix");
  const optIn = argv.includes("--production");
  if (argv.includes("--branch-check") && production) {
    throw new Error(`--branch-check refuses production project ${PRODUCTION_REF}`);
  }
  if (optIn && !fix) throw new Error("--production only applies together with --fix");
  if (optIn && !production) {
    throw new Error(`--production given, but SUPABASE_URL is not production project ${PRODUCTION_REF}`);
  }
  if (!fix) return;
  if (ref === null) {
    throw new Error("--fix refuses: cannot identify the Supabase project from SUPABASE_URL");
  }
  if (production && !optIn) {
    throw new Error(`--fix refuses production project ${PRODUCTION_REF} without --production; `
      + "run --branch-check on a branch first, then repeat with --fix --production as a deliberate step");
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseCatalogId(foodKey: string): number | null {
  const match = /^catalog_revision:([0-9]+)$/.exec(foodKey);
  return match ? Number(match[1]) : null;
}

/** `user_food:<id>:<rev>` with its revision dropped — the food's CURRENT row, not the possibly
 * stale one the bad evidence row happened to be written against (see `loadFoodInfo`). */
export function userFoodInfoKey(foodKey: string): string | null {
  const match = /^user_food:([0-9a-f-]+):[0-9]+$/i.exec(foodKey);
  return match ? `user_food:${match[1]}` : null;
}

/** The lookup key `loadFoodInfo`'s map uses for any food_key, catalog or user. */
export function infoLookupKey(foodKey: string): string {
  return userFoodInfoKey(foodKey) ?? foodKey;
}

/**
 * Every `listed`, `source: 'jev'` row that this repo's write-time guard would now refuse to
 * write: every Jev facet behind the allergen's rule scored below `JEV_ALLERGEN_EVIDENCE_MIN_P`
 * (missing data reads as "cannot verify" and is skipped, never assumed low), and no ingredient
 * text, allergen tag or name on file names the allergen (any of those added since the row was
 * written is real evidence and must never be deleted out from under it). Pure; no I/O —
 * `facetMaxP` and `foodInfo` are the caller's own reads.
 *
 * Grok audit (2026-10-03, MAJOR): an unknown food (no `foodInfo` row — a lookup miss, a deleted
 * food, a read that failed to resolve this key) used to skip the text/name veto and still qualify
 * for deletion. That inverted the fail-closed rule: "cannot verify" must leave the row alone, the
 * same as a missing facet reading does two lines below, never default to repairing it.
 *
 * Grok round 2 (MAJOR): the veto read only `ingredientsText`/`foodName`, never the food's
 * structured `allergen_tags` — `deriveEvidence` itself treats a matching tag as `listed` on its
 * own (lib/policy/allergens.ts `tagged`), so a tag this veto never checked could be deleted right
 * alongside the noise.
 *
 * DeepSeek round 2 (BLOCKER): withholding a user food's NAME from the veto (privacy, see
 * `loadFoodInfo`) used to mean withholding it from the SAFETY CHECK too — a food genuinely named
 * for its allergen ("Wheat crackers") with no ingredient text and a merely low Jev score would be
 * deleted. `foodInfo` now carries the real name for this function's own internal check; only the
 * OUTPUT row (`Contradiction.foodName`, everything `printRows` can ever print) still forces null
 * for a user food, decided here from the food_key's own shape, never from whatever `foodInfo`
 * returned.
 */
export function findContradictions(
  rows: readonly EvidenceRow[],
  facetMaxP: (foodKey: string, facets: readonly string[]) => number | null,
  foodInfo: (foodKey: string) => FoodInfo | undefined,
): Contradiction[] {
  const out: Contradiction[] = [];
  for (const row of rows) {
    if (row.level !== "listed" || row.source !== "jev") continue;
    const key = allergenKey(row.allergen);
    const facets = allergenRule(key).facets;
    if (facets.length === 0) continue;
    const info = foodInfo(row.food_key);
    if (!info) continue;
    // Grok round 3 (BLOCKER): an exact `allergenKey(tag) === key` match misses a tag spelled as
    // a FAMILY member rather than the rule's own key (e.g. a bare "wheat" tag, gluten's own
    // keyword but not its alias) — the production import path (lib/catalog/off-map.ts
    // declareGlutenFamily) already re-adds the "gluten" tag alongside "wheat" for exactly this
    // reason, but this veto must not depend on every writer having done that. `textNames` runs
    // the same keyword scan the live read path already trusts for prose.
    const tagged = (info.tags ?? []).some((tag) => allergenKey(tag) === key || textNames(key, tag));
    if (tagged || textNames(key, info.ingredientsText) || textNames(key, info.foodName)
      || textNames(key, info.foodBrand)) continue;
    const maxP = facetMaxP(row.food_key, facets);
    if (maxP === null || maxP >= JEV_ALLERGEN_EVIDENCE_MIN_P) continue;
    out.push({ foodKey: row.food_key, allergen: key, maxP,
      foodName: row.food_key.startsWith("user_food:") ? null : info.foodName,
      userId: row.user_id, updatedAt: row.updated_at });
  }
  return out;
}

export async function loadJevListedRows(admin: SupabaseClient): Promise<EvidenceRow[]> {
  // A total, unique order (the table's own primary key) so LIMIT/OFFSET paging cannot skip or
  // repeat a row across pages, or between this scan and the post-repair re-scan (Grok round 2).
  return fetchAllRows((from, to) => admin.from("food_allergen_evidence")
    .select("food_key,allergen,level,label_complete,source,user_id,updated_at")
    .eq("level", "listed").eq("source", "jev")
    .order("food_key").order("allergen").range(from, to)) as Promise<EvidenceRow[]>;
}

/**
 * Grok round 3 (BLOCKER), round 4 (MINOR, "lock that input with a test"): `Number(null)` is `0`,
 * and `0` is a perfectly finite, confident "definitely absent" — the exact opposite of "cannot
 * verify". `food_facets.p` carries a `not null` constraint
 * (supabase/migrations/20261024090000_food_facets.sql) so this should never arrive as null from
 * that table, but this must not trust that blindly: the raw value is checked before any numeric
 * coercion ever gets a chance to manufacture a false zero. Exported so round 4's "never tested"
 * note has a direct target.
 */
export function finiteProbability(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const p = Number(raw);
  return Number.isFinite(p) ? p : null; // a malformed value can only be dropped, never count as 0.
}

async function loadFacetMaxByFoodKey(
  admin: SupabaseClient, foodKeys: readonly string[],
): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  if (foodKeys.length === 0) return out;
  const rows = await fetchAllChunked([...new Set(foodKeys)], (batch, from, to) =>
    admin.from("food_facets").select("food_key,facet,p").in("food_key", batch)
      .order("food_key").order("facet").order("input_hash").order("rubric_version")
      .range(from, to)) as { food_key: string; facet: string; p: unknown }[];
  for (const row of rows) {
    const p = finiteProbability(row.p);
    if (p === null) continue;
    const byFacet = out.get(row.food_key) ?? new Map<string, number>();
    byFacet.set(row.facet, Math.max(byFacet.get(row.facet) ?? 0, p));
    out.set(row.food_key, byFacet);
  }
  return out;
}

type CatalogInfoRow = { id: number; description: string; brand: string | null;
  catalog_ingredients: { seq: number; name: string; raw_text: string | null;
    allergen_tags: string[] | null }[] | null };
type UserFoodInfoRow = { id: string; name: string; ingredients_text: string | null;
  allergen_tags: string[] | null };

export async function loadFoodInfo(
  admin: SupabaseClient, rows: readonly EvidenceRow[],
): Promise<Map<string, FoodInfo>> {
  const out = new Map<string, FoodInfo>();
  const catalogIds = [...new Set(rows.map((row) => parseCatalogId(row.food_key))
    .filter((id): id is number => id !== null))];
  // Grok audit (2026-10-03, MAJOR): keyed by id alone, dropping the evidence row's own (possibly
  // stale) revision — a user food revised since the bad write must still be read at its CURRENT
  // ingredients_text, or an allergen a later edit genuinely added would go unseen by the veto.
  const userFoodIds = [...new Set(rows.map((row) => userFoodInfoKey(row.food_key))
    .filter((key): key is string => key !== null).map((key) => key.split(":")[1]))];
  if (catalogIds.length > 0) {
    const catalogRows = await fetchAllChunked(catalogIds.map(String), (batch, from, to) =>
      admin.from("catalog_food_revisions")
        .select("id,description,brand,catalog_ingredients(seq,name,raw_text,allergen_tags)")
        .in("id", batch.map(Number)).order("id").range(from, to)) as CatalogInfoRow[];
    for (const row of catalogRows) {
      const ingredients = row.catalog_ingredients ?? [];
      // Grok round 4 (BLOCKER): picking ONE of raw_text/name per row (the display-oriented join
      // every other caller uses) can drop the only on-file statement naming the allergen — a row
      // can carry a verbatim `raw_text` that does not happen to repeat its own parsed `name`.
      // This veto-only text scans BOTH, for every row, so a real allergen named in EITHER field
      // still wins; it is never used for anything printed or stored.
      const ingredientsText = [...ingredients].sort((a, b) => a.seq - b.seq)
        .flatMap((ingredient) => [ingredient.raw_text?.trim(), ingredient.name.trim()])
        .filter(Boolean).join(", ") || null;
      const tags = [...new Set(ingredients.flatMap((ingredient) => ingredient.allergen_tags ?? []))];
      out.set(`catalog_revision:${row.id}`, { foodName: row.description, foodBrand: row.brand,
        ingredientsText, tags });
    }
  }
  if (userFoodIds.length > 0) {
    const userRows = await fetchAllChunked(userFoodIds, (batch, from, to) =>
      admin.from("user_foods").select("id,name,ingredients_text,allergen_tags")
        .in("id", batch).order("id").range(from, to)) as UserFoodInfoRow[];
    for (const row of userRows) {
      // The real name is used by `findContradictions`' own veto only; it never reaches a
      // `Contradiction` for a user food (decided there from the food_key's own shape), so it is
      // never printed or stored by this script (DeepSeek round 2, BLOCKER — see that doc).
      out.set(`user_food:${row.id}`, { foodName: row.name, ingredientsText: row.ingredients_text,
        tags: row.allergen_tags });
    }
  }
  return out;
}

export async function loadContradictions(admin: SupabaseClient): Promise<Contradiction[]> {
  const rows = await loadJevListedRows(admin);
  const [facetMax, foodInfo] = await Promise.all([
    loadFacetMaxByFoodKey(admin, rows.map((row) => row.food_key)),
    loadFoodInfo(admin, rows),
  ]);
  return findContradictions(rows,
    (foodKey, facets) => {
      const byFacet = facetMax.get(foodKey);
      if (!byFacet) return null;
      const values = facets.map((facet) => byFacet.get(facet));
      if (values.some((value) => value === undefined)) return null;
      return Math.max(...(values as number[]));
    },
    (foodKey) => foodInfo.get(infoLookupKey(foodKey)));
}

/**
 * DeepSeek audit round 4 (MINOR): a user food's UUID, unlike its name, was never withheld —
 * `foodKey` was printed verbatim, which is a stable per-user-food identifier. The real `foodKey`
 * on the `Contradiction` itself is untouched (the delete still needs it); only this print redacts.
 */
export function redactedFoodKey(foodKey: string): string {
  return foodKey.startsWith("user_food:") ? "user_food:<redacted>" : foodKey;
}

function printRows(rows: readonly Contradiction[]): void {
  if (rows.length === 0) {
    console.log("allergen evidence contradictions: 0");
    return;
  }
  for (const row of rows) {
    console.log(JSON.stringify({
      foodKey: redactedFoodKey(row.foodKey), foodName: row.foodName, allergen: row.allergen,
      storedLevel: "listed", maxJevP: row.maxP,
    }));
  }
  console.log(`allergen evidence contradictions: ${rows.length}`);
}

/**
 * Read-only report. Phase 18 W2a (review r1 BLOCK 3): the delete path (`repairContradictions`
 * and its branch check) is removed, not only refused by the CLI — a deleted hold reads as
 * no_evidence, which the whole-food class can clear. The database refuses the delete too
 * (supabase/migrations/20261212090000_allergen_evidence_review.sql).
 */
export async function main(argv: string[]): Promise<void> {
  const allowed = new Set(["--fix", "--branch-check", "--production"]);
  const unknown = argv.filter((arg) => !allowed.has(arg));
  if (unknown.length > 0) throw new Error(`unknown argument: ${unknown.join(", ")}`);
  // Before any client exists: a refused run opens no connection at all.
  assertWriteTarget(argv, process.env.SUPABASE_URL);
  if (argv.includes("--fix") || argv.includes("--branch-check")) throw new Error(REPAIR_RETIRED);
  printRows(await loadContradictions(adminClient()));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(message(error));
    process.exitCode = 1;
  });
}
