import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ adminClient: vi.fn() }));
vi.mock("@/lib/server/admin", () => ({ adminClient: () => mocks.adminClient() }));

const { main, parseArgs, planRoleFixes, applyRoleFixes, loadPrefRows, PAGE } = await import("@/scripts/food-role-audit");

const OWNER = "00f069d2-0000-4000-8000-000000000000";
const row = (name: string, role: string | null, per100: Record<string, number>, rev = 3) => ({
  user_id: OWNER, food_ref_id: `ref-${name}`, status: "eats", role, no_cook: false, note: null, rev,
  name, per_100g: per100,
});

/** The owner's two production mismatches (read-only audit, 2026-10-04), and rows that are right. */
const ROWS = [
  row("Soup, beef", "carb", { protein: 3.3, carbohydrate: 4, fat_total: 2.1 }),
  row("Game meat, deer, raw", "fat", { protein: 23, carbohydrate: 0, fat_total: 2.4 }),
  row("Beef jerky", "protein", { protein: 33.2, carbohydrate: 11, fat_total: 25.6 }),
  row("Olive oil", "fat", { fat_total: 100 }),
  row("Honey", "carb", {}),
  row("Mystery stew", "protein", { protein: 1, carbohydrate: 6, fat_total: 1 }),
  row("Almonds", null, { protein: 21, carbohydrate: 22, fat_total: 50 }),
];

afterEach(() => { vi.unstubAllEnvs(); mocks.adminClient.mockReset(); });

