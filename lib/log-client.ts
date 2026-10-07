/**
 * What a commit is made OF — contracts §4, phase-2-real-logging.md: the snapshot maths the sheet
 * shows, the request builder, and the food-ref registry the items point at. Sending one, and
 * settling it, live in lib/log-commit-client.ts.
 *
 * One rule holds this file together: the client and the server compute the SAME snapshot from the
 * SAME per-100 g values, and the server's copy wins on sync. So the sheet can show real numbers
 * with no signal, the outbox can carry the identical payload, and nothing diverges.
 */
import { browserClient } from "@/lib/supabase/client";
import { currentAccountOrNull, type AccountHandle } from "@/lib/device/account";
import { readAccountItem, writeAccountItem } from "@/lib/device/account-storage";
import { withAccount } from "@/lib/device/account-supabase";
import { MACRO_CODES, NUTRIENT_UNITS, type NutrientCode } from "@/lib/nutrients/codes";
import { itemKcal } from "@/lib/nutrients/energy";
import { computeSnapshot, type Snapshot } from "@/lib/nutrients/snapshot";
import { localDateFor, type LogCommitRequest, type LogItemInput } from "@/lib/log/contract";
import type { CachedRevision } from "@/lib/db/catalog-cache";
import type { SlotId } from "@/lib/types";

export type MacroStrip = { kcal: number; protein: number; carbs: number; fat: number; fiber: number };

