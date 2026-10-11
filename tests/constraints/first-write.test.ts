// W007 (audit 2026-10-10 A119): the first `constraint_profiles` write is conditional. Two writers
// that both read "no row" (rev 0) used to upsert in turn, and the second silently replaced the
// first (an allergen could be lost). The first row is now an INSERT; the loser of the race gets
// the ordinary conflict answer with the row that won.
import { describe, expect, it } from "vitest";
import { putProfile } from "@/lib/server/constraints";

type Row = Record<string, unknown>;

/** One shared table: reads see what the other writer committed; insert refuses a second row. */
function table() {
  const state: { row: Row | null; reads: number; held: Row | null } = { row: null, reads: 0, held: null };
  const client = (stale: boolean) => ({
    from() {
      const chain = {
        select: () => chain, eq: () => chain,
        maybeSingle: async () => {
          state.reads += 1;
          // A stale writer read before the other one committed: it saw no row.
          return { data: stale && state.reads <= 1 ? null : state.row, error: null };
        },
        upsert(next: Row) { state.row = next; return after(); },
        insert(next: Row) {
          if (state.row) return after({ code: "23505", message: "duplicate key" });
          state.row = next;
          return after();
        },
        update(next: Row) { state.row = { ...state.row, ...next }; return after(); },
      };
      const after = (error: Row | null = null) => {
        const done = { select: () => done, eq: () => done,
          maybeSingle: async () => ({ data: error ? null : state.row, error }) };
        return done;
      };
      return chain;
    },
  }) as never;
  return { state, client };
}

describe("the first constraint_profiles write", () => {
  it("answers conflict, not ok, to the second writer at rev 0, and keeps the first row", async () => {
    const { state, client } = table();
    const first = await putProfile(client(false), "u1", { baseRev: 0, avoidAllergens: ["peanut"] });
    expect(first.status).toBe("ok");
    // The second writer read rev 0 before the first committed.
    state.reads = 0;
    const second = await putProfile(client(true), "u1", { baseRev: 0, conditions: ["Pregnant"] });
    expect(second).toMatchObject({ status: "conflict", current_rev: 1 });
    expect(state.row).toMatchObject({ avoid_allergens: ["peanut"], rev: 1 });
  });
});
