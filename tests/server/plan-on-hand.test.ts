// W024 (audit P03): a pantry row the user set to 0 g is used up, so "Use what I have" does not offer
// it. A row with an unknown amount (null) still counts, as it did.
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/recipe-access", () => ({ recipeAccessEnabled: () => true }));

const { readOnHand } = await import("@/lib/server/plan-on-hand");

type Row = Record<string, unknown>;
function fakeClient(tables: Record<string, Row[]>): SupabaseClient {
  return { from(table: string) {
    const builder: Record<string, unknown> = {};
    for (const name of ["select", "eq", "is", "gte", "lte", "in", "order"]) builder[name] = () => builder;
    builder.range = async () => ({ data: tables[table] ?? [], error: null });
    return builder;
  } } as unknown as SupabaseClient;
}

const pantry = (name: string, confirmed_grams: number | null) => ({ name, confirmed_grams,
  confirmed_at: "2026-10-05T12:00:00Z", source: "manual" });

describe("readOnHand pantry rows", () => {
  it("leaves out a 0 g row and keeps rows with stock or an unknown amount", async () => {
    const client = fakeClient({ shopping_pantry: [pantry("rice", 0), pantry("oats", 250),
      pantry("lentils", null)] });
    const entries = await readOnHand(client, "user-1", { date: "2026-10-06", zone: "UTC" });
    expect(entries.map((entry) => entry.name).sort()).toEqual(["lentils", "oats"]);
  });
});
