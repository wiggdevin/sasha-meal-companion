/**
 * The one boundary every taste-history row passes before it can become evidence (Phase 18 W3,
 * Sol re-plan after round 2). Only lib/server/taste-history.ts calls it.
 *
 * A supplied ref or key is AUTHORITATIVE. If it is malformed, names no row, names a row whose
 * target is missing, or names another account's food, the row is `unreadable` and stops there: it
 * never falls back to a bundled id or a name. Raw field presence is checked before any parsing.
 * Only a row that supplied no ref and no key may use a bundled id (validated) or, last, its name.
 *
 *   resolved     a real row of this account (or a shared catalog row) with every policy ref it
 *                must be judged on: an account food AND the catalog food it was made from; for a
 *                `catalog:` key also every account food of this account made from it
 *   ref_free     no ref or key was supplied; identity from a validated bundled id or the name
 *   unreadable   anything else: contributes nothing and never enters the identity reps
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { dbFood } from "@/lib/food-db";
import { parseFoodKey } from "@/lib/meals/food-key";
import { exactName, identityOf, universeById, type TasteIdentity } from "@/lib/meals/taste-identity";
import { readByIdBatches } from "@/lib/server/date-chunks";

type RefRow = { id: string; kind: string; catalog_food_id: number | null; user_food_id: string | null };
type UserFoodRow = { id: string; name: string; catalog_food_id: number | null };
type CatalogRow = { id: number; source: string; source_id: string };
type RevisionRow = { catalog_food_id: number; description: string };

export type RowResolution =
  | { kind: "resolved"; identity: TasteIdentity; refIds: string[]; mixed: boolean; catalogId: number | null;
    name: string | null }
  | { kind: "ref_free"; identity: TasteIdentity; refIds: []; name: string | null }
  | { kind: "unreadable" };

const UNREADABLE: RowResolution = { kind: "unreadable" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a raw value is a well-formed row id (every food ref and account food id is a uuid). */
export const isRowId = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

const own = (row: object, field: string): boolean => Object.prototype.hasOwnProperty.call(row, field);

async function select<T>(query: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const { data, error } = await query;
  if (error) throw error instanceof Error ? error : new Error(String((error as { message?: unknown }).message));
  return (data ?? []) as T[];
}

/** Loads refs, own foods and catalog foods in batches, then resolves only rows that exist. */
export class Resolver {
  private refs = new Map<string, RefRow>();
  private ownFoods = new Map<string, UserFoodRow>();
  private catalog = new Map<number, CatalogRow>();
  private names = new Map<number, string>();
  private refByOwnFood = new Map<string, string>();
  private refByCatalog = new Map<number, string>();
  /** This account's own foods made from each catalog food a key names. */
  private ownByCatalog = new Map<number, string[]>();
  private keyed = new Set<number>();
  /** Favored foods by exact name, for a legacy (key-less) tick. */
  favoredByName = new Map<string, RowResolution & { kind: "resolved" }>();

  constructor(private client: SupabaseClient, private userId: string) {}

  private async addRefs(column: "id" | "user_food_id" | "catalog_food_id", ids: (string | number)[]) {
    for (const ref of await readByIdBatches(ids, (batch) => select<RefRow>(this.client.from("food_refs")
      .select("id,kind,catalog_food_id,user_food_id").in(column, batch)))) {
      this.refs.set(ref.id, ref);
      if (ref.kind === "user" && ref.user_food_id) this.refByOwnFood.set(ref.user_food_id, ref.id);
      if (ref.kind === "catalog" && ref.catalog_food_id !== null) this.refByCatalog.set(Number(ref.catalog_food_id), ref.id);
    }
  }

  private async addOwnFoods(column: "id" | "catalog_food_id", ids: (string | number)[]) {
    const rows = await readByIdBatches(ids, (batch) => select<UserFoodRow>(this.client.from("user_foods")
      .select("id,name,catalog_food_id").eq("user_id", this.userId).in(column, batch)));
    for (const food of rows) this.ownFoods.set(food.id, food);
    return rows;
  }

