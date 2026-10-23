/**
 * The account's eaten history and choice events for the taste profile (Phase 18 D5, slice W3),
 * reduced to identities for lib/meals/taste.ts. Nothing is written anywhere.
 *
 * Tenancy (Phase 17 D3): every read runs on the caller's own client (RLS) with an explicit
 * `user_id` filter on every account-owned table, live rows only, over the 180-day window. Every
 * date-keyed read goes through `readByDateChunks` and every id-keyed read through
 * `readByIdBatches` (lib/server/date-chunks.ts), so the API's row cap can never drop a row.
 * `food_refs`, `catalog_foods` and `catalog_food_revisions` carry no owner (shared catalog rows);
 * they are read only by ids this account's own rows name. A user food is read with the explicit
 * owner filter, so another account's food never names an identity.
 *
 * Sources (D5): live `log_items` (≥ 10 g, or an unknown mass); a consumed accepted recipe through
 * its slot's selection and `ingredient_snapshot` (lines of ≥ 10 g as eaten); ticked generated or
 * user-set slots through `item_overrides` (by `foodKey`, else, only with no key at all, by name); a
 * mixed dish (an FNDDS catalog food) through its W4 inputs (`mixedDishInputs`, at half weight,
 * estimated), else as itself; and never-edited manual shopping lines as choice events.
 *
 * Every row passes `resolveRowIdentity` (lib/server/taste-resolve.ts) before it is vouched for or
 * pushed: a supplied ref or key is authoritative, and an unreadable row contributes nothing.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { accountUnitGrams } from "@/lib/foods/unit-grams";
import type { Food } from "@/lib/foods";
import {
  mixedDishItems, tasteWindowStart, type ChoiceEvent, type EatenItem,
} from "@/lib/meals/taste";
import { exactName } from "@/lib/meals/taste-identity";
import { parseFoodKey } from "@/lib/meals/food-key";
import { Resolver, resolveRowIdentity, type RowResolution } from "@/lib/server/taste-resolve";
import { readByDateChunks, readByIdBatches } from "@/lib/server/date-chunks";
import { fetchAllRows } from "@/lib/server/paged-read";
import {
  ACCOUNT_DAY_LAST_RESORT_ZONE, addIsoDays, isoDateIn, readAccountZone,
} from "@/lib/server/account-day";
import { isIanaTimeZone } from "@/lib/health/contract";

type Row = Record<string, unknown>;

/**
 * A mixed dish's FNDDS inputs (W4), as RAW identifiers: `foodRefId`, `catalogFoodId` or `foodDbId`,
 * and grams per gram of dish. Each is resolved through the same boundary as every other row. A dish
 * absent from the map has no input data (it counts as itself); an unreadable input adds nothing.
 */
export type MixedDishInput = Record<string, unknown> & { gramsPerGram: number };
/** Read on the caller's own client (lib/server/mixed-dish-inputs.ts is the catalog port). */
export type MixedDishInputs = (catalogFoodIds: number[], client: SupabaseClient) => Promise<Map<number, MixedDishInput[]>>;
export const NO_MIXED_DISH_INPUTS: MixedDishInputs = async () => new Map();

/** What can vouch for an identity in the policy check: its refs, its universe id, its names. */
export type IdentityReps = {
  /** Refs the history's resolved rows name for this identity. */
  refIds: Set<string>;
  /** Favored refs of the same identity: they vouch only when the history names no ref. */
  favoredRefIds: Set<string>;
  universeId: string | null;
  names: Set<string>;
};

/**
 * How the row resolved (taste-resolve.ts) and every ref it must be judged on. `dishRefIds` and
 * `gates`: a mixed dish's input also needs the dish's refs allowed and the dish's family admitted.
 */
export type Vouched = { resolution: "resolved" | "ref_free"; refIds: string[]; dishRefIds?: string[];
  gates?: string[] };
