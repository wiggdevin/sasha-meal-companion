/**
 * W004 (audit 2026-10-10, A154): scripts/catalog-food-energy-backfill.ts repairs catalog-linked
 * account foods the old add path stored with `energy_kcal: 0`. Read-only by default; a write is a
 * sync op at the row's own revision; production needs --fix --production (the shared guard).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ adminClient: vi.fn() }));
vi.mock("@/lib/server/admin", () => ({ adminClient: () => mocks.adminClient() }));

const { main, parseArgs, planEnergyFixes, applyEnergyFixes } =
  await import("@/scripts/catalog-food-energy-backfill");
type FoodRow = import("@/scripts/catalog-food-energy-backfill").FoodRow;

const OWNER = "00f069d2-0000-4000-8000-000000000000";
const row = (id: string, catalogFoodId: number, per100: Record<string, unknown>, rev = 2): FoodRow => ({
  id, user_id: OWNER, name: `Food ${id}`, kind: "custom", brand: null, ingredients_text: null,
  catalog_food_id: catalogFoodId, per_100g: per100, allergen_tags: [], rev,
});

const ROWS = [
  // The A154 signature: a Foundation chicken breast with calc-only energy, stored as 0 kcal.
  row("chicken", 1, { energy_kcal: 0, protein: 22.5, carbohydrate: 0, fat_total: 2.6 }),
  // Stored right: untouched.
  row("apple", 2, { energy_kcal: 52, protein: 0.3, carbohydrate: 13.8, fat_total: 0.2 }),
  // A real zero-calorie catalog food: not this defect.
  row("water", 3, { energy_kcal: 0, protein: 0, carbohydrate: 0, fat_total: 0 }),
  // Its catalog food has no active revision any more: reported, not guessed.
  row("gone", 4, { energy_kcal: 0, protein: 0, carbohydrate: 0, fat_total: 0 }),
];
const CATALOG = new Map<number, Record<string, number | null>>([
  [1, { energy_kcal_calc: 120, protein: 22.5, carbohydrate: null, fat_total: 2.6 }],
  [2, { energy_kcal: 52, protein: 0.3, carbohydrate: 13.8, fat_total: 0.2 }],
  [3, { energy_kcal: 0, protein: 0, carbohydrate: 0, fat_total: 0 }],
]);

afterEach(() => { vi.unstubAllEnvs(); mocks.adminClient.mockReset(); });

describe("catalog-food-energy-backfill", () => {
  it("repairs only stored-0 rows whose catalog food has energy, to the measured codes alone", () => {
    const { fixes, skipped } = planEnergyFixes(ROWS, CATALOG);
    expect(fixes.map((fix) => [fix.row.id, fix.per100g, fix.kcalPer100g])).toEqual([
      ["chicken", { energy_kcal_calc: 120, protein: 22.5, fat_total: 2.6 }, 120],
    ]);
    expect(skipped.map((skip) => [skip.row.id, skip.reason])).toEqual([
      ["water", "catalog_has_no_energy"], ["gone", "no_active_revision"],
    ]);
  });

  it("parses its flags and refuses unknown ones", () => {
    expect(parseArgs([])).toEqual({ userId: undefined, fix: false, production: false });
    expect(parseArgs(["--user-id", OWNER, "--fix", "--production"]))
      .toEqual({ userId: OWNER, fix: true, production: true });
    expect(() => parseArgs(["--user-id", "nope"])).toThrow(/uuid/);
    expect(() => parseArgs(["--force"])).toThrow(/unknown/);
  });

  it("refuses to write production without --production, before opening a client", async () => {
    vi.stubEnv("SUPABASE_URL", "https://fivatgdpuenszxxnijpc.supabase.co");
    await expect(main(["--fix"])).rejects.toThrow(/without --production/);
    expect(mocks.adminClient).not.toHaveBeenCalled();
  });

  it("writes each repair as a user_foods sync op at the row's own revision", async () => {
    const rpc = vi.fn(async () => ({ data: { status: "applied", rev: 3 }, error: null }));
    await applyEnergyFixes({ rpc } as never, planEnergyFixes(ROWS, CATALOG).fixes);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("apply_sync_op", { p_user_id: OWNER, p_op: expect.objectContaining({
      entity: "user_foods", entity_id: "chicken", kind: "update", base_rev: 2,
      payload: expect.objectContaining({ name: "Food chicken", catalog_food_id: 1, kind: "custom",
        per_100g: { energy_kcal_calc: 120, protein: 22.5, fat_total: 2.6 } }),
    }) });
  });

  it("stops on a refused write rather than overwrite a row changed since the read", async () => {
    const rpc = vi.fn(async () => ({ data: { status: "conflict" }, error: null }));
    await expect(applyEnergyFixes({ rpc } as never, planEnergyFixes(ROWS, CATALOG).fixes))
      .rejects.toThrow(/refused/);
  });
});
