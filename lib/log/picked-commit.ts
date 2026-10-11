/**
 * Every food the Log sheet can pick reaches the server (calc audit #15, BLOCK).
 *
 * A catalog pick always committed. A bundled food-db pick and an account food did not: they went
 * through a local-only `onAdd`, and a mixed meal committed only its catalog items. So the phone's
 * rings counted them while the server's day totals, the export, the coach and the expenditure
 * engine's intake never saw them.
 *
 * This module gives every pick a `food_refs` row and sends the whole entry down the one durable
 * path (`commitLogEntry`: local-first card, mirror, pending mark, outbox, reconcile):
 *
 * - catalog: the ref the sheet already resolved, the revision it is showing — unchanged.
 * - bundled: adopted as this account's `user_foods` row for that food AND those numbers
 *   (`bundledFoodUserId(id, userId)`, the same row a recipe ingredient adopts).
 * - account: adopted the same way from the food's per-unit numbers and its known unit weight. A
 *   food with NO known unit weight (t17 gap 1, migration 20261211090000) is sent as a count of its
 *   own units with `grams: null` — the mass unknown, never guessed — and its per-unit numbers as
 *   `per_unit`, which the server multiplies by qty (or `{}` when it has none).
 *
 * Every adopted id carries the account and the numbers: a food whose numbers change mints a new
 * row, and the row an earlier entry was computed from is never rewritten. Entry and item ids are
 * derived from the account and the picks, so the same picks give the same entry, the same items
 * and the same op id (`opIdFor(entry_id)`), and a retry collapses onto the first attempt. Refs are
 * cached per account, so a food logged once can be logged again offline.
 *
 * Statuses other than `ready`/`sent` send NOTHING and write nothing (`no_ref`, `unknown_weight`,
 * `invalid_qty`). A `no_ref` whose `reason` is `unresolved` (signed in, but a ref could not be
 * minted or resolved: a first use offline, or one non-ready pick in a mixed meal) is not a local
 * log: `lib/log/picked-deferred.ts` keeps the WHOLE entry as a pending commit and upgrades it to
 * real refs once the phone is back online. The other statuses keep today's local card, marked with
 * `localOnlyCard` so Undo owes the server nothing. `sheetPreview` is the pure answer to "what will
 * this pick store", for the sheet to show before it commits.
 */
import {
  currentAccountOrNull, rethrowAccountChanged, type AccountHandle,
} from "@/lib/device/account";
import type { CachedRevision } from "@/lib/db/catalog-cache";
import { dbFood } from "@/lib/food-db";
import { foodKcalPerUnit, type Food } from "@/lib/foods";
import {
  adoptUserFood, bundledFoodUserId, numbersKey, per100gFromBundled, type AdoptableFood,
} from "@/lib/foods/adopt-client";
import { accountUnitGrams } from "@/lib/foods/unit-grams";
import { uuidV5 } from "@/lib/foods/uuid5";
import {
  buildCommitRequest, cachedFoodRef, rememberFoodRef, resolveFoodRef,
} from "@/lib/log-client";
import { commitLogEntry, type CommitResult } from "@/lib/log-commit-client";
import { localDateFor, type LogCommitRequest } from "@/lib/log/contract";
import { mealCard } from "@/lib/log/meal-card";
import { MACRO_CODES, NUTRIENT_UNITS, type NutrientCode } from "@/lib/nutrients/codes";
import { computeSnapshot, computeUnitSnapshot } from "@/lib/nutrients/snapshot";
import type { TimingPath, TimingRun } from "@/lib/timing";
import type { LoggedFood, LoggedItem, Macros, SlotId } from "@/lib/types";

/** Fixed namespace for every id this module derives. */
const PICKED_NAMESPACE = "a3c1e0f2-5b7d-4c9e-8f10-2d3e4f5a6b7c";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Per100g = Partial<Record<NutrientCode, number>>;

