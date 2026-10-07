/**
 * Read-only recipe coverage harness. For a fixed scenario set it runs the real account candidate
 * path (`loadRecipeCandidates`, the Coach/search boundary) against the configured database with a
 * client that refuses every write, and prints how many complete eligible recipes come back.
 *
 *   pnpm exec tsx --conditions=react-server scripts/recipe-coverage.ts --production \
 *     --user-id=<uuid> [--out=<file.json>]
 *
 * The no-rules row uses the same catalog search and candidate filter with an empty profile, so it
 * shows catalog reach without any account rules. No account data is written or printed beyond
 * counts, recipe names and exclusion reason codes.
 */
import { writeFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClientForCli } from "@/lib/server/admin";
import { recipeSearchFromWish } from "@/lib/coach/recipe-query";
import { searchCatalog } from "@/lib/recipe-catalog/repository";
import type { RecipeSearch } from "@/lib/recipe-catalog/types";
import { findRecipeCandidates } from "@/lib/recipes/candidates";
import { loadRecipeCandidates } from "@/lib/server/recipe-candidates";
import { loadEnvLocal } from "./load-env-local";

export const COVERAGE_QUERIES = ["chicken dinner", "easy breakfast", "salmon", "snack", "beef",
  "quick lunch"] as const;
export const COVERAGE_COACH_WISH = "Find me an easy chicken dinner recipe";

const WRITES = new Set(["insert", "upsert", "update", "delete"]);

/** Wrap a client so any write or RPC throws before a request is made. */
export function readOnlyClient(client: SupabaseClient): SupabaseClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "rpc") return () => { throw new Error("read-only harness: rpc refused"); };
      if (prop === "storage" || prop === "functions" || prop === "auth") {
        throw new Error(`read-only harness: ${prop} refused`);
      }
      // A schema-scoped client has its own from() and rpc(); wrap it the same way.
      if (prop === "schema") {
        return (name: string) => readOnlyClient(target.schema(name) as unknown as SupabaseClient);
      }
      if (prop === "from") {
        return (table: string) => new Proxy(target.from(table), {
          get(builder, key, rcv) {
            if (typeof key === "string" && WRITES.has(key)) {
              return () => { throw new Error(`read-only harness: ${key} on ${table} refused`); };
            }
            const value = Reflect.get(builder, key, rcv);
            return typeof value === "function" ? value.bind(builder) : value;
          },
        });
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/**
 * An account row carries counts and reason codes only: it never names a recipe, so a saved
 * report holds nothing about what one account can eat. Names appear only for the no-rules row.
 */
export type Row = { scenario: string; profile: "account" | "no-rules"; count: number;
  names?: string[]; reasons: string[] };

/** Stable codes for the shared no-result summaries (lib/recipes/candidates.ts). */
export function reasonCodes(messages: readonly string[]): string[] {
  return messages.map((message) => /Avoid list or food rules/.test(message) ? "rules_conflict"
    : /preference or restriction evidence/.test(message) ? "evidence_missing"
      : /requested dish, cuisine, time, and effort/.test(message) ? "no_dish_match"
        : /not available for these filters/.test(message) ? "filters_exhausted" : "other");
}

async function account(client: SupabaseClient, userId: string, label: string,
  search: RecipeSearch): Promise<Row> {
  const result = await loadRecipeCandidates(client, userId, search);
  return { scenario: label, profile: "account", count: result.candidates.length,
    reasons: reasonCodes(result.noResultReasons) };
}

async function noRules(client: SupabaseClient, label: string, search: RecipeSearch): Promise<Row> {
  const recipes = await searchCatalog(client, search);
  const found = findRecipeCandidates(recipes, search, { profile: {
    avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [] } });
  return { scenario: label, profile: "no-rules", count: found.candidates.length,
    names: found.candidates.map((c) => c.name), reasons: reasonCodes(found.noResultReasons) };
}

/** One printed line; an account row never prints names, whatever the row object carries. */
export function formatRow(row: Row): string {
  const detail = row.profile === "no-rules" && row.count ? `  [${(row.names ?? []).join("; ")}]`
    : row.reasons.length ? `  (${row.reasons.join(", ")})` : "";
  return `${row.profile.padEnd(8)} ${String(row.count).padStart(3)}  ${row.scenario}${detail}`;
}

/** The saved report: account rows are reduced to counts and codes. */
export function reportRows(rows: readonly Row[]): Row[] {
  return rows.map((row) => row.profile === "account"
    ? { scenario: row.scenario, profile: row.profile, count: row.count, reasons: row.reasons }
    : row);
}

export async function runCoverage(client: SupabaseClient, userId: string): Promise<Row[]> {
  const rows: Row[] = [];
  const scenarios: { label: string; search: RecipeSearch }[] = COVERAGE_QUERIES.map((query) =>
    ({ label: `query:${query}`, search: { query, limit: 64 } }));
  scenarios.push({ label: `coach:${COVERAGE_COACH_WISH}`,
    search: recipeSearchFromWish(COVERAGE_COACH_WISH, 3).search });
  for (const { label, search } of scenarios) {
    rows.push(await account(client, userId, label, search));
    rows.push(await noRules(client, label, search));
  }
  return rows;
}

if (process.argv[1]?.endsWith("recipe-coverage.ts")) {
  loadEnvLocal();
  const args = process.argv.slice(2);
  const userId = args.find((arg) => arg.startsWith("--user-id="))?.slice(10);
  const out = args.find((arg) => arg.startsWith("--out="))?.slice(6);
  if (!userId) {
    process.stderr.write("Usage: [--production] --user-id=<uuid> [--out=file]\n");
    process.exit(1);
  }
  // Branch TEST names win; production needs the explicit flag (lib/server/admin.ts).
  const client = readOnlyClient(adminClientForCli({ production: args.includes("--production") }));
  runCoverage(client, userId).then((rows) => {
    for (const row of rows) process.stdout.write(`${formatRow(row)}\n`);
    if (out) {
      writeFileSync(out, `${JSON.stringify({ at: new Date().toISOString(), rows: reportRows(rows) }, null, 2)}\n`);
    }
  }).catch((error: unknown) => {
    process.stderr.write(`coverage failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