export function snapshotFor(revision: CachedRevision, grams: number): Snapshot {
  return computeSnapshot(revision.per_100g as Record<NutrientCode, number | null>, grams, {
    source: revision.source,
    source_version: revision.version_label,
    revision_id: revision.revision_id,
    units: NUTRIENT_UNITS,
  });
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** The five numbers on the sheet's live strip. An unmeasured nutrient reads 0 here, not "—". */
export function liveStrip(revision: CachedRevision, grams: number): MacroStrip {
  const s = snapshotFor(revision, grams);
  const at = (code: NutrientCode): number => s[code]?.amount ?? 0;
  // One energy rule (lib/nutrients/energy.ts): reported, else calculated, else 0 on this strip.
  const kcal = itemKcal(s) ?? 0;
  return {
    kcal: Math.round(kcal),
    protein: round1(at(MACRO_CODES.protein)),
    carbs: round1(at(MACRO_CODES.carbs)),
    fat: round1(at(MACRO_CODES.fat)),
    fiber: round1(at(MACRO_CODES.fiber)),
  };
}

/** Local calendar date of an instant — the same UTC-midnight-avoiding shape lib/plan.ts uses. */
export function localDateOf(at: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`;
}

export function buildCommitRequest(args: {
  entryId: string; eatenAt: Date; tz: string; slot: SlotId | "snack"; note?: string;
  title?: string | null;
  baseRev?: number;
  method?: LogCommitRequest["method"];
  items: {
    /** `grams` null: unknown mass, a count of `unit`; `perUnit` its own numbers per one unit. */
    id: string; foodRefId: string; revision: { revision_id: number | null }; grams: number | null;
    qty: number; unit: string; portionId?: number | null; wasEdited?: boolean;
    confidence?: number; perUnit?: Record<string, number>;
  }[];
}): LogCommitRequest {
  // confidence is omitted (not sent as `undefined`) when the caller has none — the search path
  // must keep sending the exact same wire shape it always has.
  const items: LogItemInput[] = args.items.map((item, i) => ({
    id: item.id, seq: i + 1, food_ref_id: item.foodRefId,
    qty: item.qty, unit: item.unit, grams: item.grams,
    portion_id: item.portionId ?? null,
    food_revision_id: item.revision.revision_id,
    was_edited: item.wasEdited ?? false,
    ...(item.confidence !== undefined ? { confidence: item.confidence } : {}),
    // Only an unknown-mass item carries it, so every known-mass request keeps its exact shape.
    ...(item.grams === null && item.perUnit ? { per_unit: item.perUnit } : {}),
  }));
  const eatenAtIso = args.eatenAt.toISOString();
  // The day in `args.tz`, not the device's own zone (`localDateOf` reads the Date's local
  // getters): a commit built for an explicit zone that is ahead of the device's own — or built
  // on a server with no local zone at all — must file under the day that zone was on.
  const req: LogCommitRequest = {
    entry_id: args.entryId, eaten_at: eatenAtIso, tz: args.tz,
    local_date: localDateFor(eatenAtIso, args.tz) ?? localDateOf(args.eatenAt),
    slot: args.slot, method: args.method ?? "search", items,
  };
  if (args.baseRev !== undefined) req.base_rev = args.baseRev;
  if (args.title === null) req.title = null;
  else if (args.title?.trim()) req.title = args.title.trim().slice(0, 80);
  if (args.note?.trim()) req.note = args.note.trim();
  return req;
}

// ---------------------------------------------------------------- food refs

/** The account's own ref map (Phase 9 §0.4): `smc:u:<userId>:food-refs`. */
const REF_NAME = "food-refs";
const refCache = new Map<string, string>();

/** Phase 9 §0.3: ref ids are per account; drop the ones the last account minted. */
export function resetFoodRefCache(): void {
  refCache.clear();
}

function readRefs(h: AccountHandle): Record<string, string> {
  try { return JSON.parse(readAccountItem(h, REF_NAME) ?? "{}") as Record<string, string>; }
  catch { return {}; }
}

function writeRef(h: AccountHandle, key: string, id: string): void {
  // private browsing — the in-memory cache still holds for this session
  writeAccountItem(h, REF_NAME, JSON.stringify({ ...readRefs(h), [key]: id }));
}

/**
 * A ref this account already minted, by registry key (`catalog:<id>`, `user-food:<uuid>`), from
 * memory or localStorage — no network, so a food logged once can be logged again offline.
 */
export function cachedFoodRef(
  key: string, h: AccountHandle | null = currentAccountOrNull(),
): string | null {
  if (h === null) return null;
  const memo = refCache.get(key) ?? readRefs(h)[key];
  if (!memo) return null;
  refCache.set(key, memo);
  return memo;
}

/** Remember a minted ref under its registry key, for this session and (storage allowing) later. */
export function rememberFoodRef(
  key: string, id: string, h: AccountHandle | null = currentAccountOrNull(),
): void {
  if (h === null) return;
  refCache.set(key, id);
  writeRef(h, key, id);
}

/** Why resolveFoodRef came back null: no session, vs. a real RPC/network failure while signed in. */
export type FoodRefFailureReason = "signed_out" | "rpc_error";

/**
 * catalog_food_id → food_refs.id. The registry row is shared and permanent (architecture §3.2), so
 * once resolved it is cached in localStorage and works offline for every later log of that food.
 *
 * `onFailure`, when given, is told WHY a null came back — a missing session reads differently to
 * the caller than a signed-in RPC/network failure (audit finding 68), even though both still
 * resolve to `null` for callers that only care whether the resolve worked.
 */
export async function resolveFoodRef(
  catalogFoodId: number,
  onFailure?: (reason: FoodRefFailureReason) => void,
  h: AccountHandle | null = currentAccountOrNull(),
): Promise<string | null> {
  if (h === null) { onFailure?.("signed_out"); return null; }
  const key = `catalog:${catalogFoodId}`;
  const memo = refCache.get(key) ?? readRefs(h)[key];
  if (memo) { refCache.set(key, memo); return memo; }
  const supabase = browserClient();
  // The owner goes into the call (Phase 9 §0.5a), and an answer after a switch is dropped.
  const { data, error } = await withAccount(h, (owner) => supabase.rpc("get_or_create_food_ref", {
    p_user_id: owner, p_kind: "catalog", p_catalog_food_id: catalogFoodId, p_user_food_id: null,
  }));
  if (error || typeof data !== "string") { onFailure?.("rpc_error"); return null; }
  refCache.set(key, data);
  writeRef(h, key, data);
  return data;
}

// -------------------------------------------------------------- meal commit

/**
 * A meal of catalog foods as one server entry (contracts §4 — items[] holds 1-30). A meal that
 * mixes in bundled or account foods goes through `preparePickedCommit` (lib/log/picked-commit.ts),
 * which adopts a ref for each of them so every item reaches the server (calc audit #15).
 */
export function buildMealCommitRequest(args: {
  entryId: string; eatenAt: Date; tz: string; slot: SlotId;
  title?: string | null;
  items: {
    itemId: string; foodRefId: string; revision: CachedRevision; grams: number; qty: number;
    unit: string; portionId: number | null;
  }[];
}): LogCommitRequest {
  return buildCommitRequest({
    entryId: args.entryId, eatenAt: args.eatenAt, tz: args.tz, slot: args.slot,
    title: args.title,
    items: args.items.map((item) => ({
      id: item.itemId, foodRefId: item.foodRefId, revision: item.revision, grams: item.grams,
      qty: item.qty, unit: item.unit, portionId: item.portionId,
    })),
  });
}