  /** Only well-formed ids are ever sent to the database. */
  async load(refIds: unknown[], ownFoodIds: unknown[], catalogIds: number[]): Promise<void> {
    const keyedCatalog = [...new Set(catalogIds)].filter((id) => !this.keyed.has(id));
    for (const id of keyedCatalog) this.keyed.add(id);
    await this.addRefs("id", [...new Set(refIds.filter(isRowId))].filter((id) => !this.refs.has(id)));
    for (const food of await this.addOwnFoods("catalog_food_id", keyedCatalog)) {
      if (food.catalog_food_id === null) continue;
      const id = Number(food.catalog_food_id);
      this.ownByCatalog.set(id, [...(this.ownByCatalog.get(id) ?? []), food.id]);
    }
    const wanted = [...ownFoodIds.filter(isRowId), ...[...this.refs.values()].flatMap((ref) => ref.user_food_id ?? [])];
    await this.addOwnFoods("id", [...new Set(wanted)].filter((id) => !this.ownFoods.has(id)));
    await this.addRefs("user_food_id", [...this.ownFoods.keys()].filter((id) => !this.refByOwnFood.has(id)));
    const catalog = [...new Set([...keyedCatalog, ...[...this.refs.values()].flatMap((ref) => ref.catalog_food_id ?? []),
      ...[...this.ownFoods.values()].flatMap((food) => food.catalog_food_id ?? [])].map(Number))];
    await this.addRefs("catalog_food_id", catalog.filter((id) => !this.refByCatalog.has(id)));
    const unread = catalog.filter((id) => !this.catalog.has(id));
    for (const row of await readByIdBatches(unread, (batch) => select<CatalogRow>(this.client.from("catalog_foods")
      .select("id,source,source_id").in("id", batch)))) this.catalog.set(Number(row.id), row);
    for (const row of await readByIdBatches(unread, (batch) => select<RevisionRow>(this.client
      .from("catalog_food_revisions").select("catalog_food_id,description").in("catalog_food_id", batch)
      .eq("is_active", true)))) this.names.set(Number(row.catalog_food_id), row.description);
  }

  /** A catalog food: needs its catalog row and its catalog ref. */
  private catalogFood(id: number, ownName?: string): RowResolution {
    const row = this.catalog.get(id);
    const ref = this.refByCatalog.get(id);
    if (!row || !ref) return UNREADABLE;
    const name = ownName ?? this.names.get(id) ?? null;
    const srCode = row.source === "fdc_sr_legacy" && /^\d+$/.test(row.source_id) ? Number(row.source_id) : null;
    const identity = identityOf({ srCode, name }) ?? identityOf({ name: this.names.get(id) });
    return identity ? { kind: "resolved", identity, refIds: [ref], mixed: row.source === "fdc_fndds",
      catalogId: id, name } : UNREADABLE;
  }

  /** An account food of THIS account: its own ref, and its catalog food's when made from one. */
  ownFood(id: unknown): RowResolution {
    const food = isRowId(id) ? this.ownFoods.get(id) : undefined;
    const ref = food ? this.refByOwnFood.get(food.id) : undefined;
    if (!food || !ref) return UNREADABLE;
    if (food.catalog_food_id === null) {
      const identity = identityOf({ name: food.name });
      return identity ? { kind: "resolved", identity, refIds: [ref], mixed: false, catalogId: null,
        name: food.name } : UNREADABLE;
    }
    const via = this.catalogFood(Number(food.catalog_food_id), food.name);
    return via.kind === "resolved" ? { ...via, refIds: [ref, ...via.refIds], name: food.name } : UNREADABLE;
  }