describe("food-role-audit", () => {
  it("flags only confident name calls by default", () => {
    expect(planRoleFixes(ROWS).map((fix) => [fix.row.name, fix.from, fix.to])).toEqual([
      ["Soup, beef", "carb", "protein"],
      ["Game meat, deer, raw", "fat", "protein"],
    ]);
  });

  it("adds calorie-only calls when asked, and never touches a row with no stored role", () => {
    const fixes = planRoleFixes(ROWS, true);
    expect(fixes.map((fix) => fix.row.name)).toContain("Mystery stew");
    expect(fixes.find((fix) => fix.row.name === "Mystery stew")?.source).toBe("calories");
    expect(fixes.map((fix) => fix.row.name)).not.toContain("Almonds");
  });

  it("parses its flags and refuses unknown ones", () => {
    expect(parseArgs(["--user-id", OWNER, "--fix", "--production"]))
      .toEqual({ userId: OWNER, includeCalorieCalls: false, fix: true, production: true });
    expect(() => parseArgs(["--user-id", "nope"])).toThrow(/uuid/);
    expect(() => parseArgs(["--force"])).toThrow(/unknown/);
  });

  it("refuses to write production without --production, before opening a client", async () => {
    vi.stubEnv("SUPABASE_URL", "https://fivatgdpuenszxxnijpc.supabase.co");
    await expect(main(["--fix"])).rejects.toThrow(/without --production/);
    expect(mocks.adminClient).not.toHaveBeenCalled();
  });

  it("writes each repair as a sync op at the row's own revision", async () => {
    const rpc = vi.fn(async () => ({ data: { status: "applied", rev: 4 }, error: null }));
    await applyRoleFixes({ rpc } as never, planRoleFixes(ROWS));
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledWith("apply_sync_op", { p_user_id: OWNER, p_op: expect.objectContaining({
      entity: "user_food_prefs", entity_id: "ref-Soup, beef", kind: "update", base_rev: 3,
      payload: { food_ref_id: "ref-Soup, beef", status: "eats", role: "protein", no_cook: false, note: null },
    }) });
  });

  it("stops on a refused op rather than overwriting a row that changed", async () => {
    const rpc = vi.fn(async () => ({ data: { status: "conflict" }, error: null }));
    await expect(applyRoleFixes({ rpc } as never, planRoleFixes(ROWS))).rejects.toThrow(/refused/);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("reads the calorie rule from per_100g's own keys: carbohydrate and fat_total", () => {
    const dish = (per100: Record<string, number>) => row("Mystery casserole", "carb", per100);
    // 2 g protein, 5 g carbs, 9 g fat: fat brings the most calories.
    expect(planRoleFixes([dish({ protein: 2, carbohydrate: 5, fat_total: 9 })], true)
      .map((fix) => [fix.to, fix.source])).toEqual([["fat", "calories"]]);
    // "carbs" / "fat" are not per_100g keys; read as nothing, the stored role stands.
    expect(planRoleFixes([dish({ protein: 0, carbs: 5, fat: 9 })], true)).toEqual([]);
  });

  it("never repairs a crab apple into Protein", () => {
    expect(planRoleFixes([row("Crab apple", "carb", { protein: 0.4, carbohydrate: 20, fat_total: 0.3 })], true))
      .toEqual([]);
  });

  // 2026-10-04 audit (MAJOR 6): one unranged read stopped at PostgREST's row cap, so --fix repaired
  // only the first page and the verify pass, reading the same page, said 0 mismatches remained.
  describe("more than one page of rows", () => {
    const COUNT = 1200;
    const MAX_ROWS = 1000;
    type Row = Record<string, unknown>;
    function database() {
      const tables: Record<string, Row[]> = {
        user_food_prefs: Array.from({ length: COUNT }, (_, i) => ({ user_id: OWNER,
          food_ref_id: `ref-${String(i).padStart(4, "0")}`, status: i % 7 === 0 ? "avoid" : "eats",
          role: "carb", no_cook: false, note: null, rev: 1 })),
        food_refs: Array.from({ length: COUNT }, (_, i) => ({ id: `ref-${String(i).padStart(4, "0")}`,
          kind: "user", user_food_id: `food-${i}` })),
        user_foods: Array.from({ length: COUNT }, (_, i) => ({ id: `food-${i}`, name: `Soup, beef #${i}`,
          per_100g: { protein: 3.3, carbohydrate: 4, fat_total: 2.1 }, deleted_at: null })),
      };
      const ranges: [number, number][] = [];
      const from = (table: string) => {
        const filters: ((row: Row) => boolean)[] = [];
        let range: [number, number] | null = null;
        const builder = {
          select: () => builder,
          in: (col: string, values: unknown[]) => { filters.push((row) => values.includes(row[col])); return builder; },
          eq: (col: string, value: unknown) => { filters.push((row) => row[col] === value); return builder; },
          is: (col: string, value: unknown) => { filters.push((row) => (row[col] ?? null) === value); return builder; },
          order: () => builder,
          range: (start: number, end: number) => { range = [start, end]; ranges.push(range); return builder; },
          then: (resolve: (result: { data: Row[]; error: null }) => void) => {
            const rows = tables[table].filter((row) => filters.every((keep) => keep(row)));
            const [start, end] = range ?? [0, rows.length - 1];
            // PostgREST's max-rows cap applies to every response, ranged or not.
            resolve({ data: rows.slice(start, Math.min(end + 1, start + MAX_ROWS)).map((row) => ({ ...row })), error: null });
          },
        };
        return builder;
      };
      const rpc = vi.fn(async (_name: string, args: { p_op: { entity_id: string; base_rev: number;
        payload: { role: string } } }) => {
        const target = tables.user_food_prefs.find((row) => row.food_ref_id === args.p_op.entity_id)!;
        if (target.rev !== args.p_op.base_rev) return { data: { status: "conflict" }, error: null };
        target.role = args.p_op.payload.role;
        target.rev = (target.rev as number) + 1;
        return { data: { status: "applied", rev: target.rev }, error: null };
      });
      return { admin: { from, rpc }, tables, ranges, rpc };
    }

    it("reads every pref, page by page, until a short page", async () => {
      const db = database();
      const rows = await loadPrefRows(db.admin as never);
      expect(rows).toHaveLength(COUNT);
      expect(new Set(rows.map((row) => row.food_ref_id)).size).toBe(COUNT);
      expect(db.ranges).toEqual([[0, PAGE - 1], [PAGE, 2 * PAGE - 1], [2 * PAGE, 3 * PAGE - 1]]);
    });

    it("repairs and verifies every mismatch past the first page", async () => {
      const db = database();
      mocks.adminClient.mockReturnValue(db.admin);
      vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:54321");
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      await main(["--fix"]);
      expect(db.rpc).toHaveBeenCalledTimes(COUNT);
      expect(db.tables.user_food_prefs.every((row) => row.role === "protein")).toBe(true);
      expect(log).toHaveBeenCalledWith(`repaired: ${COUNT}; verified: 0 mismatches remain`);
      log.mockRestore();
    });
  });
});