/** One picked food, as the sheet holds it. `card` is the line the sheet built for it. */
export type LogPick =
  | {
    /**
     * `foodRefId` null: the catalog row has no committed food ref on this phone yet (a first pick
     * offline). It is resolved from `revision.catalog_food_id` through the ref registry before the
     * commit, or the entry waits as a pending commit until it can be.
     */
    source: "catalog"; card: LoggedFood; itemId: string; foodRefId: string | null;
    revision: CachedRevision; grams: number; qty: number; unit: string; portionId: number | null;
  }
  /** `card.foodId` is the bundled food-db id; `card.grams` the portion's real grams. */
  | { source: "bundled"; card: LoggedFood }
  /** `card.qty` is the number of the food's own units; grams and macros are rebuilt from `food`. */
  | { source: "account"; card: LoggedFood; food: Food };

/** Where a pick's ref comes from. Injected in tests; the default adopts through Supabase. */
export type RefMinter = (food: AdoptableFood, h: AccountHandle) => Promise<string | null>;

/** catalog_food_id → food ref. Injected in tests; the default is the registry's `resolveFoodRef`. */
export type CatalogRefResolver = (catalogFoodId: number, h: AccountHandle) => Promise<string | null>;

export type PickedCommitInput = {
  picks: LogPick[];
  slot: SlotId;
  /** Present for "Log a meal": one entry carrying every pick. Absent: exactly one pick. */
  meal?: { name: string; note: string };
  at?: Date;
  tz?: string;
  /** Override the derived entry id (an edit, or a caller that already owns one). */
  entryId?: string;
  /** The account to log as. Default: the bound one. `null`: signed out. */
  account?: AccountHandle | null;
  mint?: RefMinter;
  catalogRef?: CatalogRefResolver;
};

export type PreparedCommit = {
  status: "ready"; req: LogCommitRequest; entry: LoggedFood; date: string; account: AccountHandle;
};
/**
 * Nothing was sent or written. `picks` are the ones at fault. A `no_ref` says why: `signed_out`
 * keeps a local card; `unresolved` (signed in, a ref could not be had right now) is deferred whole
 * by `commitOrDeferPickedFoods` / `deferPickedCommit` (lib/log/picked-deferred.ts).
 */
export type NotSent =
  | { status: "no_ref"; picks: LogPick[]; reason?: "signed_out" | "unresolved" }
  | { status: "unknown_weight" | "invalid_qty"; picks: LogPick[] };

type WireItem = Parameters<typeof buildCommitRequest>[0]["items"][number];
/** One pick's line: its card, and its wire item once its ref is known (null while it is not). */
type Line = { itemId: string; unit: string; wire: WireItem | null; card: LoggedFood };
type Resolved = Line & { wire: WireItem };

const defaultMint: RefMinter = (food, h) => adoptUserFood(food, { account: h });
const defaultCatalogRef: CatalogRefResolver = (id, h) => resolveFoodRef(id, undefined, h);

/** A minter that asks no network: the registry's cached ref or nothing (the deferred card). */
export const registryOnly: { mint: RefMinter; catalogRef: CatalogRefResolver } = {
  mint: async () => null,
  catalogRef: async (id, h) => cachedFoodRef(`catalog:${id}`, h),
};

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/**
 * The unit weight of an account food, when one is known: the canonical resolver the Eats row, the
 * logger and the `user_foods.per_100g` writer share (starter weight first), so the stored grams and
 * the adopted per-100 g numbers match what the Foods page shows.
 */
export function unitGramsOf(food: Food): number | null {
  return accountUnitGrams(food);
}

/**
 * An account food's numbers per 100 g, from its per-unit numbers and its unit weight. Null when
 * the unit weight is unknown. A food whose nutrition is unknown stores nothing measured. Energy is
 * the food's measured energy when it has one (reported, else calculated), else 4/4/9 from its
 * macros (`foodKcalPerUnit`, W004 audit A156): a drink's alcohol energy is in no macro.
 */