  /** A `catalog:` key: the catalog food, judged with every account food made from it. */
  catalogKey(id: number): RowResolution {
    const hit = this.catalogFood(id);
    if (hit.kind !== "resolved") return UNREADABLE;
    const made = (this.ownByCatalog.get(id) ?? []).map((food) => this.refByOwnFood.get(food));
    if (made.some((ref) => ref === undefined)) return UNREADABLE;
    return { ...hit, refIds: [...new Set([...hit.refIds, ...(made as string[])])] };
  }

  /** A food ref: it must exist and its target row must exist (an account food: this account's). */
  ref(id: unknown): RowResolution {
    const ref = isRowId(id) ? this.refs.get(id) : undefined;
    if (!ref) return UNREADABLE;
    if (ref.kind === "user") return ref.user_food_id ? this.ownFood(ref.user_food_id) : UNREADABLE;
    if (ref.kind === "catalog" && ref.catalog_food_id !== null) {
      const hit = this.catalogFood(Number(ref.catalog_food_id));
      return hit.kind === "resolved" && hit.refIds[0] === ref.id ? hit : UNREADABLE;
    }
    return UNREADABLE;
  }

  /** The catalog food a `catalog:` key or a mixed-dish input names. */
  catalogId(id: unknown): RowResolution {
    return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? this.catalogKey(id) : UNREADABLE;
  }
}

/** A bundled food id, validated: a universe item, else its own bundled row's identity. */
function bundled(id: unknown): RowResolution {
  if (typeof id !== "string") return UNREADABLE;
  const row = dbFood(id);
  const identity = universeById(id) ?? (row ? identityOf({ foodDbId: id, name: row.name }) : null);
  return identity ? { kind: "ref_free", identity, refIds: [], name: row?.name ?? null } : UNREADABLE;
}

function byName(name: unknown): RowResolution {
  const identity = typeof name === "string" ? identityOf({ name }) : null;
  return identity ? { kind: "ref_free", identity, refIds: [], name: name as string } : UNREADABLE;
}

/** The raw source row, exactly as stored. */
export type RawRow =
  | { source: "log"; row: { food_ref_id?: unknown } }
  /** A recipe line, a shopping line's identity (with the line's name) or a mixed-dish input. */
  | { source: "recipe" | "shopping" | "mixed_input"; row: Record<string, unknown> }
  | { source: "tick"; row: Record<string, unknown> };

/**
 * The one resolution boundary. Nullable `foodRefId` / `foodDbId` / `catalogFoodId` set to null
 * means absent; any other value present is authoritative and must resolve.
 */
export function resolveRowIdentity(raw: RawRow, resolver: Resolver): RowResolution {
  if (raw.source === "log") return resolver.ref(raw.row.food_ref_id);
  const row = raw.row;
  const present = (field: string) => own(row, field) && row[field] !== null && row[field] !== undefined;
  if (raw.source === "tick") {
    if (row.foodKeyInvalid === true) return UNREADABLE;
    // Any foodKey field at all, null included, is a supplied key (the phone schema marks the same
    // value foodKeyInvalid); only a tick with no foodKey field is a legacy, name-matched tick.
    if (own(row, "foodKey")) {
      const key = parseFoodKey(row.foodKey);
      if (!key) return UNREADABLE;
      if (key.kind === "catalog") return resolver.catalogKey(key.catalogFoodId);
      return isRowId(key.id) ? resolver.ownFood(key.id) : bundled(key.id);
    }
    // Legacy tick (no key at all): a Favored food by exact name, else the name.
    const favored = typeof row.name === "string" ? resolver.favoredByName.get(exactName(row.name)) : undefined;
    return favored ?? byName(row.name);
  }
  if (present("foodRefId")) return resolver.ref(row.foodRefId);
  if (present("catalogFoodId")) return resolver.catalogId(row.catalogFoodId);
  if (present("foodDbId")) return bundled(row.foodDbId);
  return raw.source === "mixed_input" ? UNREADABLE : byName(row.name);
}
