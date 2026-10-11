/**
 * Repair account foods that the old catalog add path stored with an unmeasured energy as 0
 * (W004, audit 2026-10-10 A154).
 *
 *   (no flag)                            read-only report, any project
 *   --user-id <uuid>                     limit to one account
 *   --fix                                repair on a branch or local database
 *   --fix --production                   repair on production: a deliberate, owner-approved step (W005)
 *
 * Until W004, `components/add-food/catalog-food.ts` wrote `energy_kcal: 0` (and 0 for any other
 * unmeasured macro) into `user_foods.per_100g` when the catalog revision had no reported energy —
 * an FDC Foundation food without a 1008 row, whose energy is only the Atwater `energy_kcal_calc`.
 * Every reader takes a stored 0 as a measured zero, so the coach, plan lines and new logs counted
 * the food as 0 kcal. A row is repaired when it is a catalog-linked custom food (`kind = 'custom'`,
 * `catalog_food_id` set, not deleted) whose stored `energy_kcal` is 0 while its catalog food's
 * active revision has a usable energy above 0 (reported, else calculated). Its `per_100g` becomes
 * exactly what the fixed add path writes for that revision (`accountFoodPer100g`): the measured
 * codes only, `energy_kcal_calc` under its own code. Log entries already written keep their
 * snapshots (history is never rewritten).
 *
 * Writes go through `apply_sync_op` as a `user_foods` update at the row's read revision (the path
 * the phone's own food edit uses), so a row changed meanwhile is refused, not overwritten, and every
 * device pulls the repair through the sync feed. The write guard is the one
 * `scripts/food-membership-audit.ts` uses.
 */
import { fileURLToPath } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ACCOUNT_FOOD_CODES, accountFoodKcalPer100g, accountFoodPer100g, type AccountFoodPer100g,
} from "@/lib/catalog/account-food-nutrients";
import { adminClient } from "@/lib/server/admin";
import { assertWriteTarget } from "./food-membership-audit";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHUNK = 200;
/** One PostgREST page. Below the project's max-rows cap (1000), so a short page means the end. */
export const PAGE = 500;

export type Args = { userId?: string; fix: boolean; production: boolean };

export type FoodRow = {
  id: string; user_id: string; name: string; kind: string; brand: string | null;
  ingredients_text: string | null; catalog_food_id: number; per_100g: Record<string, unknown> | null;
  allergen_tags: string[] | null; rev: number;
};
/** catalog_food_id → the active revision's per-100 g amounts by code. */
export type CatalogEnergy = Map<number, Record<string, number | null>>;
export type EnergyFix = { row: FoodRow; per100g: AccountFoodPer100g; kcalPer100g: number };
export type EnergySkip = { row: FoodRow; reason: "no_active_revision" | "catalog_has_no_energy" };

export function parseArgs(argv: readonly string[]): Args {
  let userId: string | undefined;
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--user-id") {
      const value = argv[i + 1];
      if (value === undefined || !UUID.test(value)) throw new Error("--user-id needs a uuid");
      userId = value;
      i += 1;
    } else if (arg === "--fix" || arg === "--production") flags.add(arg);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return { userId, fix: flags.has("--fix"), production: flags.has("--production") };
}

/** A stored `energy_kcal` of exactly 0 (a JSON number), the A154 signature. */
function storedZeroEnergy(row: FoodRow): boolean {
  return row.per_100g?.energy_kcal === 0;
}

/** Which rows to repair, and which zero-energy rows cannot be repaired from the catalog. Pure. */
export function planEnergyFixes(
  rows: readonly FoodRow[], catalog: CatalogEnergy,
): { fixes: EnergyFix[]; skipped: EnergySkip[] } {
  const fixes: EnergyFix[] = [];
  const skipped: EnergySkip[] = [];
  for (const row of rows) {
    if (!storedZeroEnergy(row)) continue;
    const amounts = catalog.get(row.catalog_food_id);
    if (!amounts) { skipped.push({ row, reason: "no_active_revision" }); continue; }
    const per100g = accountFoodPer100g(Object.fromEntries(
      Object.entries(amounts).map(([code, amount]) => [code, { amount }])));
    const kcalPer100g = accountFoodKcalPer100g(per100g);
    // A catalog food that itself measures 0 kcal (or none) is not this defect.
    if (kcalPer100g === null || kcalPer100g <= 0) {
      skipped.push({ row, reason: "catalog_has_no_energy" });
      continue;
    }
    fixes.push({ row, per100g, kcalPer100g });
  }
  return { fixes, skipped };
}

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