export function accountPer100g(food: Food): { per100g: Per100g; unitGrams: number } | null {
  const unitGrams = unitGramsOf(food);
  if (unitGrams === null) return null;
  if (food.nutritionUnknown) return { per100g: {}, unitGrams };
  const k = 100 / unitGrams;
  return {
    unitGrams,
    per100g: {
      energy_kcal: round4(foodKcalPerUnit(food) * k),
      protein: round4(food.perUnit.protein * k),
      carbohydrate: round4(food.perUnit.carbs * k),
      fat_total: round4(food.perUnit.fat * k),
    },
  };
}

function localSnapshot(per100g: Per100g, grams: number): LoggedItem["snapshot"] {
  if (Object.keys(per100g).length === 0) return {};
  return computeSnapshot(per100g as Record<NutrientCode, number | null>, grams, {
    source: "user", source_version: "local", revision_id: null, units: NUTRIENT_UNITS,
  });
}

/**
 * The card's macros from the snapshot the server will store, so the phone and the server total
 * the same numbers. An unmeasured snapshot keeps the sheet's own macros (the type has no
 * "unknown"; `entryMacros` reads the snapshot first and these only when it is empty).
 */
function macrosOf(snapshot: LoggedItem["snapshot"], fallback: Macros): Macros {
  if (Object.keys(snapshot).length === 0) return fallback;
  const at = (code: NutrientCode): number => snapshot[code]?.amount ?? 0;
  return {
    kcal: Math.round(at(MACRO_CODES.kcal)),
    protein: round1(at(MACRO_CODES.protein)),
    carbs: round1(at(MACRO_CODES.carbs)),
    fat: round1(at(MACRO_CODES.fat)),
  };
}

async function mintedRef(
  food: AdoptableFood, h: AccountHandle, mint: RefMinter,
): Promise<string | null> {
  const key = `user-food:${food.id}`;
  const cached = cachedFoodRef(key, h);
  if (cached) return cached;
  const ref = await mint(food, h);
  if (ref) rememberFoodRef(key, ref, h);
  return ref;
}

/** One adopted line: the ref, a snapshot the server will agree with, a card built from it. */
async function adoptedLine(args: {
  food: AdoptableFood; card: LoggedFood; itemId: string; grams: number | null; qty: number;
  unit: string; foodId: string; h: AccountHandle; mint: RefMinter; perUnit?: Per100g;
}): Promise<Line> {
  const ref = await mintedRef(args.food, args.h, args.mint);
  const snapshot = plannedSnapshot(args);
  // The same snapshot and rounding `sheetPreview` shows (`storedMacros`).
  const macros = macrosOf(snapshot, args.card.macros);
  // An unknown mass (t17) never carries the sheet's stand-in grams: the card's known mass is
  // nothing, and `massUnknown` says so.
  const card: LoggedFood = args.grams === null
    ? { ...args.card, qty: args.qty, grams: 0, massUnknown: true, macros }
    : { ...args.card, qty: args.qty, grams: args.grams, macros };
  // No ref yet: the line still shows exactly what it will store, under a `local:` ref the wire
  // never carries, and the commit waits for the real one (lib/log/picked-deferred.ts).
  const item: LoggedItem = {
    id: args.itemId, seq: 1, food_ref_id: ref ?? `local:${args.foodId}`, grams: args.grams,
    qty: args.qty, unit: args.unit, snapshot, foodId: args.foodId, name: args.food.name,
    portionLabel: card.portionLabel, macros,
  };
  return {
    itemId: args.itemId, unit: args.unit,
    wire: ref ? { id: args.itemId, foodRefId: ref, revision: { revision_id: null },
      grams: args.grams, qty: args.qty, unit: args.unit,
      ...(args.grams === null && args.perUnit ? { perUnit: args.perUnit } : {}) } : null,
    card: { ...card, items: [item] },
  };
}

/**
 * The snapshot the server will store: per-100 g × grams, or for an unknown mass the account's own
 * per-unit numbers × qty (compute_unit_snapshot), or `{}` when it has none.
 */
