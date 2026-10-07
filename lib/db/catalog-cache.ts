/**
 * Every catalog revision the user has touched, cached on the phone — contracts §5.
 *
 * The point is the offline rule in phase-2-real-logging.md: with no signal the sheet computes the
 * same snapshot the server would from this row, and a MISS blocks that food with a message rather
 * than logging a zeroed item. Nothing here is authoritative: the server snapshot wins on sync.
 *
 * It lives in the account's own database (Phase 9 §0.2: a cached row carries that account's
 * policy verdict) so there is one connection, one upgrade path and one place to clear. Each helper
 * takes the handle of the work that started it; a caller that starts no longer work passes none
 * and gets the bound account.
 */
import { accountHandle, assertCurrent, type AccountHandle } from "@/lib/device/account";
import { CATALOG_STORE, openAccountDb } from "@/lib/sync/idb";
import type { Portion } from "@/lib/foods/portions";
import type { PolicyVerdict } from "@/lib/policy/constraints";

export type CachedPortion = {
  id: number; description: string; gramWeight: number; isDefault: boolean;
};

export type CachedRevision = {
  revision_id: number;
  catalog_food_id: number;
  description: string;
  brand: string | null;
  source: string;
  version_label: string;
  /** nutrient_code → amount per 100 g. `null` means the source did not measure it. */
  per_100g: Record<string, number | null>;
  portions: CachedPortion[];
  /**
   * UI lane contract (lib/foods/portions.ts), mirrored into the offline cache under names that
   * cannot collide with the legacy `portions`/`per_100g` fields above — many components
   * (LogFoodSheet, CaptureDraftEditor, PortionFollowUps, …) already read those by their existing
   * name and shape, so this adds the serving-data fields rather than reshaping them.
   */
  kcalPer100g?: number | null;
  per100g?: { kcal: number | null; protein: number | null; carbs: number | null; fat: number | null } | null;
  servingPortions?: Portion[];
  defaultPortion?: Portion | null;
  /** Phase 3: the GTIN this revision was last scanned under, so an offline repeat resolves. */
  gtin14?: string;
  /** Phase 3: the food_ref this revision resolved to, so an offline repeat scan can log. */
  food_ref_id?: string;
  /** The online scan's allergen tags and policy verdict, so an offline repeat scan can show the
   * real verdict (e.g. blocked) instead of downgrading it to "unverified". Absent on a row cached
   * before this field existed. */
  allergen_tags?: string[];
  policy?: PolicyVerdict;
  cached_at: string;
};

export async function getRevision(
  id: number, h: AccountHandle = accountHandle(),
): Promise<CachedRevision | undefined> {
  const row = await (await openAccountDb(h)).get(CATALOG_STORE, id) as CachedRevision | undefined;
  assertCurrent(h);
  return row;
}

/**
 * Revision for a GTIN-14. A full scan of the store, not an index: the cache holds at most ~500
 * rows (spec "Offline"), an index would need another DB_VERSION bump, and DB_VERSION belongs to
 * Lane L this wave.
 *
 * More than one row can share a `gtin14` — a barcode re-fetched after the 90-day refresh (or a
 * corrected upstream match) writes a new `revision_id` without removing the old one. `getAll()`
 * returns rows in ascending key order, so the highest `revision_id` is the newest; picking the
 * first match would hand back a superseded allergen/policy verdict instead.
 */
export async function getByGtin(
  gtin14: string, h: AccountHandle = accountHandle(),
): Promise<CachedRevision | undefined> {
  const rows = (await (await openAccountDb(h)).getAll(CATALOG_STORE)) as CachedRevision[];
  assertCurrent(h);
  return rows
    .filter((row) => row.gtin14 === gtin14)
    .reduce<CachedRevision | undefined>(
      (newest, row) => (!newest || row.revision_id > newest.revision_id ? row : newest),
      undefined
    );
}

export async function putRevision(
  row: CachedRevision, h: AccountHandle = accountHandle(),
): Promise<void> {
  const db = await openAccountDb(h);
  assertCurrent(h);
  await db.put(CATALOG_STORE, row);
}

/**
 * Drop barcode-scanned revisions last cached more than `days` ago. Returns how many were removed.
 *
 * Scoped to rows carrying `gtin14`: this store also holds revisions cached purely from food
 * search (lib/catalog-client.ts cacheDetail), which never got a GTIN attached and whose offline
 * fallback (getFoodDetail) must not be swept by the barcode path's own retention policy.
 */
export async function evictOlderThan(
  days: number, now: number = Date.now(), h: AccountHandle = accountHandle(),
): Promise<number> {
  const cutoff = now - days * 86_400_000;
  const db = await openAccountDb(h);
  const tx = db.transaction(CATALOG_STORE, "readwrite");
  const rows = (await tx.store.getAll()) as CachedRevision[];
  assertCurrent(h);
  let removed = 0;
  for (const row of rows) {
    if (row.gtin14 !== undefined && Date.parse(row.cached_at) < cutoff) {
      await tx.store.delete(row.revision_id);
      removed += 1;
    }
  }
  await tx.done;
  return removed;
}