/** Every live catalog-linked custom food, page by page in a stable order until a short page. */
export async function loadFoodRows(admin: SupabaseClient, userId?: string): Promise<FoodRow[]> {
  const rows: FoodRow[] = [];
  for (let from = 0; ; from += PAGE) {
    let query = admin.from("user_foods")
      .select("id,user_id,name,kind,brand,ingredients_text,catalog_food_id,per_100g,allergen_tags,rev")
      .eq("kind", "custom").not("catalog_food_id", "is", null).is("deleted_at", null);
    if (userId) query = query.eq("user_id", userId);
    const page = await query.order("id").range(from, from + PAGE - 1);
    if (page.error) throw new Error(`user_foods read failed: ${page.error.message}`);
    const data = (page.data ?? []) as FoodRow[];
    rows.push(...data);
    if (data.length < PAGE) return rows;
  }
}

/** The active revision's amounts for each catalog food the zero-energy rows link to. */
export async function loadCatalogEnergy(
  admin: SupabaseClient, rows: readonly FoodRow[],
): Promise<CatalogEnergy> {
  const foodIds = [...new Set(rows.filter(storedZeroEnergy).map((row) => row.catalog_food_id))];
  const revisionFood = new Map<number, number>();
  for (const ids of chunks(foodIds)) {
    const read = await admin.from("catalog_food_revisions").select("id,catalog_food_id")
      .in("catalog_food_id", ids).eq("is_active", true);
    if (read.error) throw new Error(`catalog_food_revisions read failed: ${read.error.message}`);
    for (const rev of read.data ?? []) revisionFood.set(rev.id as number, rev.catalog_food_id as number);
  }
  const out: CatalogEnergy = new Map([...revisionFood.values()].map((id) => [id, {}]));
  for (const ids of chunks([...revisionFood.keys()])) {
    const read = await admin.from("catalog_food_nutrients")
      .select("food_revision_id,nutrient_code,amount_per_100g")
      .in("food_revision_id", ids).in("nutrient_code", [...ACCOUNT_FOOD_CODES]);
    if (read.error) throw new Error(`catalog_food_nutrients read failed: ${read.error.message}`);
    for (const n of read.data ?? []) {
      const food = revisionFood.get(n.food_revision_id as number);
      if (food === undefined) continue;
      const amount = n.amount_per_100g;
      (out.get(food) as Record<string, number | null>)[n.nutrient_code as string] =
        typeof amount === "number" ? amount : amount === null ? null : Number(amount);
    }
  }
  return out;
}

/** One sync op per row, at its read revision: a row changed since the read is refused, not overwritten. */
export async function applyEnergyFixes(admin: SupabaseClient, fixes: readonly EnergyFix[]): Promise<void> {
  for (const { row, per100g } of fixes) {
    const { rev, ...payload } = row;
    const { data, error } = await admin.rpc("apply_sync_op", {
      p_user_id: row.user_id,
      p_op: { op_id: crypto.randomUUID(), entity: "user_foods", entity_id: row.id, kind: "update",
        base_rev: rev, client_ts: new Date().toISOString(), payload: { ...payload, per_100g: per100g } },
    });
    const status = (data as { status?: string } | null)?.status;
    if (error || status !== "applied") {
      throw new Error(`energy repair refused for ${row.user_id}/${row.id}: ${error?.message ?? status ?? "no answer"}`);
    }
  }
}

function print(plan: { fixes: EnergyFix[]; skipped: EnergySkip[] }, rows: number): void {
  for (const fix of plan.fixes) {
    console.log(JSON.stringify({ userId: fix.row.user_id, foodId: fix.row.id, name: fix.row.name,
      catalogFoodId: fix.row.catalog_food_id, stored: fix.row.per_100g, repaired: fix.per100g }));
  }
  for (const skip of plan.skipped) {
    console.log(JSON.stringify({ userId: skip.row.user_id, foodId: skip.row.id, name: skip.row.name,
      catalogFoodId: skip.row.catalog_food_id, skipped: skip.reason }));
  }
  console.log(`catalog-linked foods checked: ${rows}, zero-energy to repair: ${plan.fixes.length}, `
    + `skipped: ${plan.skipped.length}`);
}

async function plan(admin: SupabaseClient, userId?: string) {
  const rows = await loadFoodRows(admin, userId);
  return { rows, plan: planEnergyFixes(rows, await loadCatalogEnergy(admin, rows)) };
}

export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  // Before any client exists: a refused run opens no connection at all.
  assertWriteTarget(argv.filter((arg) => arg === "--fix" || arg === "--production"),
    process.env.SUPABASE_URL ?? process.env.SUPABASE_TEST_URL);
  const admin = adminClient();
  const before = await plan(admin, args.userId);
  print(before.plan, before.rows.length);
  if (!args.fix) {
    if (before.plan.fixes.length) console.log("read-only: pass --fix (and --production on production) to repair");
    return;
  }
  await applyEnergyFixes(admin, before.plan.fixes);
  const after = await plan(admin, args.userId);
  if (after.plan.fixes.length) throw new Error(`after repair ${after.plan.fixes.length} rows still store 0 kcal`);
  console.log(`repaired: ${before.plan.fixes.length}; verified: 0 repairable rows remain`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
