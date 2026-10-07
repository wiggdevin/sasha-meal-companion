/** Shared fakes for the role-advice tests on the Foods add path and the capture draft (t2c). */
import { vi } from "vitest";
import { MEAL_COMPONENT_ROLES } from "@/lib/coach/role-advice";

export type Row = Record<string, unknown>;

/** In-memory tables behind the four query shapes the advice reads use. */
export function fakeClient(tables: Record<string, Row[]>, opts: { failTable?: string } = {}) {
  const writes: string[] = [];
  const from = (table: string) => {
    const filters: [string, (value: unknown) => boolean][] = [];
    const result = () => opts.failTable === table
      ? { data: null, error: { message: "boom" } }
      : { data: (tables[table] ?? []).filter((row) =>
          filters.every(([key, ok]) => ok(row[key]))), error: null };
    const query: Record<string, unknown> = {
      select: () => query,
      eq: (key: string, value: unknown) => { filters.push([key, (v) => v === value]); return query; },
      in: (key: string, values: unknown[]) => {
        filters.push([key, (v) => values.includes(v)]); return query;
      },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve),
      upsert: () => { writes.push(table); return query; },
      update: () => { writes.push(table); return query; },
      insert: () => { writes.push(table); return query; },
    };
    return query;
  };
  const rpc = vi.fn(async (name: string) => { writes.push(`rpc:${name}`); return { data: null, error: null }; });
  return { client: { from, rpc } as never, writes, rpc };
}

export function choiceAnswer(choice: keyof typeof MEAL_COMPONENT_ROLES) {
  return { meal_component_role: { type: "choice" as const, choice, confidence: 0.9,
    probabilities: Object.fromEntries(Object.keys(MEAL_COMPONENT_ROLES)
      .map((key) => [key, key === choice ? 1 : 0])) } };
}

