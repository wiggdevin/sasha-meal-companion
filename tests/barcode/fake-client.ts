/**
 * A hand-rolled PostgREST query-builder double. @testing-library and a Supabase mock library are
 * both absent by contract, and resolveBarcode only ever calls .from().select().eq()… .maybeSingle()
 * or awaits the builder, so this is the whole surface.
 */
import { vi } from "vitest";

export type TableRows = Record<string, Record<string, unknown>[]>;

type Filter = { column: string; value: unknown } | { column: string; values: unknown[] };

function matches(row: Record<string, unknown>, filters: Filter[]): boolean {
  return filters.every((f) =>
    "values" in f
      ? f.values.some((v) => String(row[f.column]) === String(v))
      : String(row[f.column]) === String(f.value)
  );
}

export function fakeClient(
  tables: TableRows,
  rpcResults: Record<string, unknown | ((args: unknown) => unknown)> = {}
) {
  const rpc = vi.fn(async (name: string, args?: unknown) => {
    const entry = rpcResults[name] ?? null;
    const data = typeof entry === "function" ? (entry as (args: unknown) => unknown)(args) : entry;
    return { data, error: null };
  });
  const upserts: { table: string; rows: unknown }[] = [];
  const from = vi.fn((table: string) => {
    const filters: Filter[] = [];
    const builder = {
      select: () => builder,
      order: () => builder,
      range: () => builder,
      limit: () => builder,
      eq(column: string, value: unknown) { filters.push({ column, value }); return builder; },
      in(column: string, values: unknown[]) {
        filters.push({ column, values });
        return builder;
      },
      upsert(rows: unknown) { upserts.push({ table, rows }); return Promise.resolve({ error: null }); },
      maybeSingle: async () => ({ data: (tables[table] ?? []).find((r) => matches(r, filters)) ?? null, error: null }),
      then(resolve: (v: { data: unknown[]; error: null }) => unknown) {
        return Promise.resolve({ data: (tables[table] ?? []).filter((r) => matches(r, filters)), error: null })
          .then(resolve);
      },
    };
    return builder;
  });
  return { client: { from, rpc } as never, from, rpc, upserts };
}