function plannedSnapshot(plan: {
  food: { per100g: Per100g }; grams: number | null; qty: number; perUnit?: Per100g;
}): LoggedItem["snapshot"] {
  if (plan.grams !== null) return localSnapshot(plan.food.per100g, plan.grams);
  if (!plan.perUnit) return {};
  return computeUnitSnapshot(plan.perUnit, plan.qty, {
    source: "user", source_version: "per_unit", revision_id: null, units: NUTRIENT_UNITS,
  });
}

/**
 * An account food's own numbers for ONE of its units, when it has any (t17 gap 1): the facts the
 * user entered, needed exactly when the unit weight is unknown and per-100 g cannot be had.
 */
export function accountPerUnit(food: Food): Per100g | undefined {
  if (food.nutritionUnknown) return undefined;
  const { protein, carbs, fat } = food.perUnit;
  if (![protein, carbs, fat].every((n) => Number.isFinite(n) && n >= 0)) return undefined;
  return { energy_kcal: round4(foodKcalPerUnit(food)), protein: round4(protein),
    carbohydrate: round4(carbs), fat_total: round4(fat) };
}

/**
 * What an adopted (bundled or account) pick stores: the per-100 g numbers, the grams and the unit.
 * Null when it cannot be sent as is — an unknown bundled id or an account food with no unit weight.
 * Pure: the commit (`resolvePick`) and the sheet's preview (`sheetPreview`) both read it, so the
 * card shown is the card stored.
 */
function adoptedPlan(pick: Exclude<LogPick, { source: "catalog" }>): {
  per100g: Per100g; grams: number | null; unit: string; perUnit?: Per100g;
} | null {
  if (pick.source === "bundled") {
    const source = dbFood(pick.card.foodId);
    return source
      ? { per100g: per100gFromBundled(source), grams: pick.card.grams, unit: "portion" }
      : null;
  }
  const basis = accountPer100g(pick.food);
  // No known unit weight (t17 gap 1): a count of the food's own units, mass unknown, nutrients
  // from its per-unit numbers. Never the sheet's stand-in grams.
  if (!basis) {
    const perUnit = accountPerUnit(pick.food);
    return { per100g: {}, grams: null, unit: pick.food.unit, ...(perUnit ? { perUnit } : {}) };
  }
  // The sheet's portion carries real mass now that account portions use accountUnitGrams: a
  // "100 g" portion is qty 1 with 100 g, a "1 each" portion qty 1 with the unit weight. Use that
  // mass; the food's own unit names the line only when the mass is whole units of it.
  const unitMass = round4(basis.unitGrams * pick.card.qty);
  const cardMass = Number.isFinite(pick.card.grams) && pick.card.grams > 0 ? round4(pick.card.grams) : null;
  // The sheet rounds grams to 0.1 g: a card within that rounding of whole units is whole units,
  // stored at the exact unit mass (1 ml of whole milk is 1.03 g, not the card's 1.0).
  const inUnits = cardMass === null || Math.abs(cardMass - unitMass) <= WHOLE_UNIT_SNAP_G + 1e-9;
  return {
    per100g: basis.per100g,
    grams: inUnits ? unitMass : (cardMass as number),
    unit: inUnits ? pick.food.unit : "portion",
  };
}

/** A card within this many grams of whole units of an account food is stored as whole units. */
const WHOLE_UNIT_SNAP_G = 0.05;

/**
 * The grams, unit and macros the commit stores for a pick. With `massUnknown` (t17: a unit of a
 * food with no known unit weight), the commit stores grams null; `grams` is then 0, the known part,
 * the same compromise as `LoggedFood.massUnknown`, and must not be shown as the mass.
 */
export type PickPreview = { grams: number; unit: string; macros: Macros; massUnknown?: true };

/**
 * Exactly what `preparePickedCommit` will store for this pick — the request line's grams and unit
 * and the card's macros (the same 4-decimal per-100 g numbers, the same 0.05 g whole-unit snap,
 * the same exact-decimal snapshot and rounding). Pure: no account, no network. The Log sheet shows
 * these numbers instead of keeping its own copy of the rules.
 *
 * A pick that cannot be sent as is (an account food with no unit weight, an unknown bundled id, a
 * zero amount) previews as its own card — the local card the sheet keeps for it. A catalog pick
 * previews as the sheet resolved it: its grams and unit go on the wire unchanged, and the server
 * computes its snapshot from the revision.
 */
