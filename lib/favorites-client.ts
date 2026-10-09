/**
 * The client half of the three favorites entities — Phase 3 spec, "Client changes".
 *
 * A favorite's payload is only `{ sort }`, so the strip needs a name from somewhere: recipes and
 * saved meals carry theirs in their own store, and a starred food carries none — food_ref_id is a
 * registry uuid. `toggleFavorite` therefore records what the user starred in a client-only name index
 * in the `meta` store. The index is a convenience, never a source of truth: a missing entry
 * renders "Saved food" rather than blocking the row.
 */
import { accountHandle, assertCurrent, type AccountHandle } from "@/lib/device/account";
import { nextSort, type FavoriteKind, type FavoriteRow } from "@/lib/favorites";
import { favoritesTx } from "@/lib/favorites-tx";
import { allRows, getMeta, getRow, putMeta } from "@/lib/sync/idb";
import type { Entity } from "@/lib/sync/types";

export type FavoriteMeta = { name?: string; catalogFoodId?: number | null; revisionId?: number | null };

const NAME_INDEX_KEY = "favorite_names";
const ENTITY: Record<FavoriteKind, Entity> = {
  food: "favorites_foods", recipe: "favorites_recipes", meal: "favorites_meals",
};
const KEY_COLUMN: Record<FavoriteKind, string> = {
  food: "food_ref_id", recipe: "recipe_id", meal: "id",
};

type NameIndex = Record<string, FavoriteMeta>;

async function readIndex(h: AccountHandle): Promise<NameIndex> {
  return (await getMeta<NameIndex>(h, NAME_INDEX_KEY)) ?? {};
}

async function writeIndex(h: AccountHandle, key: string, meta: FavoriteMeta): Promise<void> {
  const index = await readIndex(h);
  await putMeta(h, NAME_INDEX_KEY, { ...index, [key]: { ...index[key], ...meta } });
}

/** Returns the new state: true when it is now starred. */
export async function toggleFavorite(
  kind: FavoriteKind, id: string, sort?: number, meta?: FavoriteMeta,
): Promise<boolean> {
  return toggleAs(accountHandle(), kind, id, sort, meta);
}

/**
 * Idempotent: leaves `id` starred (`on`) or not, and returns the stored state. Unlike a toggle, a
 * repeat — or a retry after a write that landed but did not answer — never flips it back. The work
 * runs as `h` (the account the tap started as), never a later one.
 */
export async function setFavorite(
  kind: FavoriteKind, id: string, on: boolean, meta?: FavoriteMeta, h: AccountHandle = accountHandle(),
): Promise<boolean> {
  assertCurrent(h);
  const row = (await getRow(h, ENTITY[kind], id)) as Record<string, unknown> | undefined;
  const starred = Boolean(row && !row.deleted_at);
  if (starred !== on) return toggleAs(h, kind, id, undefined, meta);
  if (on && meta) await writeIndex(h, `${kind}:${id}`, meta);
  return on;
}

async function toggleAs(
  h: AccountHandle, kind: FavoriteKind, id: string, sort?: number, meta?: FavoriteMeta,
): Promise<boolean> {
  const entity = ENTITY[kind];
  const now = new Date().toISOString();
  if (meta) await writeIndex(h, `${kind}:${id}`, meta);
  // The mirror row and its op commit in ONE transaction (Sol r1 #1): a tombstone written before a
  // failed enqueue would be a delete the server never hears of.
  return favoritesTx(h, entity, async (tx) => {
    const row = await tx.get(id);
    const rev = typeof row?.rev === "number" ? row.rev : null;
    if (row) {
      const deleting = !row.deleted_at;
      await tx.put(id, { ...row, deleted_at: deleting ? now : null });
      await tx.enqueue({ op_id: crypto.randomUUID(), entity, entity_id: id,
        kind: deleting ? "delete" : "restore", base_rev: rev, payload: {}, client_ts: now });
      return !deleting;
    }
    if (kind === "meal") {
      throw new Error("favorites_meals: a saved meal is starred, not created, by toggleFavorite");
    }
    const existing = (await tx.getAll()).map((r) => ({ sort: Number(r.sort ?? 0) }));
    const payload = { [KEY_COLUMN[kind]]: id, sort: sort ?? nextSort(existing) };
    await tx.put(id, { ...payload, rev: 1, deleted_at: null, updated_at: now });
    await tx.enqueue({ op_id: crypto.randomUUID(), entity, entity_id: id, kind: "create",
      base_rev: null, payload, client_ts: now });
    return true;
  });
}

export async function listFavorites(): Promise<FavoriteRow[]> {
  const h = accountHandle();
  const index = await readIndex(h);
  const out: FavoriteRow[] = [];
  for (const kind of ["food", "recipe", "meal"] as FavoriteKind[]) {
    for (const row of (await allRows(h, ENTITY[kind])) as Record<string, unknown>[]) {
      if (row.deleted_at) continue;
      const id = String(row[KEY_COLUMN[kind]]);
      const meta = index[`${kind}:${id}`] ?? {};
      const owner = kind === "recipe" ? await getRow(h, "recipes", id)
        : kind === "meal" ? row : undefined;
      // A favorite is a pointer, not a way to resurrect a deleted or missing account recipe.
      if (kind === "recipe" && (!owner || owner.deleted_at)) continue;
      out.push({
        kind, id, sort: Number(row.sort ?? 0),
        name: (owner?.name as string | undefined) ?? meta.name ?? "Saved food",
        foodRefId: kind === "food" ? id : undefined,
        catalogFoodId: meta.catalogFoodId ?? null, revisionId: meta.revisionId ?? null,
      });
    }
  }
  return out.sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id));
}
