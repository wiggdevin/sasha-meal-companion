/**
 * A small PostgREST double for the Phase 17 O2 server reads and the occasion stamp: table data in
 * memory, the filters PostgREST applies (eq, in, is, not-is-null, gt, gte, lte), updates, and a log of
 * every query so a test can prove the explicit `user_id` filter was sent. It does not model RLS:
 * the tests check the explicit filter, which is the part this code owns.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;
export type QueryLog = { table: string; op: "select" | "update" | "upsert"; filters: string[] };

export function fakeDb(tables: Record<string, Row[]>,
  rpc: (name: string, args: Record<string, unknown>) => unknown = () => null) {
  const queries: QueryLog[] = [];
  const from = (table: string) => {
    const filters: Filter[] = [];
    const named: string[] = [];
    let patch: Row | null = null;
    let upserted: { rows: Row[]; keys: string[] } | null = null;
    const sorts: { column: string; ascending: boolean }[] = [];
    const rows = () => (tables[table] ?? []).filter((row) => filters.every((f) => f(row)));
    const add = (name: string, f: Filter) => { named.push(name); filters.push(f); return builder; };
    const run = () => {
      queries.push({ table, op: upserted ? "upsert" : patch ? "update" : "select", filters: named });
      if (upserted) {
        const list = (tables[table] ??= []);
        for (const row of upserted.rows) {
          const keys = upserted.keys;
          const hit = list.find((old) => keys.every((key) => old[key] === row[key]));
          if (hit) Object.assign(hit, row);
          else list.push({ ...row });
        }
        return { data: upserted.rows.map((row) => ({ ...row })), error: null };
      }
      if (patch) {
        const hit = rows();
        for (const row of hit) Object.assign(row, patch);
        return { data: hit, error: null };
      }
      const sorted = [...rows()].sort((a, b) => {
        for (const { column, ascending } of sorts) {
          const x = String(a[column]);
          const y = String(b[column]);
          if (x !== y) return (x < y ? -1 : 1) * (ascending ? 1 : -1);
        }
        return 0;
      });
      return { data: sorted.map((row) => ({ ...row })), error: null };
    };
    const builder: Record<string, unknown> = {
      select: () => builder,
      order: (column: string, opts?: { ascending?: boolean }) => {
        sorts.push({ column, ascending: opts?.ascending ?? true });
        return builder;
      },
      limit: () => builder,
      // Paged reads (lib/server/paged-read.ts): one page holds every row here, so pass through.
      range: () => builder,
      update: (values: Row) => { patch = values; return builder; },
      // Upsert on the conflict columns (`onConflict`, comma-separated), or on `user_id` by default.
      upsert: (values: Row | Row[], opts?: { onConflict?: string }) => {
        upserted = { rows: Array.isArray(values) ? values : [values],
          keys: (opts?.onConflict ?? "user_id").split(",").map((key) => key.trim()) };
        return builder;
      },
      eq: (column: string, value: unknown) => add(`eq:${column}`, (row) => row[column] === value),
      in: (column: string, values: unknown[]) => add(`in:${column}`, (row) => values.includes(row[column])),
      is: (column: string, value: null) => add(`is:${column}`, (row) => (row[column] ?? null) === value),
      not: (column: string, op: string, value: null) => add(`not:${column}`, (row) =>
        op === "is" ? (row[column] ?? null) !== value : true),
      gte: (column: string, value: string) => add(`gte:${column}`, (row) => String(row[column]) >= value),
      lte: (column: string, value: string) => add(`lte:${column}`, (row) => String(row[column]) <= value),
      // Timestamps compare as instants; a null never matches (SQL `null > x` is not true).
      gt: (column: string, value: string) => add(`gt:${column}`, (row) => row[column] != null
        && Date.parse(String(row[column])) > Date.parse(value)),
      maybeSingle: async () => {
        const { data } = run();
        return { data: data[0] ?? null, error: null };
      },
      then: (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) =>
        Promise.resolve(run()).then(resolve, reject),
    };
    return builder;
  };
  const client = { from, rpc: async (name: string, args: Record<string, unknown>) => {
    try {
      return { data: rpc(name, args), error: null };
    } catch (error) {
      return { data: null, error };
    }
  } } as unknown as SupabaseClient;
  return { client, tables, queries };
}
