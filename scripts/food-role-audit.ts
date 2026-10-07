/**
 * Audit and repair stored macro groups (`user_food_prefs.role`) that disagree with the food-role
 * rule (lib/foods/role.ts) — the Eats list's protein / carbs / fats dot.
 *
 *   (no flag)                            read-only report, any project
 *   --user-id <uuid>                     limit to one account
 *   --include-calorie-calls              also report rows the rule decides only by calories
 *   --fix                                repair on a branch or local database
 *   --fix --production                   repair on production: a deliberate, owner-approved step
 *
 * Owner, 2026-10-04: "Make sure we don't have misplaced or miscategorized foods" ("Soup, beef"
 * showed the carbs dot). Stored roles came from the old add paths, which picked the largest macro
 * by grams and let a group's Add force its group on any food. By default only a confident NAME call
 * (meat, fish, egg → protein; oil, nut, seed → fat; fruit, grain, sweetener → carbs) is a mismatch;
 * a calorie-only call is reported with --include-calorie-calls and never written unless it is.
 *
 * Writes go through `apply_sync_op` (the path the phone's own group change uses), one row at a
 * time with its base revision, so a row changed meanwhile is refused, not overwritten, and every
 * device pulls the change through the normal sync feed. The write guard is the one
 * `scripts/food-membership-audit.ts` uses.
 */
import { fileURLToPath } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FoodRole } from "@/lib/foods";
import { judgeFoodRole, type RoleSource } from "@/lib/foods/role";
import { adminClient } from "@/lib/server/admin";
import { assertWriteTarget } from "./food-membership-audit";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHUNK = 200;
/** One PostgREST page. Below the project's max-rows cap (1000), so a short page means the end. */
export const PAGE = 500;

export type Args = { userId?: string; includeCalorieCalls: boolean; fix: boolean; production: boolean };

export type PrefRow = {
  user_id: string; food_ref_id: string; status: string; role: string | null;
  no_cook: boolean | null; note: string | null; rev: number;
};
export type RoleRow = PrefRow & { name: string; per_100g: Record<string, unknown> | null };
export type RoleFix = { row: RoleRow; from: string; to: FoodRole; source: RoleSource };

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
    } else if (arg === "--fix" || arg === "--production" || arg === "--include-calorie-calls") flags.add(arg);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return { userId, includeCalorieCalls: flags.has("--include-calorie-calls"), fix: flags.has("--fix"),
    production: flags.has("--production") };
}

