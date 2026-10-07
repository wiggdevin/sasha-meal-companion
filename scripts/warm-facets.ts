/**
 * Resumable, service-role food-facet warmer.
 *
 *   pnpm exec tsx scripts/warm-facets.ts --dry-run --limit 5
 *   pnpm exec tsx scripts/warm-facets.ts --commit --user-id <uuid> [--include-user-foods]
 *
 * Writes require both `--commit` and an accounting user id (`--user-id`, FACET_WARM_USER_ID, or
 * SUPABASE_TEST_USER_ID) so System One's shared daily spend cap cannot be bypassed. Retryable cap,
 * provider, or write failures pause the cursor; permanently oversized foods are logged and skipped.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import type { SupabaseClient } from "@supabase/supabase-js";
import { catalogWarmFood, type CatalogWarmRow as CatalogRow, type FacetWarmFood }
  from "@/lib/foods/catalog-ingredients";
import type { EnsureFacetsResult } from "@/lib/foods/facet-warm";

const CHILD_ARG = "--facet-warmer-react-server-child";
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_CURSOR = join(homedir(), ".cache", "meal-companion", "warm-facets-cursor.json");

export type Cursor = {
  version: 1;
  catalogAfter: number;
  catalogDone: boolean;
  userFoodAfter: string;
  userFoodsDone: boolean;
};

export type Args = {
  commit: boolean;
  includeUserFoods: boolean;
  limit: number | null;
  pageSize: number;
  cursorPath: string;
  userId?: string;
};

type UserFoodRow = {
  id: string;
  user_id: string;
  name: string;
  brand: string | null;
  ingredients_text: string | null;
  rev: number;
};

const EMPTY_CURSOR: Cursor = { version: 1, catalogAfter: 0, catalogDone: false,
  userFoodAfter: "", userFoodsDone: false };

export function parseArgs(
  argv: string[], env: Readonly<Record<string, string | undefined>> = process.env,
): Args {
  const value = (flag: string) => {
    const at = argv.indexOf(flag);
    return at < 0 ? undefined : argv[at + 1];
  };
  const integer = (flag: string, fallback: number | null) => {
    const raw = value(flag);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} needs a positive integer`);
    return parsed;
  };
  return {
    commit: argv.includes("--commit") && !argv.includes("--dry-run"),
    includeUserFoods: argv.includes("--include-user-foods"),
    limit: integer("--limit", null),
    pageSize: integer("--page-size", DEFAULT_PAGE_SIZE) as number,
    cursorPath: value("--cursor") ?? DEFAULT_CURSOR,
    userId: value("--user-id") ?? env.FACET_WARM_USER_ID ?? env.SUPABASE_TEST_USER_ID,
  };
}

export function requireAccountingUser(args: Args): void {
  if (args.commit && !args.userId) {
    throw new Error("--commit requires --user-id, FACET_WARM_USER_ID, or SUPABASE_TEST_USER_ID");
  }
}

function readCursor(path: string): Cursor {
  if (!existsSync(path)) return { ...EMPTY_CURSOR };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Cursor>;
  if (parsed.version !== 1 || typeof parsed.catalogAfter !== "number"
    || typeof parsed.catalogDone !== "boolean" || typeof parsed.userFoodAfter !== "string"
    || typeof parsed.userFoodsDone !== "boolean") throw new Error(`invalid cursor: ${path}`);
  return parsed as Cursor;
}

function saveCursor(path: string, cursor: Cursor): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(cursor)}\n`, "utf8");
  renameSync(temporary, path);
}

async function catalogPage(admin: SupabaseClient, after: number, limit: number): Promise<CatalogRow[]> {
  const { data, error } = await admin.from("catalog_food_revisions")
    .select("id,description,brand,category,prep_state,catalog_ingredients(seq,name,raw_text),catalog_portions(seq,description,is_default)")
    .eq("is_active", true).gt("id", after).order("id", { ascending: true }).limit(limit);
  if (error) throw new Error(`catalog revision read failed: ${error.message}`);
  return (data ?? []) as unknown as CatalogRow[];
}

async function userFoodPage(admin: SupabaseClient, after: string, limit: number): Promise<UserFoodRow[]> {
  let query = admin.from("user_foods").select("id,user_id,name,brand,ingredients_text,rev")
    .is("deleted_at", null).order("id", { ascending: true }).limit(limit);
  if (after) query = query.gt("id", after);
  const { data, error } = await query;
  if (error) throw new Error(`user food read failed: ${error.message}`);
  return (data ?? []) as UserFoodRow[];
}

function userFoodInput(row: UserFoodRow): FacetWarmFood {
  return { identity: { kind: "user_food", id: row.id, rev: row.rev }, name: row.name,
    brand: row.brand, ingredientsText: row.ingredients_text, ownerUserId: row.user_id };
}

export type WarmFacetRunDeps = {
  admin: SupabaseClient;
  ensureFacets: (foods: readonly FacetWarmFood[], options: {
    admin: SupabaseClient; userId?: string; dryRun: boolean;
  }) => Promise<EnsureFacetsResult>;
  loadCatalogPage?: typeof catalogPage;
  loadUserFoodPage?: typeof userFoodPage;
  loadCursor?: typeof readCursor;
  persistCursor?: typeof saveCursor;
  log?: (message: string) => void;
  warn?: (message: string) => void;
};

export async function runWarmFacets(args: Args, deps: WarmFacetRunDeps) {
  requireAccountingUser(args);
  const loadCatalog = deps.loadCatalogPage ?? catalogPage;
  const loadUserFoods = deps.loadUserFoodPage ?? userFoodPage;
  const persist = deps.persistCursor ?? saveCursor;
  const log = deps.log ?? console.log;
  const warn = deps.warn ?? console.warn;
  const cursor = (deps.loadCursor ?? readCursor)(args.cursorPath);
  const totals = { judged: 0, skipped: 0, unknown: 0, writes: 0, foods: 0, errors: 0 };
  let batchNumber = 1;
  let remaining = args.limit;
  let paused = false;

  const consume = async (foods: FacetWarmFood[]) => {
    const result = await deps.ensureFacets(foods,
      { admin: deps.admin, userId: args.userId, dryRun: !args.commit });
    result.batches.forEach((batch, index) => log(
      `  batch ${batchNumber + index}: ${batch.foods} food(s), ${batch.questions} question(s), `
        + `${batch.estimatedTokens}/16000 estimated tokens`,
    ));
    batchNumber += result.batches.length;
    for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] += result[key];
    return result;
  };

  while (!cursor.catalogDone && (remaining === null || remaining > 0)) {
    const requested = Math.min(args.pageSize, remaining ?? args.pageSize);
    const rows = await loadCatalog(deps.admin, cursor.catalogAfter, requested);
    if (rows.length === 0) { cursor.catalogDone = true; break; }
    const result = await consume(rows.map(catalogWarmFood));
    for (const item of result.nonRetryable) {
      warn(`  skipped ${item.foodKey}: oversized (${item.unknown} unknown facet(s))`);
    }
    if (args.commit && result.retryableUnknown > 0) { paused = true; break; }
    cursor.catalogAfter = rows.at(-1)?.id ?? cursor.catalogAfter;
    if (args.commit) persist(args.cursorPath, cursor);
    if (remaining !== null) remaining -= rows.length;
    if (rows.length < requested) cursor.catalogDone = true;
  }

  if (args.includeUserFoods && cursor.catalogDone && !cursor.userFoodsDone
    && (remaining === null || remaining > 0)) {
    while (!cursor.userFoodsDone && (remaining === null || remaining > 0)) {
      const requested = Math.min(args.pageSize, remaining ?? args.pageSize);
      const rows = await loadUserFoods(deps.admin, cursor.userFoodAfter, requested);
      if (rows.length === 0) { cursor.userFoodsDone = true; break; }
      const result = await consume(rows.map(userFoodInput));
      for (const item of result.nonRetryable) {
        warn(`  skipped ${item.foodKey}: oversized (${item.unknown} unknown facet(s))`);
      }
      if (args.commit && result.retryableUnknown > 0) { paused = true; break; }
      cursor.userFoodAfter = rows.at(-1)?.id ?? cursor.userFoodAfter;
      if (args.commit) persist(args.cursorPath, cursor);
      if (remaining !== null) remaining -= rows.length;
      if (rows.length < requested) cursor.userFoodsDone = true;
    }
  }

  if (args.commit) persist(args.cursorPath, cursor);
  log(`${args.commit ? "warm" : "dry-run"} totals: ${totals.foods} food(s), `
    + `${totals.judged} judged, ${totals.skipped} skipped, ${totals.unknown} unknown, `
    + `${totals.writes} writes, ${totals.errors} error(s)`);
  if (!args.commit) log("dry run: 0 writes; cursor unchanged");
  else if (paused) log(`paused with retryable unknowns; resume from ${args.cursorPath}`);
  else if (totals.unknown > 0) {
    log("completed with non-retryable unknowns; cursor advanced past oversized foods");
  }
  return { cursor, totals, paused, batches: batchNumber - 1 };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2).filter((arg) => arg !== CHILD_ARG));
  requireAccountingUser(args);
  // Branch-first: the TEST names win when present; production needs an explicit --production.
  const [{ adminClientForCli }, { ensureFacets }] = await Promise.all([
    import("@/lib/server/admin"), import("@/lib/foods/facet-warm"),
  ]);
  await runWarmFacets(args, {
    admin: adminClientForCli({ production: process.argv.includes("--production") }), ensureFacets,
  });
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun && !process.argv.includes(CHILD_ARG)) {
  const child = spawnSync(process.execPath, [...process.execArgv, "--conditions=react-server",
    fileURLToPath(import.meta.url), CHILD_ARG, ...process.argv.slice(2)], {
    stdio: "inherit", env: process.env,
  });
  if (child.error) console.error(child.error.message);
  process.exitCode = child.status ?? 1;
} else if (isDirectRun) main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