export function sheetPreview(pick: LogPick): PickPreview {
  if (pick.source === "catalog") {
    return { grams: pick.grams, unit: pick.unit, macros: pick.card.macros };
  }
  const plan = adoptedPlan(pick);
  if (plan && plan.grams === null && isPositive(pick.card.qty)) {
    return { grams: 0, massUnknown: true, unit: plan.unit, macros: macrosOf(plannedSnapshot({
      food: plan, grams: null, qty: pick.card.qty, perUnit: plan.perUnit }), pick.card.macros) };
  }
  if (!plan || plan.grams === null || !isPositive(plan.grams)) {
    return { grams: pick.card.grams, unit: pick.source === "account" ? pick.food.unit : "portion",
      macros: pick.card.macros };
  }
  return { grams: plan.grams, unit: plan.unit,
    macros: macrosOf(localSnapshot(plan.per100g, plan.grams), pick.card.macros) };
}

/**
 * The card to keep on this phone for a pick (or meal) the commit did not send — any `NotSent`
 * status. It carries `localOnly: true`, no revision, and every line under a `local:` ref, so Undo
 * (lib/log/delete-entry.ts) knows nothing was ever sent, even for a catalog food whose `foodId`
 * keeps its `catalog:` id.
 */
export function localOnlyCard(card: LoggedFood): LoggedFood {
  const { rev: _rev, ...rest } = card;
  void _rev;
  return {
    ...rest, localOnly: true,
    ...(card.items ? { items: card.items.map((item) => item.food_ref_id.startsWith("local:") ? item
      : { ...item, food_ref_id: `local:${item.foodId}` }) } : {}),
  };
}