function grams(per100: Record<string, unknown> | null, key: string): number {
  const value = Number(per100?.[key]);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Which stored roles the rule disagrees with. A row with no stored role is not a mismatch: the
 *  phone already applies the rule to it (lib/store.ts). Pure. */
export function planRoleFixes(rows: readonly RoleRow[], includeCalorieCalls = false): RoleFix[] {
  return rows.flatMap((row) => {
    if (row.role !== "protein" && row.role !== "carb" && row.role !== "fat") return [];
    const judged = judgeFoodRole(row.name, { protein: grams(row.per_100g, "protein"),
      carbs: grams(row.per_100g, "carbohydrate"), fat: grams(row.per_100g, "fat_total") });
    if (!judged || judged.role === row.role) return [];
    if (judged.source === "calories" && !includeCalorieCalls) return [];
    return [{ row, from: row.role, to: judged.role, source: judged.source }];
  });
}

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

/**
 * Every Eats and Avoid pref, page by page in a stable order until a short page. One unranged read
 * stops at PostgREST's row cap, so --fix would repair only the first page and the verify pass,
 * reading the same page, would report "0 mismatches remain" over rows it never saw (2026-10-04
 * audit, MAJOR 6).
 */
export async function loadPrefRows(admin: SupabaseClient, userId?: string): Promise<PrefRow[]> {
  const rows: PrefRow[] = [];
  for (let from = 0; ; from += PAGE) {
    let query = admin.from("user_food_prefs")
      .select("user_id,food_ref_id,status,role,no_cook,note,rev").in("status", ["eats", "avoid"]);
    if (userId) query = query.eq("user_id", userId);
    const page = await query.order("user_id").order("food_ref_id").range(from, from + PAGE - 1);
    if (page.error) throw new Error(`prefs read failed: ${page.error.message}`);
    const data = (page.data ?? []) as PrefRow[];
    rows.push(...data);
    if (data.length < PAGE) return rows;
  }
}

/** Eats and Avoid prefs on the account's own foods (user refs), with each food's name and per-100 g.
 *  The --fix pass and its verify pass both read through this one pager. */
export async function loadRoleRows(admin: SupabaseClient, userId?: string): Promise<RoleRow[]> {
  const prefRows = await loadPrefRows(admin, userId);
  const refFood = new Map<string, string>();
  for (const ids of chunks(prefRows.map((row) => row.food_ref_id))) {
    const refs = await admin.from("food_refs").select("id,kind,user_food_id").in("id", ids).eq("kind", "user");
    if (refs.error) throw new Error(`food_refs read failed: ${refs.error.message}`);
    for (const ref of refs.data ?? []) if (ref.user_food_id) refFood.set(ref.id as string, ref.user_food_id as string);
  }
  const foods = new Map<string, { name: string; per_100g: Record<string, unknown> | null }>();
  for (const ids of chunks([...new Set(refFood.values())])) {
    const read = await admin.from("user_foods").select("id,name,per_100g").in("id", ids).is("deleted_at", null);
    if (read.error) throw new Error(`user_foods read failed: ${read.error.message}`);
    for (const food of read.data ?? []) foods.set(food.id as string, food as { name: string; per_100g: null });
  }
  return prefRows.flatMap((row) => {
    const food = foods.get(refFood.get(row.food_ref_id) ?? "");
    return food ? [{ ...row, name: food.name, per_100g: food.per_100g }] : [];
  });
}

/** One sync op per row, at its read revision: a row changed since the read is refused, not overwritten. */
export async function applyRoleFixes(admin: SupabaseClient, fixes: readonly RoleFix[]): Promise<void> {
  for (const { row, to } of fixes) {
    const { data, error } = await admin.rpc("apply_sync_op", {
      p_user_id: row.user_id,
      p_op: { op_id: crypto.randomUUID(), entity: "user_food_prefs", entity_id: row.food_ref_id,
        kind: "update", base_rev: row.rev, client_ts: new Date().toISOString(),
        payload: { food_ref_id: row.food_ref_id, status: row.status, role: to,
          no_cook: row.no_cook ?? false, note: row.note ?? null } },
    });
    const status = (data as { status?: string } | null)?.status;
    if (error || status !== "applied") {
      throw new Error(`role repair refused for ${row.user_id}/${row.name}: ${error?.message ?? status ?? "no answer"}`);
    }
  }
}

function print(fixes: readonly RoleFix[], rows: number): void {
  for (const fix of fixes) {
    console.log(JSON.stringify({ userId: fix.row.user_id, name: fix.row.name, status: fix.row.status,
      stored: fix.from, rule: fix.to, by: fix.source }));
  }
  console.log(`food roles checked: ${rows}, mismatched: ${fixes.length}`);
}

export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  // Before any client exists: a refused run opens no connection at all.
  assertWriteTarget(argv.filter((arg) => arg === "--fix" || arg === "--production"),
    process.env.SUPABASE_URL ?? process.env.SUPABASE_TEST_URL);
  const admin = adminClient();
  const rows = await loadRoleRows(admin, args.userId);
  const fixes = planRoleFixes(rows, args.includeCalorieCalls);
  print(fixes, rows.length);
  if (!args.fix) {
    if (fixes.length) console.log("read-only: pass --fix (and --production on production) to repair");
    return;
  }
  await applyRoleFixes(admin, fixes);
  const after = planRoleFixes(await loadRoleRows(admin, args.userId), args.includeCalorieCalls);
  if (after.length) throw new Error(`after repair ${after.length} roles still disagree`);
  console.log(`repaired: ${fixes.length}; verified: 0 mismatches remain`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
