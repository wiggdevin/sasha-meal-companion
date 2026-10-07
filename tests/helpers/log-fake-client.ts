/**
 * The fake Supabase client and request fixtures lib/server/log*.test.ts share: a hand-rolled
 * PostgREST double, no network. Split out of lib/server/log.test.ts so a second applyLogEntry
 * spec can reuse it without that file growing past the 400-line aim.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { vi } from "vitest";
import { NUTRIENT_CODES } from "@/lib/nutrients/codes";

export type Row = Record<string, unknown>;
type Filter = { column: string; value: unknown } | { column: string; values: unknown[] };

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((f) =>
    "values" in f
      ? f.values.some((v) => String(row[f.column]) === String(v))
      : String(row[f.column]) === String(f.value));
}

/**
 * A hand-rolled PostgREST query-builder double, table-data driven — the same shape as
 * tests/barcode/fake-client.ts, extended with insert() for saveLabelFood's write. Every query
 * applyLogEntry issues is `.select().eq()...` or `.select().in()...`, either awaited directly (a
 * thenable builder) or resolved through `.maybeSingle()`.
 */
export function fakeClient(opts: {
  tables?: Record<string, Row[]>;
  rpc?: Record<string, unknown | ((args: unknown) => unknown)>;
} = {}) {
  const tables = opts.tables ?? {};
  const rpcResults = opts.rpc ?? {};
  const inserted: { table: string; row: Row }[] = [];
  const rpc = vi.fn(async (name: string, args?: unknown) => {
    const entry = rpcResults[name];
    const data = typeof entry === "function" ? (entry as (a: unknown) => unknown)(args) : entry ?? null;
    return { data, error: null };
  });
  const from = vi.fn((table: string) => {
    const filters: Filter[] = [];
    const rows = () => tables[table] ?? [];
    const builder: Record<string, unknown> = {
      select: () => builder,
      order: () => builder,
      range: () => builder,
      limit: () => builder,
      like: () => builder,
      eq(column: string, value: unknown) { filters.push({ column, value }); return builder; },
      in(column: string, values: unknown[]) { filters.push({ column, values }); return builder; },
      maybeSingle: async () => ({ data: rows().find((r) => matches(r, filters)) ?? null, error: null }),
      insert: (row: Row) => {
        inserted.push({ table, row });
        return { select: () => ({ single: async () => ({ data: { id: `${table}-new` }, error: null }) }) };
      },
      then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve({ data: rows().filter((r) => matches(r, filters)), error: null }).then(resolve),
    };
    return builder;
  });
  return { client: { from, rpc } as unknown as SupabaseClient, inserted, rpc };
}

export const ITEM_ID = "10000000-0000-4000-8000-000000000001";
export const ENTRY_ID = "20000000-0000-4000-8000-000000000001";
export const REF_A = "30000000-0000-4000-8000-000000000001";
export const DRAFT_ID = "40000000-0000-4000-8000-000000000001";

export function req(items: Row[], over: Row = {}) {
  return { entry_id: ENTRY_ID, eaten_at: "2026-09-11T16:00:00.000Z", tz: "UTC",
    local_date: "2026-09-11", slot: "meal-1", method: "search", items, ...over };
}

export const PER_100G = Object.fromEntries(NUTRIENT_CODES.map((code) => [code, null])) as
  Record<string, number | null>;