function isPositive(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

/** What is wrong with a pick before any network: nothing, a bad amount, or no unit weight. */
function precheck(pick: LogPick): "invalid_qty" | "unknown_weight" | null {
  if (pick.source === "catalog") {
    return isPositive(pick.grams) && isPositive(pick.qty) ? null : "invalid_qty";
  }
  if (!isPositive(pick.card.qty)) return "invalid_qty";
  if (pick.source === "bundled") {
    if (!isPositive(pick.card.grams)) return "invalid_qty";
    // A bundled id this build does not know has no numbers and no weight to send.
    return dbFood(pick.card.foodId) ? null : "unknown_weight";
  }
  // An unknown unit weight is no longer a reason to keep it local (t17 gap 1): it is sent as a
  // count with its mass unknown.
  return null;
}

/** A catalog pick's ref: the one the sheet resolved, else the registry's for its catalog food. */
async function catalogRefOf(
  pick: Extract<LogPick, { source: "catalog" }>, h: AccountHandle, resolve: CatalogRefResolver,
): Promise<string | null> {
  if (pick.foodRefId) return pick.foodRefId;
  const id = pick.revision.catalog_food_id;
  return typeof id === "number" && Number.isInteger(id) ? resolve(id, h) : null;
}

function catalogLine(pick: Extract<LogPick, { source: "catalog" }>, ref: string | null): Line {
  // The card's own lines follow the ref: the resolved one once known, a `local:` one until then.
  const items = pick.card.items?.map((item) => ({ ...item,
    food_ref_id: ref ?? `local:${pick.card.foodId}` }));
  return {
    itemId: pick.itemId, unit: pick.unit,
    wire: ref ? { id: pick.itemId, foodRefId: ref, revision: pick.revision, grams: pick.grams,
      qty: pick.qty, unit: pick.unit, portionId: pick.portionId } : null,
    card: pick.foodRefId !== null && ref === pick.foodRefId ? pick.card : { ...pick.card, ...(items ? { items } : {}) },
  };
}

/** One pick's line. Null only for a pick that cannot be described at all (an unknown bundled id). */
async function resolvePick(
  pick: LogPick, entryId: string, h: AccountHandle, mint: RefMinter, catalogRef: CatalogRefResolver,
): Promise<Line | null> {
  if (pick.source === "catalog") {
    try {
      return catalogLine(pick, await catalogRefOf(pick, h, catalogRef));
    } catch (e) {
      rethrowAccountChanged(e);
      return catalogLine(pick, null);
    }
  }
  const itemId = await uuidV5(PICKED_NAMESPACE, `log-item:${h.userId}:${entryId}:${pick.card.id}`);
  const plan = adoptedPlan(pick);
  if (!plan) return null; // an unknown bundled id; precheck already answered unknown_weight
  let food: AdoptableFood;
  let foodId: string;
  if (pick.source === "bundled") {
    const source = dbFood(pick.card.foodId);
    if (!source) return null;
    food = { id: await bundledFoodUserId(source.id, h.userId), name: source.name,
      per100g: plan.per100g };
    foodId = source.id;
  } else {
    const basis = accountPer100g(pick.food);
    // The numbers are in the id: an edited food mints a new row and never rewrites the one an
    // earlier entry was logged against. A food with no unit weight has no per-100 g numbers at
    // all; its row holds none, and its per-unit numbers ride on the item (t17).
    food = { id: await uuidV5(PICKED_NAMESPACE, basis
      ? `log-food:${h.userId}:${pick.food.id}:${pick.food.unit}:${basis.unitGrams}:${
        numbersKey(basis.per100g)}`
      : `log-food-unit:${h.userId}:${pick.food.id}:${pick.food.unit}`),
    name: pick.food.name, per100g: plan.per100g };
    foodId = pick.food.id;
  }
  const line = { food, card: pick.card, itemId, grams: plan.grams, qty: pick.card.qty,
    unit: plan.unit, foodId, h, ...(plan.perUnit ? { perUnit: plan.perUnit } : {}) };
  try {
    return await adoptedLine({ ...line, mint });
  } catch (e) {
    rethrowAccountChanged(e);
    // The mint threw (offline, refused): the line waits for its ref like any other unresolved one.
    return adoptedLine({ ...line, mint: registryOnly.mint });
  }
}

/** Same account and picks, same ids: the entry, and each item that does not already carry one. */
async function entryIdFor(input: PickedCommitInput, h: AccountHandle): Promise<string> {
  if (input.entryId) return input.entryId;
  const only = input.picks.length === 1 && !input.meal ? input.picks[0].card.id : null;
  if (only && UUID.test(only)) return only;
  const kind = input.meal ? "log-meal" : "log-entry";
  return uuidV5(PICKED_NAMESPACE,
    `${kind}:${h.userId}:${input.picks.map((p) => p.card.id).join("|")}`);
}

/** The entry card for these lines: a meal card for "Log a meal", else the one pick's card. */
function entryCard(
  input: PickedCommitInput, entryId: string, at: Date, lines: Line[],
): LoggedFood {
  return input.meal
    ? mealCard({
      entryId, at, items: lines.map((l) => l.card),
      catalogItems: lines.map((l) => ({ entryId: l.card.id, itemId: l.itemId, unit: l.unit })),
      name: input.meal.name, note: input.meal.note,
    })
    : { ...lines[0].card, id: entryId, at: at.toISOString() };
}

/** The checks every path shares before a ref is asked for: the shape, the amounts, the weights. */
function precheckAll(input: PickedCommitInput): NotSent | null {
  if (!input.meal && input.picks.length !== 1) {
    throw new Error("preparePickedCommit: a single log takes exactly one pick; use `meal`");
  }
  if (input.picks.length === 0) return { status: "invalid_qty", picks: [] };
  for (const status of ["invalid_qty", "unknown_weight"] as const) {
    const bad = input.picks.filter((p) => precheck(p) === status);
    if (bad.length > 0) return { status, picks: bad };
  }
  return null;
}

/**
 * Every pick's line, as far as `mint`/`catalogRef` can resolve it. Null when a pick cannot be
 * described at all. Shared by the commit and by the deferred card, so the two are the same card.
 */
export async function resolvePickLines(
  input: PickedCommitInput, h: AccountHandle,
): Promise<{ entryId: string; lines: Line[] } | null> {
  const mint = input.mint ?? defaultMint;
  const catalogRef = input.catalogRef ?? defaultCatalogRef;
  const entryId = await entryIdFor(input, h);
  const lines = await Promise.all(
    input.picks.map((p) => resolvePick(p, entryId, h, mint, catalogRef)));
  return lines.some((l) => l === null) ? null : { entryId, lines: lines as Line[] };
}

/**
 * The card a deferred entry shows NOW (lib/log/picked-deferred.ts): every pick's line with the refs
 * this phone already holds, the rest under `local:` refs, and no network asked. Null when the picks
 * cannot be logged at all (a precheck failure) — the caller keeps the plain local card then.
 */
export async function provisionalPickedEntry(
  input: PickedCommitInput, h: AccountHandle,
): Promise<{ entryId: string; entry: LoggedFood; date: string } | null> {
  if (precheckAll(input) !== null) return null;
  const resolved = await resolvePickLines({ ...input, ...registryOnly }, h);
  if (!resolved) return null;
  const at = input.at ?? new Date();
  const tz = input.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const date = localDateFor(at.toISOString(), tz);
  if (date === null) return null;
  return { entryId: resolved.entryId, entry: entryCard(input, resolved.entryId, at, resolved.lines),
    date };
}

/**
 * Resolve every pick's ref and build the one request and the one card for it. Nothing is sent:
 * the sheet hands `req` and `entry` to `commitLogEntry` exactly as it does a catalog pick.
 */
export async function preparePickedCommit(
  input: PickedCommitInput,
): Promise<PreparedCommit | NotSent> {
  const bad = precheckAll(input);
  if (bad) return bad;
  const h = input.account === undefined ? currentAccountOrNull() : input.account;
  if (h === null) return { status: "no_ref", picks: input.picks, reason: "signed_out" };
  const at = input.at ?? new Date();
  const tz = input.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const resolved = await resolvePickLines(input, h);
  // Unreachable after the precheck (every pick it passes can be described); kept local if not.
  if (!resolved) return { status: "no_ref", picks: input.picks };
  const { entryId, lines } = resolved;
  const unresolved = input.picks.filter((_, i) => lines[i].wire === null);
  if (unresolved.length > 0) return { status: "no_ref", picks: unresolved, reason: "unresolved" };
  const built = buildCommitRequest({
    entryId, eatenAt: at, tz, slot: input.slot,
    ...(input.meal ? { title: input.meal.name.trim() || undefined, note: input.meal.note } : {}),
    items: (lines as Resolved[]).map((l) => l.wire),
  });
  // The date in `tz`, which is what the server validates and files it under — not the device's
  // own zone, which `buildCommitRequest` reads.
  const req: LogCommitRequest = {
    ...built, local_date: localDateFor(built.eaten_at, tz) ?? built.local_date,
  };
  return { status: "ready", req, entry: entryCard(input, entryId, at, lines), date: req.local_date,
    account: h };
}

export type PickedCommit =
  | { status: "sent"; date: string; entry: LoggedFood; result: CommitResult }
  | NotSent;

/**
 * Commit any picked food — catalog, bundled or account — or a mixed meal of them, through the
 * durable commit path, as the account the refs were minted for. `result` is `commitLogEntry`'s own
 * answer (`ok`, `queued`, a refusal, …).
 */
export async function commitPickedFoods(
  input: PickedCommitInput & { timingPath?: TimingPath; run?: TimingRun; fetchImpl?: typeof fetch },
): Promise<PickedCommit> {
  const prepared = await preparePickedCommit(input);
  if (prepared.status !== "ready") return prepared;
  const result = await commitLogEntry(prepared.req, {
    optimistic: { date: prepared.date, entry: prepared.entry },
    timingPath: input.timingPath, run: input.run, fetchImpl: input.fetchImpl,
    account: prepared.account,
  });
  return { status: "sent", date: prepared.date, entry: prepared.entry, result };
}
