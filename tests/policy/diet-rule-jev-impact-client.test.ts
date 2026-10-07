/**
 * W2c r1: the impact report's read-only client refuses a write or rpc at any depth of a query
 * chain, not only on the builder `from()` returns.
 */
import { describe, expect, it } from "vitest";
import { readOnlyClient } from "@/scripts/diet-rule-jev-impact";

function fakeClient(calls: string[]) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "order", "range", "is", "maybeSingle",
    "insert", "update", "upsert", "delete", "rpc"]) {
    builder[method] = (..._args: unknown[]) => { calls.push(method); return builder; };
  }
  builder.then = (resolve: (value: unknown) => unknown) =>
    Promise.resolve({ data: [{ id: 1 }], error: null }).then(resolve);
  return { from: () => builder };
}

describe("readOnlyClient at any chain depth", () => {
  it.each(["insert", "update", "upsert", "delete", "rpc"])("refuses %s after select().eq()", (method) => {
    const calls: string[] = [];
    const db = readOnlyClient(fakeClient(calls) as never);
    const chain = db.from("user_food_prefs").select("food_ref_id").eq("user_id", "u") as never as
      Record<string, () => unknown>;
    expect(() => chain[method](), method).toThrow(/read-only/);
    const deeper = (db.from("t").select("x").eq("a", 1).order("a") as never as
      { range: (a: number, b: number) => Record<string, () => unknown> }).range(0, 9);
    expect(() => deeper[method](), method).toThrow(/read-only/);
    expect(calls).not.toContain(method);
  });

  it("still reads through the whole chain", async () => {
    const calls: string[] = [];
    const db = readOnlyClient(fakeClient(calls) as never);
    const result = await db.from("t").select("x").eq("a", 1).order("a").range(0, 9);
    expect(result).toEqual({ data: [{ id: 1 }], error: null });
    expect(calls).toEqual(["select", "eq", "order", "range"]);
  });
});