export type HistoryItem = EatenItem & Vouched;
export type HistoryChoice = ChoiceEvent & Vouched;

export type TasteHistory = {
  items: HistoryItem[];
  choices: HistoryChoice[];
  reps: Map<string, IdentityReps>;
  /** Identity keys an Eats (Favored) mark names. */
  favored: Set<string>;
};

const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string"
    && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
const record = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value)
  ? value as Row : {});

async function select<T>(query: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const { data, error } = await query;
  if (error) throw error instanceof Error ? error : new Error(String((error as { message?: unknown }).message));
  return (data ?? []) as T[];
}

type Component = { name?: unknown; qty?: unknown; unit?: unknown; foodKey?: unknown };

/** Grams in a stored component: its own grams, else qty × the unit's known weight, else unknown. */
function componentGrams(component: Component): number | null {
  const qty = num(component.qty);
  const name = str(component.name);
  if (qty === null || !name) return null;
  if (component.unit === "g") return qty;
  const unit = accountUnitGrams({ name, unit: component.unit as Food["unit"] });
  return unit === null ? null : qty * unit;
}

/** The whole history read for one account, over the window ending on `today`. */
export async function readTasteHistory(
  client: SupabaseClient, userId: string, today: string,
  mixedDishInputs: MixedDishInputs = NO_MIXED_DISH_INPUTS,
): Promise<TasteHistory> {
  const start = tasteWindowStart(today);
  const owned = (table: string, columns: string) => client.from(table).select(columns).eq("user_id", userId);
  // A manual line carries only an instant; it is dated by the account's stored zone (UTC as the last
  // resort), like every other row here, never by the instant's UTC date (audit A072).
  const zone = readAccountZone(client, userId);
  const [entries, days, selections, shoppingRows, favoredPrefs] = await Promise.all([
    readByDateChunks(start, today, (from, to) => select<{ id: string; local_date: string; slot: string }>(
      owned("log_entries", "id,local_date,slot").is("deleted_at", null)
        .gte("local_date", from).lte("local_date", to))),
    readByDateChunks(start, today, (from, to) => select<{ local_date: string; item_overrides: unknown;
      eaten_slots: unknown }>(owned("plan_days", "local_date,item_overrides,eaten_slots")
      .gte("local_date", from).lte("local_date", to))),
    readByDateChunks(start, today, (from, to) => select<{ local_date: string; slot_id: string;
      recipe_revision_id: string; serving_fraction: unknown; ingredient_snapshot: unknown }>(
      owned("recipe_plan_selections", "local_date,slot_id,recipe_revision_id,serving_fraction,ingredient_snapshot")
        .gte("local_date", from).lte("local_date", to))),
    // One UTC day wider on each side covers every zone's day; the local date filters it below.
    readByDateChunks(addIsoDays(start, -1), addIsoDays(today, 1), (from, to) => select<{ name: string; identity: unknown; updated_at: string;
      rev: unknown; period_id: string }>(owned("shopping_lines", "name,identity,updated_at,rev,period_id").eq("origin", "manual").is("deleted_at", null)
        .gte("updated_at", `${from}T00:00:00Z`).lte("updated_at", `${to}T23:59:59.999Z`))),
    fetchAllRows<{ food_ref_id: string }>((from, to) => client.from("user_food_prefs").select("food_ref_id")
      .eq("user_id", userId).eq("status", "eats").order("food_ref_id").range(from, to)),
  ]);
  // A deleted list soft-deletes the list, not its lines: a line counts only while its list is live,
  // read after the lines so a list deleted meanwhile is never counted.
  const liveLists = new Set((await readByIdBatches(shoppingRows.map((line) => line.period_id), (batch) =>
    select<{ id: string }>(owned("shopping_periods", "id").is("deleted_at", null).in("id", batch))))
    .map((row) => row.id));
  const shopping = shoppingRows.filter((line) => liveLists.has(line.period_id));
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  const logItems = await readByIdBatches(entries.map((entry) => entry.id), (batch) =>
    select<{ entry_id: string; food_ref_id: string; grams: unknown }>(client.from("log_items")
      .select("entry_id,food_ref_id,grams").in("entry_id", batch)));

  // Everything the rows name, resolved in one batched pass.
  const ticks: { date: string; slot: string; components: Component[] }[] = [];
  const recipes: { date: string; slot: string; qty: number; lines: Row[]; fraction: number }[] = [];
  const selectionAt = new Map(selections.map((row) => [`${row.local_date}\u0000${row.slot_id}`, row]));
  for (const day of days) {
    const overrides = record(day.item_overrides);
    for (const [slot, raw] of Object.entries(record(day.eaten_slots))) {
      const mark = record(raw);
      if (!str(mark.eaten_at)) continue;
      const consumed = record(mark.consumed);
      if (str(consumed.baseMealId)) {
        const selection = selectionAt.get(`${day.local_date}\u0000${slot}`);
        const qty = num(record((consumed.components as unknown[] | undefined)?.[0]).qty);
        const fraction = num(selection?.serving_fraction);
        if (selection && consumed.baseMealId === `recipe:${selection.recipe_revision_id}` && qty !== null
          && fraction !== null && fraction > 0 && Array.isArray(selection.ingredient_snapshot)) {
          recipes.push({ date: day.local_date, slot, qty, fraction, lines: selection.ingredient_snapshot.map(record) });
        }
        continue;
      }
      const override = record(overrides[slot]);
      if (override.cleared === true || override.removed === true || !Array.isArray(override.components)) continue;
      ticks.push({ date: day.local_date, slot, components: override.components.map((c) => record(c) as Component) });
    }
  }
  const keys = ticks.flatMap((tick) => tick.components.map((c) => parseFoodKey(c.foodKey))).filter((key) => key !== null);
  const lines = recipes.flatMap((recipe) => recipe.lines);
  const resolver = new Resolver(client, userId);
  await resolver.load([...logItems.map((item) => item.food_ref_id), ...favoredPrefs.map((pref) => pref.food_ref_id),
    ...[...lines, ...shopping.map((line) => record(line.identity))].map((row) => row.foodRefId)],
  keys.flatMap((key) => key.kind === "food" ? [key.id] : []),
  keys.flatMap((key) => key.kind === "catalog" ? [key.catalogFoodId] : []));

  const history: TasteHistory = { items: [], choices: [], reps: new Map(), favored: new Set() };
  /** Only a resolved or ref-free row ever reaches here (never an unreadable one). */
  const vouch = (hit: RowResolution & { kind: "resolved" | "ref_free" }, names: (string | null)[], favored = false) => {
    const reps = history.reps.get(hit.identity.key) ?? { refIds: new Set<string>(), favoredRefIds: new Set<string>(),
      universeId: null, names: new Set<string>() };
    for (const refId of hit.refIds) (favored ? reps.favoredRefIds : reps.refIds).add(refId);
    if (hit.identity.match === "universe") reps.universeId = hit.identity.key.slice(2);
    for (const name of [...names, hit.name]) if (name) reps.names.add(name);
    history.reps.set(hit.identity.key, reps);
  };
  const vouched = (hit: RowResolution & { kind: "resolved" | "ref_free" }): Vouched =>
    ({ resolution: hit.kind, refIds: [...hit.refIds] });
  for (const pref of favoredPrefs) {
    const hit = resolveRowIdentity({ source: "log", row: pref }, resolver);
    if (hit.kind !== "resolved") continue;
    history.favored.add(hit.identity.key);
    vouch(hit, [], true);
    if (hit.name && !resolver.favoredByName.has(exactName(hit.name))) resolver.favoredByName.set(exactName(hit.name), hit);
  }

  const dishes: { item: Omit<EatenItem, "source" | "estimated">; catalogId: number | null; hit: Vouched }[] = [];
  for (const row of logItems) {
    const entry = entryById.get(row.entry_id);
    const hit = resolveRowIdentity({ source: "log", row }, resolver);
    if (!entry || hit.kind === "unreadable") continue;
    vouch(hit, []);
    const item = { localDate: entry.local_date, slot: entry.slot, identity: hit.identity, grams: num(row.grams) };
    if (hit.kind === "resolved" && hit.mixed) dishes.push({ item, catalogId: hit.catalogId, hit: vouched(hit) });
    else history.items.push({ ...item, source: "log", ...vouched(hit) });
  }
  for (const recipe of recipes) {
    for (const line of recipe.lines) {
      const grams = num(line.grams);
      const hit = resolveRowIdentity({ source: "recipe", row: line }, resolver);
      if (hit.kind === "unreadable" || grams === null) continue;
      vouch(hit, [str(line.name)]);
      history.items.push({ localDate: recipe.date, slot: recipe.slot, source: "recipe", identity: hit.identity,
        grams: grams * recipe.qty / recipe.fraction, ...vouched(hit) });
    }
  }
  for (const tick of ticks) {
    for (const component of tick.components) {
      const hit = resolveRowIdentity({ source: "tick", row: component as Row }, resolver);
      if (hit.kind === "unreadable") continue;
      vouch(hit, [str(component.name)]);
      history.items.push({ localDate: tick.date, slot: tick.slot, source: "tick", identity: hit.identity,
        grams: componentGrams(component), ...vouched(hit) });
    }
  }
  const inputs = await mixedDishInputs([...new Set(dishes.flatMap((dish) => dish.catalogId ?? []))], client);
  const rawInputs = [...inputs.values()].flat();
  await resolver.load(rawInputs.map((input) => input.foodRefId), [],
    rawInputs.flatMap((input) => typeof input.catalogFoodId === "number" ? [input.catalogFoodId] : []));
  for (const dish of dishes) {
    const supplied = dish.catalogId === null ? undefined : inputs.get(dish.catalogId);
    const gate = { dishRefIds: dish.hit.refIds, gates: [dish.item.identity.key] };
    if (!supplied) {
      // W4 has no input data for this dish: it counts as itself.
      history.items.push(...mixedDishItems(dish.item, undefined).map((item) => ({ ...item, ...dish.hit, ...gate })));
      continue;
    }
    for (const input of supplied) {
      const hit = resolveRowIdentity({ source: "mixed_input", row: input }, resolver);
      // An unreadable input adds nothing, and never falls back to the dish or a name.
      if (hit.kind === "unreadable" || !(Number.isFinite(input.gramsPerGram) && input.gramsPerGram > 0)) continue;
      vouch(hit, []);
      for (const item of mixedDishItems(dish.item, [{ identity: hit.identity, gramsPerGram: input.gramsPerGram }])) {
        history.items.push({ ...item, ...vouched(hit), ...gate });
      }
    }
  }
  const stored = await zone;
  const lineZone = isIanaTimeZone(stored) ? stored : ACCOUNT_DAY_LAST_RESORT_ZONE;
  for (const line of shopping) {
    // A choice is dated by its creation. A line never edited (rev 1) still has its creation time in
    // `updated_at`; an edited one has no stored creation time (shopping_lines has no created_at),
    // so it is not counted rather than revived by the edit (W3 r1).
    const at = Date.parse(str(line.updated_at) ?? "");
    const date = Number.isFinite(at) ? isoDateIn(lineZone, new Date(at)) : null;
    if (num(line.rev) !== 1 || !date || date < start || date > today) continue;
    const hit = resolveRowIdentity({ source: "shopping", row: { ...record(line.identity), name: line.name } }, resolver);
    if (hit.kind === "unreadable") continue;
    vouch(hit, [line.name]);
    history.choices.push({ localDate: date, kind: "shopping_manual", identity: hit.identity, ...vouched(hit) });
  }
  return history;
}
